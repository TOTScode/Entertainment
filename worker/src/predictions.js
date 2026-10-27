// Прогнозы на матчи: приём, замена, отмена, расчёт и возвраты.
// Все суммы в базе — в 1/10000 BIST. Деньги движутся только через журнал операций:
// bet (−ставка), refund (+ставка), payout (+выплата), payout_reversal (−выплата при исправлении результата).

import { toBist, UNIT } from "./money.js";
import { TOURNAMENTS } from "./providers.js";

export const MARKETS = { "1x2": { commission: 7 }, score: { commission: 10 } };
export const MIN_STAKE = 1;
export const MAX_STAKE = 100;
export const COOLDOWN = 5 * 60; // секунд между действиями с одним прогнозом
export const ODDS_FRESH = 30 * 3600; // без свежих коэффициентов приём прогнозов закрыт
const PAST_DAYS = 3;
const AHEAD_DAYS = 14;

export class PredictionError extends Error {
  constructor(message, status = 409, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Выплата по формуле спецификации: ставка + ставка × (коэффициент − 1) × (1 − комиссия).
// Считается в целых числах: ставка кратна 1 BIST, коэффициент — с двумя знаками, поэтому результат точный.
export function payoutUnits(stake, price, commission) {
  const cents = Math.round(price * 100);
  return stake + Math.floor((stake * (cents - 100) * (100 - commission)) / 10000);
}

const PAYOUT_SQL = "stake + (stake * (CAST(ROUND(price * 100) AS INTEGER) - 100) * (100 - commission)) / 10000";

export const isOpen = (m, now) =>
  m.status === "scheduled" && m.start_time > now && m.odds_updated_at != null && m.odds_updated_at >= now - ODDS_FRESH;

const tournamentName = (code) => TOURNAMENTS.find((t) => t.code === code)?.name || code;

function publicPrediction(p, now) {
  const last = Math.max(p.created_at, p.updated_at || 0);
  return {
    id: p.id,
    match_id: p.match_id,
    market: p.market,
    outcome: p.outcome,
    stake: toBist(p.stake),
    price: p.price,
    commission: p.commission,
    status: p.status,
    payout: p.status === "active" ? toBist(payoutUnits(p.stake, p.price, p.commission)) : toBist(p.payout),
    created_at: p.created_at,
    settled_at: p.settled_at,
    // Когда можно будет снова изменить или отменить прогноз
    next_change_at: p.status === "active" ? Math.max(last + COOLDOWN, now) : null,
  };
}

function publicMatch(m, now) {
  return {
    id: m.id,
    tournament: m.tournament,
    tournament_name: tournamentName(m.tournament),
    home: m.home,
    away: m.away,
    start_time: m.start_time,
    status: m.status,
    score: m.home_score == null ? null : [m.home_score, m.away_score],
    open: isOpen(m, now),
  };
}

// Список матчей с коэффициентами на исход и моими прогнозами — одно обращение к базе
export async function listMatches(db, userId, { tournament = null, now }) {
  const from = now - PAST_DAYS * 86400;
  const to = now + AHEAD_DAYS * 86400;
  const t = TOURNAMENTS.some((x) => x.code === tournament) ? tournament : null;
  const where = `m.start_time BETWEEN ?1 AND ?2 ${t ? "AND m.tournament = ?3" : ""}`;
  const params = t ? [from, to, t] : [from, to];
  const [matches, odds, mine] = await db.batch([
    db.prepare(`SELECT m.* FROM matches m WHERE ${where} ORDER BY m.start_time, m.id`).bind(...params),
    db
      .prepare(
        `SELECT o.match_id, o.market, o.outcome, o.price FROM odds o JOIN matches m ON m.id = o.match_id ` +
        `WHERE ${where} AND o.market = '1x2' ` +
        // Для точного счёта в списке нужен только признак, что коэффициенты есть
        `UNION ALL SELECT o.match_id, 'score', NULL, NULL FROM odds o JOIN matches m ON m.id = o.match_id ` +
        `WHERE ${where} AND o.market = 'score' GROUP BY o.match_id`,
      )
      .bind(...params),
    db
      .prepare(
        `SELECT p.* FROM predictions p JOIN matches m ON m.id = p.match_id ` +
        `WHERE ${where} AND p.user_id = ?${params.length + 1} AND p.status NOT IN ('replaced', 'cancelled')`,
      )
      .bind(...params, userId),
  ]);
  const byMatch = new Map(matches.results.map((m) => [m.id, { ...publicMatch(m, now), odds: {}, has_score: false, my: [] }]));
  for (const o of odds.results) {
    const m = byMatch.get(o.match_id);
    if (!m) continue;
    if (o.market === "1x2") m.odds[o.outcome] = o.price;
    else m.has_score = true;
  }
  for (const p of mine.results) byMatch.get(p.match_id)?.my.push(publicPrediction(p, now));
  return { now, tournaments: TOURNAMENTS.map(({ code, name }) => ({ code, name })), matches: [...byMatch.values()] };
}

// Матч со всеми коэффициентами и моими прогнозами (включая время последнего действия)
export async function getMatch(db, userId, matchId, now) {
  const [match, odds, mine] = await db.batch([
    db.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId),
    db.prepare("SELECT market, outcome, price FROM odds WHERE match_id = ? ORDER BY market, price").bind(matchId),
    db
      .prepare("SELECT * FROM predictions WHERE match_id = ? AND user_id = ? AND status NOT IN ('replaced', 'cancelled') ORDER BY id")
      .bind(matchId, userId),
  ]);
  const m = match.results[0];
  if (!m) return null;
  const grouped = { "1x2": {}, score: {} };
  for (const o of odds.results) grouped[o.market][o.outcome] = o.price;
  return { now, ...publicMatch(m, now), odds: grouped, my: mine.results.map((p) => publicPrediction(p, now)) };
}

// Мои прогнозы: активные или рассчитанные, новые сверху
export async function myPredictions(db, userId, { scope = "active", before = null, now }) {
  const statuses = scope === "settled" ? "('won', 'lost', 'refunded')" : "('active')";
  const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      "SELECT p.*, m.tournament, m.home, m.away, m.start_time, m.status AS match_status, m.home_score, m.away_score, " +
      "m.odds_updated_at FROM predictions p JOIN matches m ON m.id = p.match_id " +
      `WHERE p.user_id = ? AND p.status IN ${statuses} AND p.id < ? ORDER BY p.id DESC LIMIT 31`,
    )
    .bind(userId, cursor)
    .all();
  const items = results.slice(0, 30).map((r) => ({
    ...publicPrediction(r, now),
    match: publicMatch({ ...r, id: r.match_id, status: r.match_status }, now),
  }));
  return { items, next: results.length > 30 ? items[items.length - 1].id : null };
}

function cooldownLeft(rows, market, now) {
  const last = rows.filter((p) => p.market === market).reduce((t, p) => Math.max(t, p.created_at, p.updated_at || 0), 0);
  return last ? last + COOLDOWN - now : 0;
}

function mapDbError(e) {
  const msg = String(e?.message);
  if (msg.includes("insufficient_balance")) return new PredictionError("Недостаточно BIST");
  if (msg.includes("match_closed")) return new PredictionError("Приём прогнозов на этот матч закрыт");
  if (msg.includes("UNIQUE")) return new PredictionError("Прогноз уже изменился, обновите экран");
  return e;
}

// Новый прогноз или замена действующего на этом рынке. Ставка — целое число BIST.
export async function placePrediction(db, userId, { match_id, market, outcome, stake }, now) {
  const matchId = Number(match_id);
  if (!MARKETS[market]) throw new PredictionError("Неизвестный тип прогноза", 400);
  const amount = Number(stake);
  if (!Number.isInteger(amount) || amount < MIN_STAKE || amount > MAX_STAKE) {
    throw new PredictionError(`Ставка — целое число от ${MIN_STAKE} до ${MAX_STAKE} BIST`, 400);
  }
  const [match, odd, rows] = await db.batch([
    db.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId),
    db.prepare("SELECT price FROM odds WHERE match_id = ? AND market = ? AND outcome = ?").bind(matchId, market, String(outcome)),
    db.prepare("SELECT * FROM predictions WHERE match_id = ? AND user_id = ? AND market = ?").bind(matchId, userId, market),
  ]);
  const m = match.results[0];
  if (!m) throw new PredictionError("Матч не найден", 404);
  if (!isOpen(m, now)) throw new PredictionError("Приём прогнозов на этот матч закрыт");
  const price = odd.results[0]?.price;
  if (!price) throw new PredictionError("Нет коэффициента на этот исход", 400);
  const wait = cooldownLeft(rows.results, market, now);
  if (wait > 0) throw new PredictionError(`Изменить прогноз можно через ${Math.ceil(wait / 60)} мин.`, 429, { retry_at: now + wait });

  const current = rows.results.find((p) => p.status === "active");
  const units = amount * UNIT;
  const statements = [];
  if (current) {
    statements.push(
      db.prepare("UPDATE predictions SET status = 'replaced', updated_at = ? WHERE id = ? AND status = 'active'").bind(now, current.id),
      db
        .prepare("INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, 'refund', ?, ?)")
        .bind(userId, current.stake, `prediction:${current.id}`, now),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, commission, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
      )
      .bind(userId, matchId, market, String(outcome), units, price, MARKETS[market].commission, now, now),
    db
      .prepare(
        "INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?1, ?2, 'bet', " +
        "'prediction:' || (SELECT id FROM predictions WHERE user_id = ?1 AND match_id = ?3 AND market = ?4 AND status = 'active'), ?5)",
      )
      .bind(userId, -units, matchId, market, now),
    db.prepare("SELECT * FROM predictions WHERE user_id = ? AND match_id = ? AND market = ? AND status = 'active'").bind(userId, matchId, market),
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE user_id = ?").bind(userId),
  );
  let results;
  try {
    results = await db.batch(statements);
  } catch (e) {
    throw mapDbError(e);
  }
  const [prediction, balance] = results.slice(-2).map((r) => r.results[0]);
  return { now, prediction: publicPrediction(prediction, now), balance: toBist(balance.balance), replaced: Boolean(current) };
}

export async function cancelPrediction(db, userId, predictionId, now) {
  const p = await db.prepare("SELECT * FROM predictions WHERE id = ? AND user_id = ?").bind(Number(predictionId), userId).first();
  if (!p || p.status !== "active") throw new PredictionError("Прогноз не найден или уже не действует", 404);
  const wait = Math.max(p.created_at, p.updated_at) + COOLDOWN - now;
  if (wait > 0) throw new PredictionError(`Отменить прогноз можно через ${Math.ceil(wait / 60)} мин.`, 429, { retry_at: now + wait });
  let results;
  try {
    results = await db.batch([
      db.prepare("UPDATE predictions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'").bind(now, p.id),
      db
        .prepare("INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, 'refund', ?, ?)")
        .bind(userId, p.stake, `prediction:${p.id}`, now),
      db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE user_id = ?").bind(userId),
    ]);
  } catch (e) {
    throw mapDbError(e);
  }
  return { balance: toBist(results[2].results[0].balance) };
}

// Запросы расчёта матча по счёту основного времени. version — номер расчёта (растёт при исправлениях).
function settleStatements(db, match, [home, away], now) {
  const v = match.settle_version + 1;
  const result = home > away ? "1" : home < away ? "2" : "X";
  const score = `${home}:${away}`;
  return [
    db
      .prepare(
        "UPDATE matches SET status = 'finished', home_score = ?, away_score = ?, settled_at = ?, settle_version = ?, updated_at = ? WHERE id = ?",
      )
      .bind(home, away, now, v, now, match.id),
    db
      .prepare(
        `UPDATE predictions SET status = CASE WHEN outcome = ?1 THEN 'won' ELSE 'lost' END, ` +
        `payout = CASE WHEN outcome = ?1 THEN ${PAYOUT_SQL} ELSE 0 END, settled_at = ?2, updated_at = ?2 ` +
        `WHERE match_id = ?3 AND status = 'active' AND market = '1x2'`,
      )
      .bind(result, now, match.id),
    db
      .prepare(
        `UPDATE predictions SET status = CASE WHEN outcome = ?1 THEN 'won' ELSE 'lost' END, ` +
        `payout = CASE WHEN outcome = ?1 THEN ${PAYOUT_SQL} ELSE 0 END, settled_at = ?2, updated_at = ?2 ` +
        `WHERE match_id = ?3 AND status = 'active' AND market = 'score'`,
      )
      .bind(score, now, match.id),
    db
      .prepare(
        "INSERT INTO transactions (user_id, amount, type, ref, created_at) " +
        "SELECT user_id, payout, 'payout', 'prediction:' || id || ':v' || ?1, ?2 FROM predictions " +
        "WHERE match_id = ?3 AND status = 'won' AND settled_at = ?2",
      )
      .bind(v, now, match.id),
  ];
}

// Расчёт сыгранного матча. Повторный вызов ничего не делает: матч уже рассчитан.
export async function settleMatch(db, match, score, now) {
  if (match.settled_at) return false;
  await db.batch(settleStatements(db, match, score, now));
  return true;
}

// Отмена матча: все действующие прогнозы возвращаются
export async function cancelMatch(db, match, now) {
  if (match.settled_at) return false;
  await db.batch([
    db.prepare("UPDATE matches SET status = 'cancelled', settled_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, match.id),
    db
      .prepare("UPDATE predictions SET status = 'refunded', payout = stake, settled_at = ?1, updated_at = ?1 WHERE match_id = ?2 AND status = 'active'")
      .bind(now, match.id),
    db
      .prepare(
        "INSERT INTO transactions (user_id, amount, type, ref, created_at) " +
        "SELECT user_id, stake, 'refund', 'prediction:' || id, ?1 FROM predictions WHERE match_id = ?2 AND status = 'refunded' AND settled_at = ?1",
      )
      .bind(now, match.id),
  ]);
  return true;
}

// Исправление результата администратором: выигрыши прошлого расчёта списываются, прогнозы рассчитываются заново
export function correctionStatements(db, match, score, now) {
  return [
    db
      .prepare(
        "INSERT INTO transactions (user_id, amount, type, ref, created_at) " +
        "SELECT user_id, -payout, 'payout_reversal', 'prediction:' || id || ':v' || ?1, ?2 FROM predictions " +
        "WHERE match_id = ?3 AND status = 'won' AND payout > 0",
      )
      .bind(match.settle_version, now, match.id),
    db
      .prepare("UPDATE predictions SET status = 'active', payout = NULL, settled_at = NULL WHERE match_id = ? AND status IN ('won', 'lost')")
      .bind(match.id),
    ...settleStatements(db, match, score, now),
  ];
}
