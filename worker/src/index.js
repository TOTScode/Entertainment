// TOTS API на Cloudflare Workers + D1.
// Отдаёт интерфейс (папка webapp) и API /api/me. Баланс хранится только на сервере:
// каждый запрос проверяет подпись Telegram initData, поэтому подделать пользователя или баланс нельзя.

const MAX_AGE_SECONDS = 24 * 3600;
const encoder = new TextEncoder();

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function validateInitData(initData, botToken, now = Date.now() / 1000) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = await hmac("WebAppData", botToken);
  const calculated = toHex(await hmac(secretKey, dataCheckString));
  if (!safeEqual(calculated, receivedHash)) return null;
  if (now - Number(params.get("auth_date") || 0) > MAX_AGE_SECONDS) return null;
  try {
    const user = JSON.parse(params.get("user") || "");
    return user && typeof user === "object" && "id" in user ? user : null;
  } catch {
    return null;
  }
}

// Авторегистрация: при первом входе создаёт пользователя со стартовым балансом,
// дальше обновляет только имя и фото. Возвращает [пользователь, создан_ли_сейчас].
export async function registerOrUpdate(db, tgUser, startBalance) {
  const fields = [tgUser.username ?? null, tgUser.first_name ?? null, tgUser.last_name ?? null, tgUser.photo_url ?? null];
  const inserted = await db
    .prepare("INSERT OR IGNORE INTO users (id, username, first_name, last_name, photo_url, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(tgUser.id, ...fields, startBalance, Math.floor(Date.now() / 1000))
    .run();
  const created = inserted.meta.changes > 0;
  if (!created) {
    await db
      .prepare("UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ? WHERE id = ?")
      .bind(...fields, tgUser.id)
      .run();
  }
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(tgUser.id).first();
  return [user, created];
}

export function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || (user.username ? "@" + user.username : "Игрок");
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/me") {
      const tgUser = await validateInitData(request.headers.get("X-Telegram-Init-Data"), env.BOT_TOKEN);
      if (!tgUser) return json({ error: "Откройте приложение из Telegram" }, 401);
      const [user, isNew] = await registerOrUpdate(env.DB, tgUser, Number(env.START_BALANCE || 10));
      return json({
        id: user.id,
        name: displayName(user),
        username: user.username,
        photo_url: user.photo_url,
        balance: user.balance,
        is_new: isNew,
      });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Не найдено" }, 404);
    return env.ASSETS.fetch(request);
  },
};
