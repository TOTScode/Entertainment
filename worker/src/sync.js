// Синхронизация матчей, коэффициентов и результатов по расписанию (Cron Trigger раз в 30 минут).
// Лимит OddsPapi — 250 запросов в месяц: результаты важнее коэффициентов, поэтому под них держим резерв.
// Если лимит закончился, коэффициенты перестают обновляться и через 30 часов приём прогнозов на матч закрывается.

import { cancelMatch, settleMatch } from "./predictions.js";
import { findFdMatch, footballData, oddsPapi, TOURNAMENTS } from "./providers.js";

export const RESULTS_RESERVE = 40; // запросов OddsPapi, которые не тратим на коэффициенты
const ODDS_EVERY = 20 * 3600; // коэффициенты турнира — не чаще раза в 20 часов
const ODDS_HORIZON = 3 * 86400; // ...и только если матч турнира в ближайшие 3 дня
const ODDS_DISCOVERY = 7 * 86400; // раз в неделю — в любом случае, чтобы узнать о новых матчах
const RESULT_AFTER = 2 * 3600; // результат ищем через 2 часа после начала
const OP_FIXTURES_EVERY = 3 * 3600; // список матчей ЛЕ/ЛК для результатов — не чаще раза в 3 часа
const MAX_RESULTS_PER_RUN = 10; // у D1 лимит запросов на один запуск; остальное — через 30 минут

async function getState(db, key) {
  const row = await db.prepare("SELECT value FROM api_state WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

const setState = (db, key, value, now) =>
  db
    .prepare("INSERT INTO api_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, JSON.stringify(value), now);

// Учёт запросов OddsPapi в рамках одного запуска
class Budget {
  constructor(quota) {
    this.left = quota ? quota.limit - quota.used : 0;
  }
  take(reserve = 0) {
    if (this.left - 1 < reserve) return false;
    this.left -= 1;
    return true;
  }
}

// Сохраняет матчи и коэффициенты турнира одним обращением к базе.
// Данные передаются одним JSON и разбираются в SQL (json_each): у D1 есть лимит запросов на один запуск.
export async function saveOdds(db, code, fixtures, now) {
  const matches = fixtures.map((f) => ({
    op: f.op_id, home: f.home, away: f.away, start: f.start_time,
    status: f.status === "live" ? "scheduled" : f.status, has_odds: f.odds.length > 0 ? 1 : 0,
  }));
  const odds = fixtures.flatMap((f) => f.odds.map((o) => ({ op: f.op_id, m: o.market, o: o.outcome, p: o.price })));
  const j = (field) => `json_extract(j.value, '$.${field}')`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO matches (tournament, home, away, start_time, status, op_id, odds_updated_at, updated_at) " +
        `SELECT ?1, ${j("home")}, ${j("away")}, ${j("start")}, ${j("status")}, ${j("op")}, ` +
        `CASE WHEN ${j("has_odds")} = 1 THEN ?2 END, ?2 FROM json_each(?3) j WHERE true ` +
        "ON CONFLICT(op_id) DO UPDATE SET home = excluded.home, away = excluded.away, start_time = excluded.start_time, " +
        // Перенос: новое время начала приходит вместе с коэффициентами; рассчитанные матчи не трогаем
        "status = CASE WHEN matches.settled_at IS NULL AND excluded.status IN ('scheduled', 'postponed') THEN excluded.status ELSE matches.status END, " +
        "odds_updated_at = COALESCE(excluded.odds_updated_at, matches.odds_updated_at), updated_at = excluded.updated_at",
      )
      .bind(code, now, JSON.stringify(matches)),
    db
      .prepare(
        "DELETE FROM odds WHERE match_id IN (SELECT m.id FROM matches m JOIN json_each(?1) j ON m.op_id = json_extract(j.value, '$.op') " +
        "WHERE json_extract(j.value, '$.has_odds') = 1)",
      )
      .bind(JSON.stringify(matches)),
    db
      .prepare(
        "INSERT INTO odds (match_id, market, outcome, price) " +
        `SELECT m.id, ${j("m")}, ${j("o")}, ${j("p")} FROM json_each(?1) j JOIN matches m ON m.op_id = ${j("op")}`,
      )
      .bind(JSON.stringify(odds)),
    setState(db, `odds:${code}`, now, now),
  ]);
}

async function syncResults(env, op, budget, now, log) {
  const db = env.DB;
  const { results: pending } = await db
    .prepare(
      "SELECT * FROM matches WHERE settled_at IS NULL AND status IN ('scheduled', 'postponed') AND start_time BETWEEN ? AND ? ORDER BY start_time",
    )
    .bind(now - 9 * 86400, now - RESULT_AFTER)
    .all();
  if (!pending.length) return;
  let processed = 0;

  for (const t of TOURNAMENTS) {
    const list = pending.filter((m) => m.tournament === t.code);
    if (!list.length) continue;
    const from = Math.max(list[0].start_time, now - 9 * 86400) - 86400;

    if (t.fd) {
      // АПЛ, Бундеслига, Ла Лига, ЛЧ — football-data.org
      if (!env.FOOTBALL_DATA_TOKEN) continue;
      const fd = await footballData(env.FOOTBALL_DATA_TOKEN).matches(t.fd, from, now + 86400);
      for (const m of list) {
        if (processed >= MAX_RESULTS_PER_RUN) return;
        const r = findFdMatch(m, fd);
        if (!r) continue;
        if (!m.fd_id) await db.prepare("UPDATE matches SET fd_id = ? WHERE id = ?").bind(r.fd_id, m.id).run().catch(() => {});
        if (await applyResult(db, m, r, now, log)) processed++;
      }
      continue;
    }

    // ЛЕ и ЛК — OddsPapi: список матчей с их статусами, затем счёт каждого сыгранного
    if (!op) continue;
    const last = (await getState(db, `results:${t.code}`)) || 0;
    if (now - last < OP_FIXTURES_EVERY || !budget.take()) continue;
    const fixtures = await op.fixtures(t.op, from, now + 86400);
    await setState(db, `results:${t.code}`, now, now).run();
    for (const m of list) {
      if (processed >= MAX_RESULTS_PER_RUN) return;
      const f = fixtures.find((x) => x.op_id === m.op_id);
      if (!f) continue;
      let score = null;
      if (f.status === "finished") {
        if (!budget.take()) break;
        score = await op.regularScore(f.op_id);
      }
      if (await applyResult(db, m, { ...f, score }, now, log)) processed++;
    }
  }
}

async function applyResult(db, m, r, now, log) {
  if (r.status === "finished" && r.score) {
    await settleMatch(db, m, r.score, now);
    log.push(`рассчитан ${m.home} — ${m.away} ${r.score.join(":")}`);
    return true;
  } else if (r.status === "cancelled") {
    await cancelMatch(db, m, now);
    log.push(`отменён ${m.home} — ${m.away}`);
    return true;
  } else if (r.status === "postponed") {
    // Перенос: прогнозы остаются, новое время придёт вместе с коэффициентами
    const future = r.start_time > now;
    await db
      .prepare("UPDATE matches SET status = ?, start_time = ?, updated_at = ? WHERE id = ?")
      .bind(future ? "scheduled" : "postponed", future ? r.start_time : m.start_time, now, m.id)
      .run();
    log.push(`перенесён ${m.home} — ${m.away}`);
    return true;
  }
  return false;
}

async function syncOdds(env, op, budget, now, log) {
  const db = env.DB;
  for (const t of TOURNAMENTS) {
    const last = (await getState(db, `odds:${t.code}`)) || 0;
    if (now - last < ODDS_EVERY) continue;
    const soon = await db
      .prepare("SELECT 1 FROM matches WHERE tournament = ? AND start_time BETWEEN ? AND ? AND settled_at IS NULL LIMIT 1")
      .bind(t.code, now, now + ODDS_HORIZON)
      .first();
    if (!soon && now - last < ODDS_DISCOVERY) continue;
    if (!budget.take(RESULTS_RESERVE)) {
      log.push(`лимит OddsPapi: коэффициенты ${t.code} не обновлены`);
      continue;
    }
    const fixtures = await op.odds(t.op);
    await saveOdds(db, t.code, fixtures, now);
    log.push(`коэффициенты ${t.code}: ${fixtures.length} матчей`);
  }
}

export async function sync(env, now = Math.floor(Date.now() / 1000)) {
  const log = [];
  const op = env.ODDSPAPI_KEY ? oddsPapi(env.ODDSPAPI_KEY) : null;
  const quota = op ? await op.quota().catch((e) => (log.push(String(e.message)), null)) : null;
  const budget = new Budget(quota);
  // Каждая часть независима: сбой одного источника не мешает другому
  await syncResults(env, op, budget, now, log).catch((e) => log.push(`результаты: ${e.message}`));
  if (op && quota) await syncOdds(env, op, budget, now, log).catch((e) => log.push(`коэффициенты: ${e.message}`));
  if (quota) log.push(`OddsPapi: осталось ${budget.left} из ${quota.limit}`);
  console.log(`sync: ${log.join("; ") || "без изменений"}`);
  return log;
}
