// Админка: доступ по списку Telegram ID из переменной ADMIN_IDS.
// Каждое ручное действие пишется в audit_log с причиной и состоянием до и после.

import { addTransaction, getUser, LedgerError, searchUsers, displayName } from "./users.js";
import { history } from "./leaderboard.js";

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
  balance: u.balance,
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
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUSTMENT) {
      return json({ error: `Сумма — целое число от 1 до ${MAX_ADJUSTMENT} по модулю` }, 400);
    }
    const target = await getUser(db, userId);
    if (!target) return json({ error: "Пользователь не найден" }, 404);

    let tx;
    try {
      tx = await addTransaction(db, { userId, amount, type: "admin_adjustment" });
    } catch (e) {
      if (e instanceof LedgerError) return json({ error: e.message }, 409);
      throw e;
    }
    const auditId = await writeAudit(db, {
      adminId: admin.id,
      action: "balance_adjustment",
      targetUserId: userId,
      reason,
      before: { balance: target.balance },
      after: { balance: tx.balance, amount, transaction_id: tx.id },
    });
    await db.prepare("UPDATE transactions SET ref = ? WHERE id = ?").bind(`audit:${auditId}`, tx.id).run();
    return json({ user: publicUser({ ...target, balance: tx.balance }), audit_id: auditId });
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

