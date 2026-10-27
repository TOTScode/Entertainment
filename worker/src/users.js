// Пользователи, ники и журнал транзакций BIST.
// Баланс никогда не хранится отдельным числом: это сумма транзакций пользователя.

const now = () => Math.floor(Date.now() / 1000);

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 24;
const NICKNAME_RE = /^[\p{L}\p{N} _.-]+$/u;

export class LedgerError extends Error {}

export function telegramName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || (user.username ? "@" + user.username : "Игрок");
}

export function displayName(user) {
  return user.nickname || telegramName(user);
}

// Полные годы с даты регистрации в приложении
export function yearsSince(timestamp, at = new Date()) {
  const from = new Date(timestamp * 1000);
  let years = at.getUTCFullYear() - from.getUTCFullYear();
  const beforeAnniversary =
    at.getUTCMonth() < from.getUTCMonth() ||
    (at.getUTCMonth() === from.getUTCMonth() && at.getUTCDate() < from.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return Math.max(0, years);
}

export async function getBalance(db, userId) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE user_id = ?")
    .bind(userId)
    .first();
  return row.balance;
}

// Добавляет транзакцию, если после неё баланс не уйдёт в минус.
// Проверка и запись — один SQL-запрос, поэтому параллельные списания не обойдут проверку.
export async function addTransaction(db, { userId, amount, type, ref = null }) {
  if (!Number.isInteger(amount) || amount === 0) throw new LedgerError("Сумма должна быть целым числом, не равным нулю");
  const result = await db
    .prepare(
      "INSERT INTO transactions (user_id, amount, type, ref, created_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5 " +
      "WHERE (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ?1) + ?2 >= 0",
    )
    .bind(userId, amount, type, ref, now())
    .run();
  if (result.meta.changes === 0) throw new LedgerError("Недостаточно BIST");
  return { id: result.meta.last_row_id, balance: await getBalance(db, userId) };
}

// Авторегистрация: создаёт пользователя и однократно начисляет стартовые BIST,
// при повторных входах обновляет данные профиля из Telegram. Возвращает [пользователь, создан_ли_сейчас].
export async function registerOrUpdate(db, tgUser, startBalance) {
  const fields = [tgUser.username ?? null, tgUser.first_name ?? null, tgUser.last_name ?? null, tgUser.photo_url ?? null];
  const ts = now();
  // Запись профиля, бонус и чтение пользователя со статистикой — одним обращением к базе
  const [, bonus, read] = await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, username, first_name, last_name, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, " +
        "last_name = excluded.last_name, photo_url = excluded.photo_url",
      )
      .bind(tgUser.id, ...fields, ts),
    // Уникальный индекс transactions_signup_once гарантирует один бонус на пользователя
    db
      .prepare("INSERT OR IGNORE INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, 'signup_bonus', ?)")
      .bind(tgUser.id, startBalance, ts),
    db
      .prepare(
        "SELECT u.*, COALESCE(SUM(t.amount), 0) AS balance, " +
        "COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS earned, " +
        "COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS spent " +
        "FROM users u LEFT JOIN transactions t ON t.user_id = u.id WHERE u.id = ? GROUP BY u.id",
      )
      .bind(tgUser.id),
  ]);
  return [read.results[0], bonus.meta.changes > 0];
}

export async function getUser(db, userId) {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return null;
  return { ...user, balance: await getBalance(db, userId) };
}

// Проверка и сохранение ника. Пустая строка сбрасывает ник на имя из Telegram.
export function validateNickname(raw) {
  const nickname = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!nickname) return { nickname: null };
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    return { error: `Ник должен быть от ${NICKNAME_MIN} до ${NICKNAME_MAX} символов` };
  }
  if (!NICKNAME_RE.test(nickname)) return { error: "Можно использовать буквы, цифры, пробел, точку, дефис и _" };
  return { nickname };
}

export async function setNickname(db, userId, nickname) {
  const key = nickname ? nickname.toLowerCase() : null;
  try {
    await db.prepare("UPDATE users SET nickname = ?, nickname_key = ? WHERE id = ?").bind(nickname, key, userId).run();
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return false;
    throw e;
  }
  return true;
}

export async function searchUsers(db, query, limit = 20) {
  const q = String(query ?? "").trim().replace(/^@/, "");
  let rows;
  if (/^\d+$/.test(q)) {
    rows = await db.prepare("SELECT * FROM users WHERE id = ?").bind(Number(q)).all();
  } else {
    const like = `%${q.toLowerCase()}%`;
    rows = await db
      .prepare(
        "SELECT * FROM users WHERE lower(COALESCE(username, '')) LIKE ?1 OR COALESCE(nickname_key, '') LIKE ?1 " +
        "OR lower(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?1 ORDER BY created_at DESC LIMIT ?2",
      )
      .bind(like, limit)
      .all();
  }
  return Promise.all(rows.results.map(async (u) => ({ ...u, balance: await getBalance(db, u.id) })));
}
