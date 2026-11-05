// Таблицы участников, ежедневные снимки рейтинга, статистика и история операций.

import { toBist } from "./money.js";
import { displayName } from "./users.js";

export const PERIODS = ["all", "week", "month"];
const MSK = 3 * 3600; // Москва: UTC+3 без перехода на летнее время
const KEEP_SNAPSHOT_DAYS = 40;

// Дата по Москве в виде YYYY-MM-DD
export function moscowDay(ts) {
  return new Date((ts + MSK) * 1000).toISOString().slice(0, 10);
}

// Начало периода (unix-время): неделя с понедельника 00:00 МСК, календарный месяц с 1-го числа 00:00 МСК
export function periodStart(period, ts) {
  const d = new Date((ts + MSK) * 1000);
  let start;
  if (period === "week") {
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  } else if (period === "month") {
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  } else {
    return null;
  }
  return start / 1000 - MSK;
}

// Все пользователи с местом. Сортировка по успешности, а не по BIST (решение от 5.11).
// По умолчанию (points) — по сумме очков: правильные ответы в викторинах + угаданные исходы матчей (без точного счёта).
// accuracy — зеркально: по доле угаданных исходов (только при 6 и более рассчитанных прогнозах), при равенстве — по ответам в викторинах.
// При равенстве выше тот, кто зарегистрировался раньше. Неделя и месяц считают только ответы и прогнозы за период.
export const SORTS = { points: "quiz + won DESC, quiz DESC", accuracy: "COALESCE(accuracy, -1) DESC, quiz DESC, won DESC" };
export const MIN_BETS = 6; // долю угаданных показываем, когда рассчитанных прогнозов на исход больше 5

function rankedSql(since, sort = "points") {
  const quizFilter = since === null ? "" : "AND a.answered_at >= ?1";
  const predFilter = since === null ? "" : "AND p.settled_at >= ?1";
  return (
    "WITH quiz AS (" +
    `  SELECT a.user_id, COUNT(*) AS n FROM quiz_answers a WHERE a.correct = 1 ${quizFilter} GROUP BY a.user_id` +
    "), pred AS (" +
    "  SELECT p.user_id, SUM(p.status = 'won') AS won, COUNT(*) AS bets FROM predictions p " +
    `  WHERE p.market = '1x2' AND p.status IN ('won', 'lost') ${predFilter} GROUP BY p.user_id` +
    "), scores AS (" +
    "  SELECT u.id, u.created_at, COALESCE(q.n, 0) AS quiz, COALESCE(p.won, 0) AS won, COALESCE(p.bets, 0) AS bets, " +
    `  CASE WHEN p.bets >= ${MIN_BETS} THEN CAST(p.won AS REAL) / p.bets END AS accuracy ` +
    "  FROM users u LEFT JOIN quiz q ON q.user_id = u.id LEFT JOIN pred p ON p.user_id = u.id" +
    "), ranked AS (" +
    "  SELECT id, quiz, won, bets, accuracy, ROW_NUMBER() OVER (" +
    `    ORDER BY ${SORTS[sort] || SORTS.points}, created_at ASC, id ASC) AS rank FROM scores` +
    ") "
  );
}

const rowFields =
  "SELECT r.rank, r.quiz, r.won, r.bets, r.accuracy, u.id, u.username, u.first_name, u.last_name, u.nickname, u.photo_url";

function publicRow(row, previous) {
  return {
    rank: row.rank,
    id: row.id,
    name: displayName(row),
    photo_url: row.photo_url,
    quiz: row.quiz,
    won: row.won,
    bets: row.bets,
    // Доля угаданных исходов в процентах; null, пока рассчитанных прогнозов на исход меньше 6
    accuracy: row.accuracy == null ? null : Math.round(row.accuracy * 100),
    // Положительное число — поднялся на столько мест, отрицательное — опустился
    change: previous == null ? null : previous - row.rank,
  };
}

export async function leaderboard(db, { period = "all", sort = "points", userId, limit = 100, ts = Math.floor(Date.now() / 1000) }) {
  if (!PERIODS.includes(period)) period = "all";
  if (!SORTS[sort]) sort = "points";
  const since = periodStart(period, ts);
  const params = since === null ? [] : [since];
  // Изменение места показываем только в общей таблице с основной сортировкой, сравнивая с последним снимком
  const select =
    period === "all" && sort === "points"
      ? `${rankedSql(since, sort)}${rowFields}, s.rank AS previous FROM ranked r JOIN users u ON u.id = r.id ` +
        "LEFT JOIN rank_snapshots s ON s.user_id = r.id AND s.day = (SELECT MAX(day) FROM rank_snapshots) "
      : `${rankedSql(since, sort)}${rowFields}, NULL AS previous FROM ranked r JOIN users u ON u.id = r.id `;

  // Три запроса одним обращением к базе
  const [top, mine, total] = await db.batch([
    db.prepare(`${select} ORDER BY r.rank LIMIT ${Number(limit)}`).bind(...params),
    db.prepare(`${select} WHERE r.id = ${since === null ? "?1" : "?2"}`).bind(...params, userId),
    db.prepare("SELECT COUNT(*) AS n FROM users"),
  ]);
  const me = mine.results[0];
  return {
    period,
    sort,
    since,
    total: total.results[0].n,
    rows: top.results.map((r) => publicRow(r, r.previous)),
    me: me ? publicRow(me, me.previous) : null,
  };
}

// Публичный профиль участника одним запросом к базе: данные, баланс, место, получено и потрачено
export async function publicProfile(db, userId) {
  const row = await db
    .prepare(
      `${rankedSql(null)}SELECT u.id, u.username, u.first_name, u.last_name, u.nickname, u.photo_url, u.created_at, ` +
      "(SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = u.id) AS balance, r.rank, r.quiz, r.won, r.bets, r.accuracy, " +
      "(SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) FROM transactions WHERE user_id = u.id) AS earned, " +
      "(SELECT COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) FROM transactions WHERE user_id = u.id) AS spent " +
      "FROM users u JOIN ranked r ON r.id = u.id WHERE u.id = ?1",
    )
    .bind(userId)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    name: displayName(row),
    username: row.username,
    photo_url: row.photo_url,
    balance: toBist(row.balance),
    registered_at: row.created_at,
    rank: row.rank,
    quiz: row.quiz,
    won: row.won,
    bets: row.bets,
    accuracy: row.accuracy == null ? null : Math.round(row.accuracy * 100),
    stats: { earned: toBist(row.earned), spent: toBist(row.spent) },
  };
}

// Снимок общего рейтинга на начало дня по Москве. Запускается по расписанию (Cron Trigger).
export async function takeSnapshot(db, ts = Math.floor(Date.now() / 1000)) {
  const day = moscowDay(ts);
  await db
    .prepare(`${rankedSql(null)}INSERT OR IGNORE INTO rank_snapshots (day, user_id, rank) SELECT ?1, id, rank FROM ranked`)
    .bind(day)
    .run();
  const oldest = moscowDay(ts - KEEP_SNAPSHOT_DAYS * 86400);
  await db.prepare("DELETE FROM rank_snapshots WHERE day < ?").bind(oldest).run();
  return day;
}

export async function userStats(db, userId) {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS earned, " +
      "COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS spent FROM transactions WHERE user_id = ?",
    )
    .bind(userId)
    .first();
  return { earned: toBist(row.earned), spent: toBist(row.spent) };
}

// История операций: новые сверху, следующая страница — по id последней показанной операции
export async function history(db, userId, { before = null, limit = 30 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      // Для корректировок администратора подтягиваем причину из журнала действий администраторов
      "SELECT t.id, t.amount, t.type, t.created_at, a.reason, " +
      "m.home || ' — ' || m.away AS match, p.market, p.outcome, qz.title AS quiz FROM transactions t " +
      "LEFT JOIN audit_log a ON t.ref = 'audit:' || a.id " +
      // Для операций по прогнозам — матч и исход (ref вида prediction:12 или prediction:12:v1)
      "LEFT JOIN predictions p ON t.ref LIKE 'prediction:%' AND p.id = CAST(substr(t.ref, 12) AS INTEGER) " +
      "LEFT JOIN matches m ON m.id = p.match_id " +
      // Для наград за викторины — название викторины (ref вида quiz_question:7)
      "LEFT JOIN quiz_questions qq ON t.type = 'quiz_reward' AND qq.id = CAST(substr(t.ref, 15) AS INTEGER) " +
      "LEFT JOIN quizzes qz ON qz.id = qq.quiz_id " +
      "WHERE t.user_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?",
    )
    .bind(userId, cursor, size + 1)
    .all();
  const items = results.slice(0, size).map((t) => ({ ...t, amount: toBist(t.amount) }));
  return { items, next: results.length > size ? items[items.length - 1].id : null };
}
