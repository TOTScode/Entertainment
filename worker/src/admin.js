// Админка: доступ по списку Telegram ID из переменной ADMIN_IDS.
// Каждое ручное действие пишется в audit_log с причиной и состоянием до и после.

import { addTransaction, getUser, LedgerError, searchUsers, displayName } from "./users.js";
import { history } from "./leaderboard.js";
import { toBist, toUnits } from "./money.js";
import { correctionStatements } from "./predictions.js";

const MAX_ADJUSTMENT = 100000;

export function adminIds(env) {
  return new Set(
    String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  );
}

export const isAdmin = (env, userId) => adminIds(env).has(Number(userId));

async function writeAudit(db, { adminId, action, targetUserId, reason, before, after }) {
  const result = await db
    .prepare(
      "INSERT INTO audit_log (admin_id, action, target_user_id, reason, before_data, after_data, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(adminId, action, targetUserId, reason, JSON.stringify(before), JSON.stringify(after), Math.floor(Date.now() / 1000))
    .run();
  return result.meta.last_row_id;
}

const publicUser = (u) => ({
  id: u.id,
  name: displayName(u),
  username: u.username,
  balance: toBist(u.balance),
  created_at: u.created_at,
});

export async function handleAdmin(request, env, admin, path, json) {
  const db = env.DB;

  if (path === "/api/admin/users" && request.method === "GET") {
    const q = new URL(request.url).searchParams.get("q") || "";
    return json({ users: (await searchUsers(db, q)).map(publicUser) });
  }

  if (path === "/api/admin/adjust" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const userId = Number(body.user_id);
    const amount = Number(body.amount);
    const reason = String(body.reason ?? "").trim();
    if (!reason) return json({ error: "Укажите причину" }, 400);
    // Можно с одним знаком после запятой: 2.5 BIST
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUSTMENT || !Number.isInteger(Math.round(amount * 1e6) / 1e5)) {
      return json({ error: `Сумма — от 0.1 до ${MAX_ADJUSTMENT} по модулю, не больше одного знака после запятой` }, 400);
    }
    const target = await getUser(db, userId);
    if (!target) return json({ error: "Пользователь не найден" }, 404);

    let tx;
    try {
      tx = await addTransaction(db, { userId, amount: toUnits(amount), type: "admin_adjustment" });
    } catch (e) {
      if (e instanceof LedgerError) return json({ error: e.message }, 409);
      throw e;
    }
    const auditId = await writeAudit(db, {
      adminId: admin.id,
      action: "balance_adjustment",
      targetUserId: userId,
      reason,
      before: { balance: toBist(target.balance) },
      after: { balance: toBist(tx.balance), amount, transaction_id: tx.id },
    });
    await db.prepare("UPDATE transactions SET ref = ? WHERE id = ?").bind(`audit:${auditId}`, tx.id).run();
    return json({ user: publicUser({ ...target, balance: tx.balance }), audit_id: auditId });
  }

  // Исправление счёта уже рассчитанного матча: выигрыши пересчитываются, действие пишется в журнал
  const result = /^\/api\/admin\/matches\/(\d+)\/result$/.exec(path);
  if (result && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const home = Number(body.home);
    const away = Number(body.away);
    const reason = String(body.reason ?? "").trim();
    if (!reason) return json({ error: "Укажите причину" }, 400);
    if (![home, away].every((n) => Number.isInteger(n) && n >= 0 && n <= 30)) return json({ error: "Неверный счёт" }, 400);
    const match = await db.prepare("SELECT * FROM matches WHERE id = ?").bind(Number(result[1])).first();
    if (!match) return json({ error: "Матч не найден" }, 404);
    if (match.status !== "finished") return json({ error: "Исправить можно только счёт сыгранного матча" }, 409);
    const now = Math.floor(Date.now() / 1000);
    await db.batch([
      ...correctionStatements(db, match, [home, away], now),
      db
        .prepare(
          "INSERT INTO audit_log (admin_id, action, target_user_id, reason, before_data, after_data, created_at) VALUES (?, 'match_result', NULL, ?, ?, ?, ?)",
        )
        .bind(
          admin.id, reason,
          JSON.stringify({ match_id: match.id, match: `${match.home} — ${match.away}`, score: [match.home_score, match.away_score] }),
          JSON.stringify({ match_id: match.id, match: `${match.home} — ${match.away}`, score: [home, away] }),
          now,
        ),
    ]);
    return json({ ok: true });
  }

  // История операций любого пользователя, для карточки участника в админке
  if (path === "/api/admin/history" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    return json(await history(db, Number(params.get("user_id")), { before: params.get("before") }));
  }

  if (path === "/api/admin/audit" && request.method === "GET") {
    const rows = await db
      .prepare(
        "SELECT a.*, u.username, u.first_name, u.last_name, u.nickname FROM audit_log a " +
        "LEFT JOIN users u ON u.id = a.target_user_id ORDER BY a.id DESC LIMIT 50",
      )
      .all();
    return json({
      entries: rows.results.map((r) => ({
        id: r.id,
        admin_id: r.admin_id,
        action: r.action,
        target_user_id: r.target_user_id,
        target_name: r.target_user_id ? displayName(r) : null,
        reason: r.reason,
        before: JSON.parse(r.before_data || "null"),
        after: JSON.parse(r.after_data || "null"),
        created_at: r.created_at,
      })),
    });
  }

  return json({ error: "Не найдено" }, 404);
}

