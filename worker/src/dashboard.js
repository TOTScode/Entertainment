// Дашборд для администраторов: экономика BIST, игроки, прогнозы и викторины за день, неделю и месяц (по Москве).
// Всё считается одним обращением к базе прямо по журналу операций, поэтому цифры совпадают с историей игроков.

import { toBist, UNIT } from "./money.js";
import { periodStart } from "./leaderboard.js";
import { nextMidnight, QUALIFY_BIST } from "./quizzes.js";

export const PERIODS = ["day", "week", "month"];

// Сумма по трём периодам: ?1 — начало дня, ?2 — недели, ?3 — месяца
const per = (col, expr) => PERIODS.map((p, i) => `SUM(CASE WHEN ${col} >= ?${i + 1} THEN ${expr} ELSE 0 END) AS ${p}`).join(", ");
const pick = (row, f = (x) => x) => Object.fromEntries(PERIODS.map((p) => [p, f(row?.[p] ?? 0)]));
const bist = (u) => Math.round(toBist(u) * 10) / 10;

export async function dashboard(db, now) {
  const since = [nextMidnight(now) - 86400, periodStart("week", now), periodStart("month", now)];
  const bind = (sql, ...extra) => db.prepare(sql).bind(...since, ...extra);
  const [types, users, active, balances, preds, open, quiz, queue] = await db.batch([
    bind(`SELECT type, ${per("created_at", "amount")}, ${per("created_at", "1").replace(/AS (\w+)/g, "AS n_$1")} FROM transactions GROUP BY type ORDER BY type`),
    bind(`SELECT COUNT(*) AS total, ${per("created_at", "1")} FROM users`),
    // Активный — сделал прогноз, открыл вопрос викторины или получил выплату (бонус за регистрацию и ручные корректировки не считаются)
    bind(
      "WITH acts AS (SELECT user_id, created_at AS t FROM transactions WHERE type NOT IN ('signup_bonus', 'admin_adjustment') " +
      "UNION ALL SELECT user_id, opened_at FROM quiz_answers) " +
      `SELECT ${PERIODS.map((p, i) => `COUNT(DISTINCT CASE WHEN t >= ?${i + 1} THEN user_id END) AS ${p}`).join(", ")} FROM acts WHERE t >= MIN(?1, ?2, ?3)`,
    ),
    // Распределение балансов: сколько прошли квалификацию и какая доля BIST у верхних 10% игроков
    bind(
      "WITH b AS (SELECT user_id, SUM(amount) AS bal FROM transactions GROUP BY user_id), " +
      "r AS (SELECT bal, ROW_NUMBER() OVER (ORDER BY bal DESC) AS n, COUNT(*) OVER () AS cnt FROM b) " +
      "SELECT COUNT(*) AS players, COALESCE(SUM(bal), 0) AS total, COALESCE(SUM(CASE WHEN bal >= ?4 THEN 1 ELSE 0 END), 0) AS qualified, " +
      "COALESCE(SUM(CASE WHEN n <= (cnt + 9) / 10 THEN bal ELSE 0 END), 0) AS top, MAX((cnt + 9) / 10) AS top_n FROM r " +
      "WHERE ?1 + ?2 + ?3 IS NOT NULL",
      QUALIFY_BIST * UNIT,
    ),
    // Прогнозы: сделанные (без заменённых и отменённых игроком) — по времени ставки, рассчитанные — по времени расчёта
    bind(
      `SELECT ${per("created_at", "CASE WHEN status NOT IN ('replaced', 'cancelled') THEN 1 ELSE 0 END").replace(/AS (\w+)/g, "AS made_$1")}, ` +
      `${per("created_at", "CASE WHEN status NOT IN ('replaced', 'cancelled') THEN stake ELSE 0 END").replace(/AS (\w+)/g, "AS stake_$1")}, ` +
      `${per("settled_at", "CASE WHEN status = 'won' THEN 1 ELSE 0 END").replace(/AS (\w+)/g, "AS won_$1")}, ` +
      `${per("settled_at", "CASE WHEN status = 'lost' THEN 1 ELSE 0 END").replace(/AS (\w+)/g, "AS lost_$1")}, ` +
      `${per("settled_at", "CASE WHEN status = 'won' THEN payout ELSE 0 END").replace(/AS (\w+)/g, "AS payout_$1")}, ` +
      `${PERIODS.map((p, i) => `COUNT(DISTINCT CASE WHEN created_at >= ?${i + 1} AND status NOT IN ('replaced', 'cancelled') THEN user_id END) AS players_${p}`).join(", ")} ` +
      "FROM predictions",
    ),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS stake, COUNT(DISTINCT user_id) AS players FROM predictions WHERE status = 'active'"),
    bind(
      `SELECT ${per("opened_at", "1").replace(/AS (\w+)/g, "AS opened_$1")}, ` +
      `${per("answered_at", "correct").replace(/AS (\w+)/g, "AS correct_$1")}, ` +
      `${per("answered_at", "CASE WHEN answered_at IS NOT NULL AND correct = 0 THEN 1 ELSE 0 END").replace(/AS (\w+)/g, "AS wrong_$1")}, ` +
      `${PERIODS.map((p, i) => `COUNT(DISTINCT CASE WHEN opened_at >= ?${i + 1} THEN user_id END) AS players_${p}`).join(", ")} ` +
      "FROM quiz_answers",
    ),
    db.prepare("SELECT MAX(ends_at) AS until, COUNT(CASE WHEN starts_at > ?1 OR starts_at IS NULL THEN 1 END) AS queued FROM quizzes").bind(now),
  ]);

  const byType = types.results.map((t) => ({ type: t.type, ...pick(t, bist), count: Object.fromEntries(PERIODS.map((p) => [p, t[`n_${p}`] || 0])) }));
  const sumSigned = (sign) => Object.fromEntries(PERIODS.map((p) => [p, bist(types.results.reduce((s, t) => s + (Math.sign(t[p]) === sign ? t[p] : 0), 0) * sign)]));
  const b = balances.results[0] || {};
  const p = preds.results[0] || {};
  const q = quiz.results[0] || {};
  const prefixed = (row, prefix, f) => pick(Object.fromEntries(PERIODS.map((x) => [x, row[`${prefix}_${x}`]])), f);
  const o = open.results[0];
  return {
    now,
    since: Object.fromEntries(PERIODS.map((x, i) => [x, since[i]])),
    bist: { issued: sumSigned(1), spent: sumSigned(-1), by_type: byType, total: bist(b.total) },
    players: {
      total: users.results[0].total,
      new: pick(users.results[0]),
      active: pick(active.results[0]),
      qualified: b.qualified || 0,
      qualify_bist: QUALIFY_BIST,
      top_n: b.top_n || 0,
      top_share: b.total > 0 ? Math.round((b.top / b.total) * 1000) / 10 : null,
    },
    predictions: {
      made: prefixed(p, "made"),
      players: prefixed(p, "players"),
      stake: prefixed(p, "stake", bist),
      won: prefixed(p, "won"),
      lost: prefixed(p, "lost"),
      payout: prefixed(p, "payout", bist),
      active: { count: o.n, stake: bist(o.stake), players: o.players },
    },
    quizzes: {
      opened: prefixed(q, "opened"),
      correct: prefixed(q, "correct"),
      wrong: prefixed(q, "wrong"),
      players: prefixed(q, "players"),
      queue_until: queue.results[0]?.until ?? null,
    },
  };
}
