// TOTS на Cloudflare Workers + D1.
// Отдаёт интерфейс (папка webapp), API мини-приложения и вебхук бота.
// Каждый запрос к API проверяет подпись Telegram initData, поэтому подделать пользователя или баланс нельзя.

import { safeEqual, validateInitData, webhookSecret } from "./auth.js";
import { handleAdmin, isAdmin } from "./admin.js";
import { handleUpdate } from "./bot.js";
import { history, leaderboard, publicProfile, takeSnapshot } from "./leaderboard.js";
import { displayName, getUser, registerOrUpdate, setNickname, telegramName, validateNickname, yearsSince } from "./users.js";

export { validateInitData, webhookSecret } from "./auth.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function profile(user, env, isNew) {
  return {
    id: user.id,
    name: displayName(user),
    nickname: user.nickname,
    telegram_name: telegramName(user),
    username: user.username,
    photo_url: user.photo_url,
    balance: user.balance,
    registered_at: user.created_at,
    years_in_tots: yearsSince(user.created_at),
    is_new: isNew,
    is_admin: isAdmin(env, user.id),
  };
}

async function handleApi(request, env, path) {
  const botToken = (env.BOT_TOKEN || "").trim();
  const tgUser = await validateInitData(request.headers.get("X-Telegram-Init-Data"), botToken);
  if (!tgUser) return json({ error: "Откройте приложение из Telegram" }, 401);
  // Регистрация и обновление данных из Telegram — только при открытии приложения (/api/me).
  // Остальным запросам достаточно ID из проверенной подписи: так меньше обращений к базе.
  if (path === "/api/me" && request.method === "GET") {
    const [user, isNew] = await registerOrUpdate(env.DB, tgUser, Number(env.START_BALANCE || 10));
    return json({ ...profile(user, env, isNew), stats: { earned: user.earned, spent: user.spent } });
  }
  const user = { id: tgUser.id };

  if (path === "/api/nickname" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { nickname, error } = validateNickname(body.nickname);
    if (error) return json({ error }, 400);
    if (!(await setNickname(env.DB, user.id, nickname))) return json({ error: "Этот ник уже занят" }, 409);
    return json(profile(await getUser(env.DB, user.id), env, false));
  }

  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(env, user.id)) return json({ error: "Нет доступа" }, 403);
    return handleAdmin(request, env, user, path, json);
  }

  const params = new URL(request.url).searchParams;
  if (path === "/api/leaderboard" && request.method === "GET") {
    return json(await leaderboard(env.DB, { period: params.get("period") || "all", userId: user.id }));
  }

  // Публичный профиль другого участника: без истории операций
  const other = /^\/api\/users\/(\d+)$/.exec(path);
  if (other && request.method === "GET") {
    const target = await publicProfile(env.DB, Number(other[1]));
    if (!target) return json({ error: "Пользователь не найден" }, 404);
    return json(target);
  }

  if (path === "/api/history" && request.method === "GET") {
    return json(await history(env.DB, user.id, { before: params.get("before") }));
  }

  return json({ error: "Не найдено" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const botToken = (env.BOT_TOKEN || "").trim();
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!botToken || !safeEqual(given, await webhookSecret(botToken))) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      // Ошибка отправки не должна приводить к повторной доставке апдейта Telegram'ом
      if (update) await handleUpdate(update, botToken, `${url.origin}/`).catch((e) => console.error(e));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger из wrangler.toml: снимок рейтинга в начале каждого дня по Москве
  async scheduled(event, env, ctx) {
    ctx.waitUntil(takeSnapshot(env.DB, Math.floor(event.scheduledTime / 1000)));
  },
};
