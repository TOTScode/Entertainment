// Проверка подписи Telegram: initData мини-приложения и секрет вебхука бота.

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

export function safeEqual(a, b) {
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

// Секрет вебхука выводится из токена бота, чтобы не заводить отдельную переменную.
// Тот же расчёт делает .github/workflows/cloudflare.yml при регистрации вебхука.
export async function webhookSecret(botToken) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(botToken)));
  return toHex(digest).slice(0, 32);
}
