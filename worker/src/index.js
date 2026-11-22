// TOTS на Cloudflare Workers + D1.
// Отдаёт интерфейс (папка webapp), API мини-приложения и вебхук бота.
// Каждый запрос к API проверяет подпись Telegram initData, поэтому подделать пользователя или баланс нельзя.

import { safeEqual, validateInitData, webhookSecret } from "./auth.js";
import { handleAdmin, isAdmin } from "./admin.js";
import { handleUpdate } from "./bot.js";
import { toBist } from "./money.js";
import {
  cancelPrediction,
  getMatch,
  listMatches,
  myPredictions,
  placePrediction,
  PredictionError,
} from "./predictions.js";
import { sync } from "./sync.js";
import { checkAlerts } from "./alerts.js";
import { answerQuestion, openQuestion, pastQuiz, QuizError, quizState, serveMedia } from "./quizzes.js";
import { history, leaderboard, publicProfile, takeSnapshot } from "./leaderboard.js";
import { displayName, registerOrUpdate, telegramName, yearsSince } from "./users.js";

import {
  advanceSeasons,
  seasonState,
  SeasonError,
  enterFinal,
  submitFinal,
  ownSeasonSummary,
} from "./seasons.js";
import { myFinals, tiebreak } from "./finals.js";
import {
  activePolicy,
  preferences,
  savePreferences,
  createRequest,
  processingConsent,
  recordProcessingConsent,
} from "./privacy.js";
export { validateInitData, webhookSecret } from "./auth.js";

export const SNAPSHOT_CRON = "1 21 * * *";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function profile(user, env, isNew) {
  return {
    id: user.id,
    name: displayName(user),
    nickname: user.nickname,
    telegram_name: telegramName(user),
    username: user.username,
    photo_url: user.photo_url,
    balance: toBist(user.balance),
    registered_at: user.created_at,
    years_in_tots: yearsSince(user.created_at),
    is_new: isNew,
    is_admin: isAdmin(env, user.id),
    is_blocked: user.blocked_at != null,
  };
}

async function handleApi(request, env, path) {
  if (path === "/api/policy" && request.method === "GET") return json({ policy: await activePolicy(env.DB) });
  const botToken = (env.BOT_TOKEN || "").trim();
  const tgUser = await validateInitData(request.headers.get("X-Telegram-Init-Data"), botToken);
  if (!tgUser) return json({ error: "Откройте приложение из Telegram" }, 401);

  const protectedAction = (request.method!=="GET" && !["/api/requests","/api/consents"].includes(path)) || path==="/api/quiz" || path.startsWith("/api/quiz/") || path==="/api/matches" || path.startsWith("/api/matches/");
  if(protectedAction && !isAdmin(env,tgUser.id)) {
    const moderation=await env.DB.prepare("SELECT blocked_at FROM users WHERE id=?").bind(tgUser.id).first();
    if(moderation?.blocked_at!=null)return json({error:"Аккаунт заблокирован. Вы можете посмотреть свою историю и обратиться через профиль.",code:"account_blocked"},403);
  }
  const policy = await activePolicy(env.DB);
  const consentNow = Math.floor(Date.now() / 1000);
  if (path === "/api/consents" && request.method === "POST")
    return json(
      await recordProcessingConsent(
        env.DB,
        tgUser.id,
        await request.json().catch(() => ({})),
        policy,
        consentNow,
      ),
    );
  if (
    !["/api/requests", "/api/preferences"].includes(path) &&
    !path.startsWith("/api/admin/") &&
    !(await processingConsent(env.DB, tgUser.id, policy))
  )
    return json(
      { error: "Нужно отдельное согласие на обработку данных", requires_processing_consent: true, policy },
      403,
    );
  // Регистрация и обновление данных из Telegram — только при открытии приложения (/api/me).
  // Остальным запросам достаточно ID из проверенной подписи: так меньше обращений к базе.
  if (path === "/api/me" && request.method === "GET") {
    await advanceSeasons(env.DB, Math.floor(Date.now() / 1000));
    const [user, isNew] = await registerOrUpdate(env.DB, tgUser, Number(env.START_BALANCE || 10));
    return json({
      ...profile(user, env, isNew),
      stats: { earned: toBist(user.earned), spent: toBist(user.spent) },
      preferences: {
        public_profile: Boolean(user.public_profile),
        public_avatar: Boolean(user.public_avatar),
        marketing_opt_in: Boolean(user.marketing_opt_in),
        marketing_opt_out: Boolean(user.marketing_opt_out),
      },
    });
  }
  const user = { id: tgUser.id };
  const now = Math.floor(Date.now() / 1000);
  if (
    request.method !== "GET" ||
    path === "/api/season" ||
    path === "/api/leaderboard" ||
    /^\/api\/users\/\d+$/.test(path)
  )
    await advanceSeasons(env.DB, now);

  if (path === "/api/nickname" && request.method === "POST") {
    return json({ error: "Изменение ника недоступно" }, 403);
  }

  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(env, user.id)) return json({ error: "Нет доступа" }, 403);
    return handleAdmin(request, env, user, path, json);
  }

  const params = new URL(request.url).searchParams;
  if (path === "/api/leaderboard" && request.method === "GET") {
    return json(await leaderboard(env.DB, { seasonId: params.get("season"), userId: user.id, ts: now }));
  }

  // Публичный профиль другого участника: без истории операций
  const other = /^\/api\/users\/(\d+)$/.exec(path);
  if (other && request.method === "GET") {
    const target = await publicProfile(env.DB, Number(other[1]), {
      viewerId: user.id,
      admin: isAdmin(env, user.id),
      now,
    });
    if (!target) return json({ error: "Пользователь не найден" }, 404);
    return json(target);
  }

  const summary = /^\/api\/seasons\/([a-z0-9-]+)\/summary$/.exec(path);
  if (summary && request.method === "GET") return json(await ownSeasonSummary(env.DB, summary[1], user.id));
  if (path === "/api/finals" && request.method === "GET") return json(await myFinals(env.DB, user.id));
  const tie = /^\/api\/finals\/([a-z0-9-]+)\/tiebreak$/.exec(path);
  if (tie && request.method === "GET") return json(await tiebreak(env.DB, tie[1], user.id, now));
  if (tie && request.method === "POST")
    return json(
      await tiebreak(env.DB, tie[1], user.id, now, (await request.json().catch(() => ({}))).answer),
    );
  if (path === "/api/season" && request.method === "GET")
    return json(await seasonState(env.DB, user.id, now));
  if (path === "/api/preferences") {
    if (request.method === "GET") return json(await preferences(env.DB, user.id));
    if (request.method === "PUT")
      return json(await savePreferences(env.DB, user.id, await request.json().catch(() => ({})), now));
  }
  if (path === "/api/requests") {
    if (request.method === "POST")
      return json(await createRequest(env.DB, user.id, await request.json().catch(() => ({})), now), 201);
    if (request.method === "GET")
      return json({
        items: (
          await env.DB.prepare(
            "SELECT id,kind,target_type,target_id,message,status,created_at,resolution FROM user_requests WHERE user_id=? ORDER BY id DESC LIMIT 50",
          )
            .bind(user.id)
            .all()
        ).results,
      });
  }
  const finalHistory = /^\/api\/finals\/([a-z0-9-]+)\/history$/.exec(path);
  if (finalHistory && request.method === "GET")
    return json({
      items: (
        await env.DB.prepare(
          "SELECT round,answers,submitted_at,score,reason FROM final_submissions WHERE season_id=? AND user_id=? ORDER BY round",
        )
          .bind(finalHistory[1], user.id)
          .all()
      ).results,
    });
  const final = /^\/api\/finals\/([a-z0-9-]+)\/(enter|submit)$/.exec(path);
  if (final && request.method === "POST") {
    if (final[2] === "enter") return json(await enterFinal(env.DB, final[1], user.id, now));
    return json(
      await submitFinal(env.DB, final[1], user.id, (await request.json().catch(() => ({}))).answers, now),
    );
  }
  // --- прогнозы ---
  try {
    if (path === "/api/matches" && request.method === "GET") {
      return json(
        await listMatches(env.DB, user.id, {
          tournament: params.get("t"),
          now,
          admin: isAdmin(env, user.id),
        }),
      );
    }
    const matchPath = /^\/api\/matches\/(\d+)$/.exec(path);
    if (matchPath && request.method === "GET") {
      const m = await getMatch(env.DB, user.id, Number(matchPath[1]), now, { admin: isAdmin(env, user.id) });
      return m ? json(m) : json({ error: "Матч не найден" }, 404);
    }
    if (path === "/api/predictions" && request.method === "GET") {
      return json(
        await myPredictions(env.DB, user.id, {
          admin: isAdmin(env, user.id),
          scope: params.get("scope"),
          before: params.get("before"),
          now,
        }),
      );
    }
    if (path === "/api/predictions" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return json(await placePrediction(env.DB, user.id, body, now, { admin: isAdmin(env, user.id) }));
    }
    const cancelPath = /^\/api\/predictions\/(\d+)\/cancel$/.exec(path);
    if (cancelPath && request.method === "POST") {
      return json(
        await cancelPrediction(env.DB, user.id, Number(cancelPath[1]), now, { admin: isAdmin(env, user.id) }),
      );
    }

    // --- викторины ---
    if (path === "/api/quiz" && request.method === "GET") return json(await quizState(env.DB, user.id, now));
    const quizPath = /^\/api\/quizzes\/(\d+)$/.exec(path);
    if (quizPath && request.method === "GET")
      return json(await pastQuiz(env.DB, user.id, Number(quizPath[1]), now));
    const questionPath = /^\/api\/quiz\/questions\/(\d+)\/(open|answer)$/.exec(path);
    if (questionPath && request.method === "POST") {
      const id = Number(questionPath[1]);
      if (questionPath[2] === "open") return json(await openQuestion(env.DB, user.id, id, now));
      const body = await request.json().catch(() => ({}));
      return json(await answerQuestion(env.DB, user.id, id, body.answer, now));
    }
  } catch (e) {
    if (e instanceof PredictionError) return json({ error: e.message, ...e.extra }, e.status);
    if (e instanceof QuizError) return json({ error: e.message }, e.status);
    throw e;
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
      if (update)
        await handleUpdate(update, botToken, `${url.origin}/`, env.DB).catch((e) => console.error(e));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await handleApi(request, env, url.pathname);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (e) {
        if (e instanceof SeasonError) return json({ error: e.message }, e.status);
        if (/published_rules_immutable|published_policy_immutable/.test(String(e.message)))
          return json({ error: "Опубликованная версия неизменяема; требуется отдельное согласование." }, 409);
        if (/qualification_cutoff_locked|season_closed/.test(String(e.message)))
          return json(
            {
              error:
                "Отбор или сезон уже закрыт. Обновите экран; исправление требует решения администратора.",
            },
            409,
          );
        throw e;
      }
    }
    // Файлы к вопросам викторин: адрес со случайным token появляется у игрока только после открытия вопроса
    const media = /^\/media\/([a-f0-9]{32})$/.exec(url.pathname);
    if (media && request.method === "GET")
      return serveMedia(env.DB, (env.BOT_TOKEN || "").trim(), media[1], request);
    return env.ASSETS.fetch(request);
  },

  // Cron Triggers: календарь и архив Europe/Minsk, синхронизация матчей и оповещения раз в 30 минут
  async scheduled(event, env, ctx) {
    const now = Math.floor(event.scheduledTime / 1000);
    await advanceSeasons(env.DB, now);
    if (event.cron === SNAPSHOT_CRON) ctx.waitUntil(takeSnapshot(env.DB, now));
    // После синхронизации — оповещения администраторам (по каждой причине не чаще раза в сутки)
    else
      ctx.waitUntil(
        sync(env, now)
          .then(() => checkAlerts(env, now))
          .catch((e) => console.error(e)),
      );
  },
};
