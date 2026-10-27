// Таблицы участников, ежедневные снимки рейтинга, статистика и история операций.

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

// Все пользователи с местом. Общая таблица — по балансу; неделя и месяц — по сумме операций за период
// без бонуса за регистрацию. При равенстве выше тот, кто зарегистрировался раньше.
function rankedSql(since) {
  const filter = since === null ? "" : "AND t.created_at >= ?1 AND t.type != 'signup_bonus'";
  return (
    "WITH scores AS (" +
    "  SELECT u.id, u.created_at, COALESCE(SUM(t.amount), 0) AS score FROM users u " +
    `  LEFT JOIN transactions t ON t.user_id = u.id ${filter} GROUP BY u.id` +
    "), ranked AS (" +
    "  SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC, id ASC) AS rank FROM scores" +
    ") "
  );
}

const rowFields =
  "SELECT r.rank, r.score, u.id, u.username, u.first_name, u.last_name, u.nickname, u.photo_url";

function publicRow(row, previous) {
  return {
    rank: row.rank,
    id: row.id,
    name: displayName(row),
    photo_url: row.photo_url,
    score: row.score,
    // Положительное число — поднялся на столько мест, отрицательное — опустился
    change: previous == null ? null : previous - row.rank,
  };
}

export async function leaderboard(db, { period = "all", userId, limit = 100, ts = Math.floor(Date.now() / 1000) }) {
  if (!PERIODS.includes(period)) period = "all";
  const since = periodStart(period, ts);
  const params = since === null ? [] : [since];
  // Изменение места показываем только в общей таблице, сравнивая с последним снимком
  const select =
    period === "all"
      ? `${rankedSql(since)}${rowFields}, s.rank AS previous FROM ranked r JOIN users u ON u.id = r.id ` +
        "LEFT JOIN rank_snapshots s ON s.user_id = r.id AND s.day = (SELECT MAX(day) FROM rank_snapshots) "
      : `${rankedSql(since)}${rowFields}, NULL AS previous FROM ranked r JOIN users u ON u.id = r.id `;

  // Три запроса одним обращением к базе
  const [top, mine, total] = await db.batch([
    db.prepare(`${select} ORDER BY r.rank LIMIT ${Number(limit)}`).bind(...params),
    db.prepare(`${select} WHERE r.id = ${since === null ? "?1" : "?2"}`).bind(...params, userId),
    db.prepare("SELECT COUNT(*) AS n FROM users"),
  ]);
  const me = mine.results[0];
  return {
    period,
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
      "r.score AS balance, r.rank, " +
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
    balance: row.balance,
    registered_at: row.created_at,
    rank: row.rank,
    stats: { earned: row.earned, spent: row.spent },
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
  return { earned: row.earned, spent: row.spent };
}

// История операций: новые сверху, следующая страница — по id последней показанной операции
export async function history(db, userId, { before = null, limit = 30 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      // Для корректировок администратора подтягиваем причину из журнала действий администраторов
      "SELECT t.id, t.amount, t.type, t.created_at, a.reason FROM transactions t " +
      "LEFT JOIN audit_log a ON t.ref = 'audit:' || a.id " +
      "WHERE t.user_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?",
    )
    .bind(userId, cursor, size + 1)
    .all();
  const items = results.slice(0, size);
  return { items, next: results.length > size ? items[items.length - 1].id : null };
}
