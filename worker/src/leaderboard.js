import { rankParticipants } from "./quiz-ranking.js";
import { balanceStatisticsColumns } from "./balance-statistics.js";
import { toBist } from "./money.js";
import { displayName } from "./users.js";
import { competitionSeason, FIRST_SEASON_START, SeasonError } from "./seasons.js";
import { participantStats, emptyStats } from "./statistics.js";
export const PERIODS = ["all", "week", "month"]; // legacy query arguments are ignored; never change ordering
export const moscowDay = (ts) => new Date((ts + 10800) * 1000).toISOString().slice(0, 10);
export function periodStart(period, ts) {
  const d = new Date((ts + 10800) * 1000);
  if (period === "week")
    return (
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) / 1000 - 10800
    );
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - 10800;
  return null;
}
const publicName = (u) => u.nickname || "Участник " + u.id;
export async function leaderboard(
  db,
  { userId, seasonId = null, limit = 100, ts = Math.floor(Date.now() / 1000) },
) {
  const current = competitionSeason(ts);
  let s = current;
  if (seasonId && seasonId !== current.id) {
    s = await db.prepare("SELECT * FROM seasons WHERE id=?").bind(seasonId).first();
    if (!s || s.starts_at < FIRST_SEASON_START || s.starts_at > Math.max(ts, FIRST_SEASON_START))
      throw new SeasonError("Сезон не найден", 404);
  }
  const [users, frozen, participants] = await db.batch([
    db.prepare(
      "SELECT u.id,u.created_at,u.nickname,u.photo_url,u.public_profile,u.public_avatar,COALESCE(SUM(t.amount),0)>=1000000 AS qualified FROM users u LEFT JOIN transactions t ON t.user_id=u.id GROUP BY u.id",
    ),
    db.prepare("SELECT qualification_frozen_at AS frozen_at FROM seasons WHERE id=?").bind(s.id),
    db.prepare("SELECT user_id,qualified,statistics FROM season_participants WHERE season_id=?").bind(s.id),
  ]);
  const archived = s.id !== current.id,
    locked = Boolean(frozen.results[0]?.frozen_at);
  let stats = await participantStats(db, { from: s.starts_at, to: Math.min(s.ends_at, ts + 1) });
  if (archived) {
    const summaries = await db
      .prepare("SELECT user_id,statistics FROM season_summaries WHERE season_id=?")
      .bind(s.id)
      .all();
    stats = new Map(summaries.results.map((r) => [r.user_id, JSON.parse(r.statistics)]));
  }
  const admissions = new Map(participants.results.map((p) => [p.user_id, Boolean(p.qualified)])); // Frozen public qualification remains the original cutoff fact; admission decisions are separate.
  const row = (u) => ({
    id: u.id,
    name: publicName(u),
    photo_url: u.public_profile && u.public_avatar ? u.photo_url : null,
    ...(stats.get(u.id) || emptyStats()),
    qualified: locked
      ? admissions.get(u.id) || false
      : archived
        ? null
        : ts >= FIRST_SEASON_START && Boolean(u.qualified),
    profile_public: Boolean(u.public_profile),
  });
  const rows = rankParticipants(
    users.results
      .filter((u) => ts >= FIRST_SEASON_START && u.public_profile && (!archived || u.created_at < s.ends_at))
      .map(row),
  );
  return {
    season: {
      pending_start: ts < FIRST_SEASON_START,
      id: s.id,
      name: s.name || s.id,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      timezone: "Europe/Minsk",
    },
    qualification_frozen: locked,
    qualification_unavailable: archived && !locked,
    sort: "quiz_rating_desc",
    total: rows.length,
    rows: rows.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100)),
    me: users.results.find((u) => u.id === userId && (!archived || u.created_at < s.ends_at))
      ? rows.find((r) => r.id === userId) || {
          ...row(users.results.find((u) => u.id === userId)),
          rank: null,
        }
      : null,
  };
}
export async function publicProfile(
  db,
  userId,
  { viewerId = null, admin = false, now = Math.floor(Date.now() / 1000) } = {},
) {
  const u = await db.prepare("SELECT * FROM users WHERE id=?").bind(userId).first();
  if (!u) return null;
  const privateAccess = viewerId === userId || admin;
  if (!privateAccess && !u.public_profile) return null;
  const board = await leaderboard(db, { userId, ts: now });
  const stats = board.me || emptyStats();
  const result = {
    id: u.id,
    name: publicName(u),
    photo_url: privateAccess || u.public_avatar ? u.photo_url : null,
    quizzes: stats.quizzes,
    quiz_answers: stats.quiz_answers,
    quiz_correct: stats.quiz_correct,
    quiz_percent: stats.quiz_percent,
    predictions: stats.predictions,
    prediction_correct: stats.prediction_correct,
    prediction_percent: stats.prediction_percent,
    qualified: stats.qualified,
  };
  if (privateAccess) {
    const b = await db
      .prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM transactions WHERE user_id=?")
      .bind(userId)
      .first();
    Object.assign(result, {
      name: displayName(u),
      username: u.username,
      registered_at: u.created_at,
      balance: toBist(b.balance),
      stats: await userStats(db, userId),
    });
  }
  return result;
}
// Kept for the scheduler compatibility. Technical row order is not a sporting rank.
export async function takeSnapshot(db, ts = Math.floor(Date.now() / 1000)) {
  return moscowDay(ts);
}

export async function userStats(db, userId) {
  const row = await db
    .prepare(
      "SELECT " + balanceStatisticsColumns("?1"),
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
        "m.home || ' — ' || m.away AS match, p.market, p.outcome, p.is_admin_test, qz.title AS quiz FROM transactions t " +
        "LEFT JOIN audit_log a ON t.ref = 'audit:' || a.id " +
        // Для операций по прогнозам — матч и исход (ref вида prediction:12 или prediction:12:v1)
        "LEFT JOIN predictions p ON t.ref LIKE 'prediction:%' AND p.id = CAST(substr(t.ref, 12) AS INTEGER) " +
        "LEFT JOIN matches m ON m.id = p.match_id " +
        // Для наград за викторины — название викторины (ref вида quiz_question:7)
        "LEFT JOIN quiz_questions qq ON t.type IN ('quiz_reward','quiz_reward_reversal') AND qq.id = CAST(substr(t.ref, 15) AS INTEGER) " +
        "LEFT JOIN quizzes qz ON qz.id = qq.quiz_id " +
        "WHERE t.user_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?",
    )
    .bind(userId, cursor, size + 1)
    .all();
  const items = results.slice(0, size).map((t) => ({ ...t, amount: toBist(t.amount) }));
  return { items, next: results.length > size ? items[items.length - 1].id : null };
}
