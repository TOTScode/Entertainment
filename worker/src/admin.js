// Админка: доступ по списку Telegram ID из переменной ADMIN_IDS.
// Каждое ручное действие пишется в audit_log с причиной и состоянием до и после.

import { getUser, searchUsers, displayName } from "./users.js";
import { history } from "./leaderboard.js";
import { toBist, toUnits } from "./money.js";
import { correctionStatements } from "./predictions.js";
import { dashboard } from "./dashboard.js";
import {
  adminQuizzes,
  createQuiz,
  deleteQuiz,
  moveQuiz,
  QuizError,
  saveSettings,
  updateQuiz,
  uploadMedia,
} from "./quizzes.js";

import {
  ensureCalendar,
  saveFinalRules,
  activateSeason,
  configureSeasonPolicy,
  SeasonError,
  audit,
} from "./seasons.js";
import { finalScores, reviewFinal, publishTiebreak } from "./finals.js";
import { validatePolicy } from "./privacy.js";
import { voidQuestion, requireFrozenDecision, decideFinalist } from "./corrections.js";
const MAX_ADJUSTMENT = 100000;

export function adminIds(env) {
  return new Set(
    String(env.ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
}

export const isAdmin = (env, userId) => adminIds(env).has(Number(userId));

async function writeAudit(db, { adminId, action, targetUserId, reason, before, after }) {
  const result = await db
    .prepare(
      "INSERT INTO audit_log (admin_id, action, target_user_id, reason, before_data, after_data, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      adminId,
      action,
      targetUserId,
      reason,
      JSON.stringify(before),
      JSON.stringify(after),
      Math.floor(Date.now() / 1000),
    )
    .run();
  return result.meta.last_row_id;
}

const publicUser = (u) => ({
  id: u.id,
  name: displayName(u),
  username: u.username,
  balance: toBist(u.balance),
  created_at: u.created_at,
  is_blocked: u.blocked_at != null,
  block_reason: u.block_reason || null,
  public_profile: Boolean(u.public_profile),
  public_avatar: Boolean(u.public_avatar),
});

export async function handleAdmin(request, env, admin, path, json) {
  const db = env.DB;
  const ts = Math.floor(Date.now() / 1000);
  const special = await complianceAdmin(request, env, admin, path, json, ts);
  if (special) return special;

  if (path === "/api/admin/users" && request.method === "GET") {
    const q = new URL(request.url).searchParams.get("q") || "";
    return json({ users: (await searchUsers(db, q)).map(publicUser) });
  }


  if (path === "/api/admin/users/action" && request.method === "POST") {
    const body=await request.json().catch(()=>({}));
    const id=Number(body.user_id), action=String(body.action||""), reason=String(body.reason||"").trim();
    if(!Number.isSafeInteger(id)||id<=0||!["block","unblock","hide_profile"].includes(action)) return json({error:"Выберите участника и действие"},400);
    if(!reason||reason.length>200) return json({error:"Укажите причину (до 200 символов)"},400);
    const target=await getUser(db,id);
    if(!target)return json({error:"Пользователь не найден"},404);
    if((action==="block"||action==="unblock")&&isAdmin(env,id))return json({error:"Нельзя блокировать администраторов"},409);
    if((action==="block")===(target.blocked_at!=null)&&action!=="hide_profile")return json({error:action==="block"?"Участник уже заблокирован":"Участник не заблокирован"},409);
    const blocked=action==="block"?ts:action==="unblock"?null:target.blocked_at;
    const after={blocked_at:blocked,public_profile:action==="unblock"?Boolean(target.public_profile):false,public_avatar:action==="unblock"?Boolean(target.public_avatar):false};
    const update=action==="unblock"
      ? db.prepare("UPDATE users SET blocked_at=NULL,blocked_by=NULL,block_reason=NULL WHERE id=?").bind(id)
      : action==="hide_profile"
        ? db.prepare("UPDATE users SET public_profile=0,public_avatar=0 WHERE id=?").bind(id)
        : db.prepare("UPDATE users SET blocked_at=?,blocked_by=?,block_reason=?,public_profile=0,public_avatar=0,marketing_opt_in=0 WHERE id=?").bind(ts,admin.id,reason,id);
    await db.batch([
      db.prepare("INSERT INTO audit_log(admin_id,action,target_user_id,reason,before_data,after_data,created_at) SELECT ?,?,?,?,json_object('blocked_at',blocked_at,'public_profile',public_profile,'public_avatar',public_avatar),?,? FROM users WHERE id=?").bind(admin.id,"user_"+action,id,reason,JSON.stringify(after),ts,id),
      update,
    ]);
    return json({user:publicUser(await getUser(db,id))});
  }

  if (path === "/api/admin/adjust" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const userId = Number(body.user_id);
    const amount = Number(body.amount);
    if(!Number.isSafeInteger(userId)||userId<=0)return json({error:"Выберите участника"},400);
    const reason = String(body.reason ?? "").trim();
    if (!reason || reason.length>200) return json({ error: "Укажите причину (до 200 символов)" }, 400);
    // Можно с одним знаком после запятой: 2.5 BIST
    if (
      !Number.isFinite(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_ADJUSTMENT ||
      !Number.isInteger(Math.round(amount * 1e6) / 1e5)
    ) {
      return json(
        { error: `Сумма — от 0.1 до ${MAX_ADJUSTMENT} по модулю, не больше одного знака после запятой` },
        400,
      );
    }
    const target = await getUser(db, userId);
    if (!target) return json({ error: "Пользователь не найден" }, 404);


    const operation="admin:"+crypto.randomUUID();
    let results;
    try {
      results=await db.batch([
        db.prepare("INSERT INTO transactions(user_id,amount,type,ref,created_at) VALUES(?,?,'admin_adjustment',?,?)").bind(userId,toUnits(amount),operation,ts),
        db.prepare("INSERT INTO audit_log(admin_id,action,target_user_id,reason,before_data,after_data,created_at) SELECT ?,'balance_adjustment',?,?,json_object('balance',(COALESCE(SUM(amount),0)-?)/10000.0),json_object('balance',COALESCE(SUM(amount),0)/10000.0,'amount',?,'transaction_id',(SELECT id FROM transactions WHERE ref=?),'operation_id',?),? FROM transactions WHERE user_id=?").bind(admin.id,userId,reason,toUnits(amount),amount,operation,operation,ts,userId),
        db.prepare("UPDATE transactions SET ref='audit:'||(SELECT id FROM audit_log WHERE json_extract(after_data,'$.operation_id')=?) WHERE ref=?").bind(operation,operation),
        db.prepare("SELECT id FROM audit_log WHERE json_extract(after_data,'$.operation_id')=?").bind(operation),
      ]);
    } catch(e) {
      if(String(e.message).includes("insufficient_balance"))return json({error:"Недостаточно BIST"},409);
      throw e;
    }
    return json({user:publicUser(await getUser(db,userId)),audit_id:results[3].results[0].id});
  }

  // Исправление счёта уже рассчитанного матча: выигрыши пересчитываются, действие пишется в журнал
  const result = /^\/api\/admin\/matches\/(\d+)\/result$/.exec(path);
  if (result && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const home = Number(body.home);
    const away = Number(body.away);
    const reason = String(body.reason ?? "").trim();
    if (!reason) return json({ error: "Укажите причину" }, 400);
    if (![home, away].every((n) => Number.isInteger(n) && n >= 0 && n <= 30))
      return json({ error: "Неверный счёт" }, 400);
    const match = await db.prepare("SELECT * FROM matches WHERE id = ?").bind(Number(result[1])).first();
    if (!match) return json({ error: "Матч не найден" }, 404);
    if (match.status !== "finished")
      return json({ error: "Исправить можно только счёт сыгранного матча" }, 409);
    const now = Math.floor(Date.now() / 1000);
    await requireFrozenDecision(db, body, now);
    await db.batch([
      ...correctionStatements(db, match, [home, away], now),
      db
        .prepare(
          "INSERT INTO audit_log (admin_id, action, target_user_id, reason, before_data, after_data, created_at) VALUES (?, 'match_result', NULL, ?, ?, ?, ?)",
        )
        .bind(
          admin.id,
          reason,
          JSON.stringify({
            match_id: match.id,
            match: `${match.home} — ${match.away}`,
            score: [match.home_score, match.away_score],
          }),
          JSON.stringify({ match_id: match.id, match: `${match.home} — ${match.away}`, score: [home, away] }),
          now,
        ),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/admin/dashboard" && request.method === "GET")
    return json(await dashboard(db, Math.floor(Date.now() / 1000)));

  // --- викторины ---
  if (path.startsWith("/api/admin/quiz") || path === "/api/admin/media") {
    const now = Math.floor(Date.now() / 1000);
    try {
      if (path === "/api/admin/quizzes" && request.method === "GET") return json(await adminQuizzes(db, now));
      if (path === "/api/admin/quizzes" && request.method === "POST") {
        const id = await createQuiz(db, admin.id, await request.json().catch(() => ({})), now);
        return json({ id, ...(await adminQuizzes(db, now)) });
      }
      const one = /^\/api\/admin\/quizzes\/(\d+)(?:\/(move))?$/.exec(path);
      if (one && request.method === "PUT" && !one[2])
        await updateQuiz(db, Number(one[1]), await request.json().catch(() => ({})), now);
      else if (one && request.method === "DELETE" && !one[2]) await deleteQuiz(db, Number(one[1]), now);
      else if (one && request.method === "POST" && one[2])
        await moveQuiz(db, Number(one[1]), (await request.json().catch(() => ({}))).dir, now);
      else if (path === "/api/admin/quiz-settings" && request.method === "POST")
        await saveSettings(db, await request.json().catch(() => ({})), now);
      else if (path === "/api/admin/media" && request.method === "POST") {
        const form = await request.formData().catch(() => null);
        return json(await uploadMedia(db, (env.BOT_TOKEN || "").trim(), admin.id, form?.get("file"), now));
      } else return json({ error: "Не найдено" }, 404);
      return json(await adminQuizzes(db, now));
    } catch (e) {
      if (e instanceof QuizError) return json({ error: e.message }, e.status);
      throw e;
    }
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

async function complianceAdmin(request, env, admin, path, json, now) {
  const db = env.DB;
  const body =
    request.method === "GET"
      ? {}
      : await request
          .clone()
          .json()
          .catch(() => ({}));
  const final = /^\/api\/admin\/finals\/([a-z0-9-]+)\/(scores|review|tiebreak|submissions)$/.exec(path);
  if (final) {
    if (final[2] === "scores" && request.method === "GET") return json(await finalScores(db, final[1], now));
    if (final[2] === "review" && request.method === "POST")
      return json(await reviewFinal(db, final[1], body, admin.id, now));
    if (final[2] === "tiebreak" && request.method === "POST")
      return json(await publishTiebreak(db, final[1], body, admin.id, now));
    if (final[2] === "submissions" && request.method === "GET")
      return json({
        items: (
          await db
            .prepare("SELECT * FROM final_submissions WHERE season_id=? ORDER BY user_id,round")
            .bind(final[1])
            .all()
        ).results,
      });
  }
  if (path === "/api/admin/seasons" && request.method === "GET") {
    await ensureCalendar(db, now);
    return json({
      items: (
        await db
          .prepare(
            "SELECT s.*,r.body AS rules,r.published_at,r.frozen_at FROM seasons s LEFT JOIN final_rules r ON r.season_id=s.id WHERE s.starts_at>=1796072400 ORDER BY starts_at DESC",
          )
          .all()
      ).results,
    });
  }
  if (path === "/api/admin/seasons/policy" && request.method === "POST")
    return json(await configureSeasonPolicy(db, body, admin.id, now));
  if (path === "/api/admin/seasons/activate" && request.method === "POST")
    return json(await activateSeason(db, body, admin.id, now));
  const rules = /^\/api\/admin\/seasons\/([a-z0-9-]+)\/rules$/.exec(path);
  if (rules && request.method === "PUT") {
    await saveFinalRules(db, rules[1], body.rules || {}, admin.id, now, { publish: body.publish === true });
    return json({ ok: true });
  }
  const admission = /^\/api\/admin\/seasons\/([a-z0-9-]+)\/admission$/.exec(path);
  if (admission && request.method === "POST")
    return json(await decideFinalist(db, admission[1], body, admin.id, now));
  const question = /^\/api\/admin\/questions\/(\d+)\/void$/.exec(path);
  if (question && request.method === "POST")
    return json(await voidQuestion(db, Number(question[1]), body, admin.id, now));
  if (path === "/api/admin/policy" && request.method === "PUT") {
    if (!/^[a-zA-Z0-9._-]{1,60}$/.test(body.version || ""))
      throw new SeasonError("Укажите версию политики", 400);
    if (body.publish) validatePolicy(body.policy || {});
    const old = await db
      .prepare("SELECT published_at FROM policy_documents WHERE version=?")
      .bind(body.version)
      .first();
    if (old?.published_at) throw new SeasonError("Опубликованную версию нельзя менять");
    await db
      .prepare(
        "INSERT INTO policy_documents(version,body,published_at,published_by) VALUES(?,?,?,?) ON CONFLICT(version) DO UPDATE SET body=excluded.body,published_at=excluded.published_at,published_by=excluded.published_by",
      )
      .bind(
        body.version,
        JSON.stringify(body.policy || {}),
        body.publish ? now : null,
        body.publish ? admin.id : null,
      )
      .run();
    return json({ ok: true });
  }
  if (path === "/api/admin/requests" && request.method === "GET")
    return json({
      items: (await db.prepare("SELECT * FROM user_requests ORDER BY id DESC LIMIT 100").all()).results,
    });
  const req = /^\/api\/admin\/requests\/(\d+)$/.exec(path);
  if (req && request.method === "PUT") {
    if (
      !["open", "in_review", "resolved", "rejected"].includes(body.status) ||
      !String(body.resolution || "").trim()
    )
      throw new SeasonError("Укажите статус и мотивированный ответ", 400);
    await db.batch([
      db
        .prepare("UPDATE user_requests SET status=?,resolution=?,resolved_by=?,resolved_at=? WHERE id=?")
        .bind(body.status, body.resolution, admin.id, now, Number(req[1])),
      db
        .prepare("INSERT INTO audit_log(admin_id,action,reason,after_data,created_at) VALUES(?,?,?,?,?)")
        .bind(
          admin.id,
          "request_resolution",
          body.resolution,
          JSON.stringify({ id: Number(req[1]), status: body.status }),
          now,
        ),
    ]);
    return json({ ok: true });
  }
  return null;
}
