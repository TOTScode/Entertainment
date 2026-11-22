import { UNIT, toBist } from "./money.js";
import { participantStats, emptyStats } from "./statistics.js";
export class SeasonError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export function shortSeasonName(id) {
  const match = /^(\d{4})-(winter|spring|summer|autumn)$/.exec(id);
  if (!match) return id;
  const y = Number(match[1]),
    year = String(y % 100).padStart(2, "0");
  return {
    winter: "Зима " + year + "/" + String((y + 1) % 100).padStart(2, "0"),
    spring: "Весна " + year,
    summer: "Лето " + year,
    autumn: "Осень " + year,
  }[match[2]];
}
export const FIRST_SEASON_START = Date.parse("2026-12-01T00:00:00+03:00") / 1000;
export const competitionSeason = (now = Math.floor(Date.now() / 1000)) =>
  calendarSeason(Math.max(now, FIRST_SEASON_START));
export const TIMEZONE = "Europe/Minsk";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function parts(ts) {
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(ts * 1000))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}
function midnight(y, m) {
  let t = Date.UTC(y, m, 1) / 1000;
  for (let i = 0; i < 3; i++) {
    const p = parts(t);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
    t += Date.UTC(y, m, 1) / 1000 - represented;
  }
  return t;
}
export function calendarSeason(ts = Math.floor(Date.now() / 1000)) {
  const p = parts(ts),
    month = p.month - 1;
  let year = p.year,
    start,
    kind;
  if (month === 11 || month < 2) {
    kind = "winter";
    start = 11;
    if (month < 2) year--;
  } else if (month < 5) {
    kind = "spring";
    start = 2;
  } else if (month < 8) {
    kind = "summer";
    start = 5;
  } else {
    kind = "autumn";
    start = 8;
  }
  return {
    id: `${year}-${kind}`,
    name:
      { winter: "Зима", spring: "Весна", summer: "Лето", autumn: "Осень" }[kind] +
      (kind === "winter" ? ` ${year}–${year + 1}` : ` ${year}`),
    starts_at: midnight(year, start),
    ends_at: midnight(year, start + 3),
    label: shortSeasonName(`${year}-${kind}`),
    timezone: TIMEZONE,
    cutoff: midnight(year, start + 3) - 7 * 86400,
  };
}
export async function ensureCalendar(db, now) {
  const s = competitionSeason(now);
  await db
    .prepare("INSERT OR IGNORE INTO seasons(id,starts_at,ends_at) VALUES(?,?,?)")
    .bind(s.id, s.starts_at, s.ends_at)
    .run();
  return s;
}
export async function audit(db, admin, action, reason, before, after, now, target = null) {
  if (!String(reason || "").trim()) throw new SeasonError("Нужна причина", 400);
  return db
    .prepare(
      "INSERT INTO audit_log(admin_id,action,target_user_id,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(admin, action, target, reason, JSON.stringify(before), JSON.stringify(after), now)
    .run();
}
// Every legally significant field is mandatory. No default dates/prizes/operator are invented.
export function validateFinalRules(body, season) {
  const fields = [
    "organizer",
    "contacts",
    "eligibility",
    "pending_predictions",
    "tasks",
    "assessment",
    "tie_knowledge_task",
    "prizes",
    "prize_funding",
    "appeals",
    "corrections",
    "disputes",
  ];
  const errors = fields
    .filter((k) => typeof body[k] !== "string" || !body[k].trim())
    .map((k) => `Заполните ${k}`);
  for (const k of ["cutoff", "final_start", "final_end", "results_at", "prizes_due", "appeals_until"])
    if (!Number.isSafeInteger(body[k])) errors.push(`Укажите точное время ${k}`);
  if (body.season_id !== season.id || body.threshold !== 100) errors.push("Укажите сезон и порог 100 BIST");
  if (!Number.isInteger(body.attempts) || body.attempts < 1 || body.attempts > 10)
    errors.push("Укажите одинаковое число попыток 1–10");
  if (body.cutoff !== season.ends_at - 7 * 86400)
    errors.push("Отбор заканчивается за семь дней до конца сезона");
  if (body.pending_policy !== "exclude_pending")
    errors.push("Утвердите порядок учёта нерассчитанных прогнозов");
  if (
    !(
      body.cutoff > season.starts_at &&
      body.cutoff <= season.ends_at &&
      body.final_start >= body.cutoff &&
      body.final_end > body.final_start &&
      body.results_at >= body.final_end &&
      body.prizes_due >= body.results_at &&
      body.appeals_until >= body.results_at
    )
  )
    errors.push("Проверьте последовательность сроков");
  const tasks = Array.isArray(body.questions) ? body.questions : [];
  if (
    !tasks.length ||
    tasks.some(
      (q) =>
        !q.id ||
        !q.text ||
        !q.source ||
        !q.rubric ||
        !Number.isSafeInteger(q.reviewed_by) ||
        q.reviewed_by < 1 ||
        !Number.isSafeInteger(q.reviewed_at) ||
        q.reviewed_at < 1,
    )
  )
    errors.push("Все финальные задания должны иметь источник, критерии и проверку человеком");
  if (body.human_review_confirmed !== true) errors.push("Подтвердите проверку заданий человеком");
  if (new Set(tasks.map((q) => q.id)).size !== tasks.length || tasks.length > 50)
    errors.push("Укажите не больше 50 заданий с уникальными ID");
  if (errors.length) throw new SeasonError(errors.join("; "), 400);
  return { ...body };
}
export async function saveFinalRules(db, seasonId, body, admin, now, { publish = false } = {}) {
  const season = await db.prepare("SELECT * FROM seasons WHERE id=?").bind(seasonId).first();
  if (!season || season.starts_at < FIRST_SEASON_START) throw new SeasonError("Сезон не найден", 404);
  const old = await db.prepare("SELECT * FROM final_rules WHERE season_id=?").bind(seasonId).first();
  if (old?.published_at)
    throw new SeasonError(
      "Опубликованные условия неизменяемы: требуется отдельное согласование новой версии",
    );
  if (publish) {
    validateFinalRules(body, season);
    // Final rules may follow qualification, but cannot retroactively start a final.
    if (body.final_start <= now) throw new SeasonError("Нельзя публиковать правила уже начавшегося финала");
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO final_rules(season_id,body,published_at,published_by,frozen_at) VALUES(?,?,?,?,(SELECT qualification_frozen_at FROM seasons WHERE id=?)) ON CONFLICT(season_id) DO UPDATE SET body=excluded.body,version=final_rules.version+1,published_at=excluded.published_at,published_by=excluded.published_by",
      )
      .bind(seasonId, JSON.stringify(body), publish ? now : null, publish ? admin : null, seasonId),
    db
      .prepare(
        "INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id,reason) VALUES(?,0,?,?,?,?,?)",
      )
      .bind("final_rules", seasonId, JSON.stringify(body), now, admin, publish ? "publish" : "draft"),
  ]);
}
// Freeze using ledger at the declared cutoff, never the time the delayed cron happens to run.
export async function freezeFinalists(db, seasonId, now) {
  const s = await db.prepare("SELECT * FROM seasons WHERE id=?").bind(seasonId).first();
  if (!s || s.starts_at < FIRST_SEASON_START || s.qualification_frozen_at) return false;
  const cutoff = s.ends_at - 7 * 86400;
  if (now < cutoff) return false;
  const stats = await participantStats(db, { from: s.starts_at, to: cutoff });
  // INSERT and frozen_at update are atomic; repeated cron cannot grant duplicate entries.
  const statJSON = JSON.stringify(Object.fromEntries(stats));
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO season_participants(season_id,user_id,qualified,statistics,frozen_at)
 SELECT ?1,u.id,COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND created_at<?2),0)>=?3,COALESCE((SELECT value FROM json_each(?4) WHERE key=CAST(u.id AS TEXT)),?5),?2 FROM users u WHERE u.created_at<?2`,
      )
      .bind(seasonId, cutoff, 100 * UNIT, statJSON, JSON.stringify(emptyStats())),
    db
      .prepare("UPDATE final_rules SET frozen_at=? WHERE season_id=? AND frozen_at IS NULL")
      .bind(cutoff, seasonId),
    db
      .prepare("UPDATE seasons SET qualification_frozen_at=? WHERE id=? AND qualification_frozen_at IS NULL")
      .bind(cutoff, seasonId),
  ]);
  return true;
}
export async function freezeDue(db, now) {
  const rows = await db
    .prepare(
      "SELECT id AS season_id FROM seasons WHERE starts_at>=1796072400 AND qualification_frozen_at IS NULL AND ends_at-604800<=?",
    )
    .bind(now)
    .all();
  for (const r of rows.results) await freezeFinalists(db, r.season_id, now);
}
export async function seasonState(db, userId, now) {
  const season = competitionSeason(now);
  const [s, r, b, all] = await db.batch([
    db.prepare("SELECT * FROM seasons WHERE id=?").bind(season.id),
    db.prepare("SELECT * FROM final_rules WHERE season_id=?").bind(season.id),
    db.prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM transactions WHERE user_id=?").bind(userId),
    db
      .prepare(
        "SELECT id,starts_at,ends_at,qualification_frozen_at AS frozen_at FROM seasons WHERE starts_at>=1796072400 AND starts_at<=? ORDER BY starts_at DESC",
      )
      .bind(Math.max(now, FIRST_SEASON_START)),
  ]);
  let qualified = now >= FIRST_SEASON_START && b.results[0].balance >= 100 * UNIT;
  const rules = r.results[0];
  const frozenAt = s.results[0]?.qualification_frozen_at;
  if (frozenAt) {
    const p = await db
      .prepare("SELECT qualified FROM season_participants WHERE season_id=? AND user_id=?")
      .bind(season.id, userId)
      .first();
    qualified = Boolean(p?.qualified);
  }
  return {
    season: {
      ...season,
      pending_start: now < FIRST_SEASON_START,
      activation_pending: !s.results[0]?.activated_at,
    },
    qualified,
    threshold: 100,
    frozen: Boolean(frozenAt),
    admission_decision: frozenAt
      ? await db
          .prepare(
            "SELECT admitted,reason FROM finalist_decisions WHERE season_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
          )
          .bind(season.id, userId)
          .first()
      : null,
    rules: rules?.published_at ? publicRules(JSON.parse(rules.body)) : null,
    seasons: all.results.map((s) => ({ ...s, label: shortSeasonName(s.id) })),
  };
}
export function publicRules(r) {
  const { questions, ...publicFields } = r;
  return publicFields;
}
// No season activation until owner approves BOTH opening balance and handling of unsettled forecasts.
export async function configureSeasonPolicy(db, body, admin, now) {
  if (
    body.owner_approved !== true ||
    body.opening_bist !== 10 ||
    body.pending_policy !== "refund_old_season" ||
    body.repeat_each_season !== true ||
    !String(body.reason || "").trim()
  )
    throw new SeasonError(
      "Подтвердите правило: 10 BIST, возврат в старый сезон и повторение каждый сезон",
      400,
    );
  const config = { ...body, season_id: now < FIRST_SEASON_START ? null : competitionSeason(now).id };
  const old = await db.prepare("SELECT value FROM api_state WHERE key='season_rollover'").first();
  await db.batch([
    db
      .prepare(
        "INSERT INTO api_state(key,value,updated_at) VALUES('season_rollover',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .bind(JSON.stringify(config), now),
    db
      .prepare(
        "INSERT INTO audit_log(admin_id,action,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(admin, "season_policy", body.reason, old?.value || null, JSON.stringify(config), now),
  ]);
  return {
    configured: true,
    applies_from:
      now < FIRST_SEASON_START
        ? competitionSeason(now).id
        : calendarSeason(competitionSeason(now).ends_at).id,
  };
}
export async function activateSeason(db, body, admin, now) {
  if (now < FIRST_SEASON_START) throw new SeasonError("Первый сезон начнётся 1 декабря 2026 года");
  const s = competitionSeason(now);
  if (
    body.owner_approved !== true ||
    body.season_id !== s.id ||
    body.opening_bist !== 10 ||
    !Number.isSafeInteger(body.opening_bist * UNIT) ||
    !String(body.reason || "").trim()
  )
    throw new SeasonError("Утвердите сезон и начальный баланс (не регистрационный бонус)", 400);
  if (body.pending_policy !== "refund_old_season")
    throw new SeasonError("Нерассчитанные прогнозы нужно отменить с возвратом в старый сезон", 400);
  const old = await db.prepare("SELECT * FROM seasons WHERE id=?").bind(s.id).first();
  if (old?.activated_at) return { id: s.id, already_active: true };
  await freezeDue(db, now);
  await refundExpiredPredictions(db, now);
  await archiveExpired(db, now);
  const previous = old || null;
  const statements = [];
  statements.push(
    db
      .prepare(
        "INSERT INTO seasons(id,starts_at,ends_at,opening_units,activated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET opening_units=excluded.opening_units,activated_at=excluded.activated_at",
      )
      .bind(s.id, s.starts_at, s.ends_at, body.opening_bist * UNIT, now),
  );
  statements.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO transactions(user_id,amount,type,ref,created_at) SELECT u.id,?1-COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id),0),'season_opening',?2,?3 FROM users u`,
      )
      .bind(body.opening_bist * UNIT, s.id, now),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO api_state(key,value,updated_at) VALUES('season_rollover',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .bind(JSON.stringify(body), now),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_log(admin_id,action,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        admin,
        "season_activate",
        String(body.reason || "owner approved"),
        JSON.stringify(previous),
        JSON.stringify(body),
        now,
      ),
  );
  await db.batch(statements);
  return { id: s.id };
}
export async function advanceSeasons(db, now) {
  await ensureCalendar(db, now);
  if (now < FIRST_SEASON_START) return;
  await freezeDue(db, now);
  await refundExpiredPredictions(db, now);
  await archiveExpired(db, now);
  const p = await db.prepare("SELECT value FROM api_state WHERE key='season_rollover'").first();
  if (!p) return;
  const config = JSON.parse(p.value),
    s = calendarSeason(now);
  if (config.season_id === s.id || config.repeat_each_season !== true) return;
  await activateSeason(db, { ...config, season_id: s.id }, 0, now);
}
export async function finalistAdmission(db, seasonId, userId) {
  const decision = await db
    .prepare(
      "SELECT admitted FROM finalist_decisions WHERE season_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
    )
    .bind(seasonId, userId)
    .first();
  if (decision) return Boolean(decision.admitted);
  const p = await db
    .prepare("SELECT qualified FROM season_participants WHERE season_id=? AND user_id=?")
    .bind(seasonId, userId)
    .first();
  return Boolean(p?.qualified);
}
export async function enterFinal(db, seasonId, userId, now) {
  await freezeFinalists(db, seasonId, now);
  const row = await db.prepare("SELECT * FROM final_rules WHERE season_id=?").bind(seasonId).first();
  if (!row?.published_at || !row.frozen_at)
    throw new SeasonError("Правила финала не опубликованы или отбор не зафиксирован");
  const r = JSON.parse(row.body);
  if (now < r.final_start || now >= r.final_end) throw new SeasonError("Финал сейчас недоступен");
  if (!(await finalistAdmission(db, seasonId, userId)))
    throw new SeasonError("Нет зафиксированного допуска", 403);
  await db.prepare("INSERT OR IGNORE INTO final_entries VALUES(?,?,?)").bind(seasonId, userId, now).run();
  return {
    season_id: seasonId,
    attempts: r.attempts,
    questions: r.questions.map(({ id, text, source, rubric }) => ({ id, text, source, rubric })),
    ends_at: r.final_end,
  };
}
export async function submitFinal(db, seasonId, userId, answers, now) {
  const final = await enterFinal(db, seasonId, userId, now);
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    JSON.stringify(answers).length > 20000 ||
    final.questions.some((q) => typeof answers[q.id] !== "string")
  )
    throw new SeasonError("Ответьте на все задания", 400);
  const result = await db
    .prepare(
      `INSERT INTO final_submissions(season_id,user_id,round,answers,submitted_at) SELECT ?1,?2,COALESCE(MAX(round),0)+1,?3,?4 FROM final_submissions WHERE season_id=?1 AND user_id=?2 HAVING COUNT(*)<?5`,
    )
    .bind(seasonId, userId, JSON.stringify(answers), now, final.attempts)
    .run();
  if (!result.meta.changes) throw new SeasonError("Попытки финала исчерпаны");
  return { submitted: true };
}

// Archive statistics and private closing balance even while the reset rule awaits approval.
export async function archiveExpired(db, now) {
  const expired = await db
    .prepare(
      "SELECT * FROM seasons WHERE starts_at>=1796072400 AND ends_at<=? AND closed_at IS NULL ORDER BY starts_at",
    )
    .bind(now)
    .all();
  for (const s of expired.results) {
    const st = await participantStats(db, { from: s.starts_at, to: s.ends_at });
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO season_summaries SELECT ?1,u.id,COALESCE((SELECT value FROM json_each(?2) WHERE key=CAST(u.id AS TEXT)),?3),?4,COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND created_at<?4),0) FROM users u WHERE created_at<?4`,
        )
        .bind(s.id, JSON.stringify(Object.fromEntries(st)), JSON.stringify(emptyStats()), s.ends_at),
      db.prepare("UPDATE seasons SET closed_at=? WHERE id=?").bind(s.ends_at, s.id),
    ]);
  }
}
export async function ownSeasonSummary(db, seasonId, userId) {
  const row = await db
    .prepare(
      "SELECT statistics,closing_units,closed_at FROM season_summaries WHERE season_id=? AND user_id=? AND season_id IN(SELECT id FROM seasons WHERE starts_at>=1796072400)",
    )
    .bind(seasonId, userId)
    .first();
  if (!row) throw new SeasonError("Итог сезона ещё не зафиксирован", 404);
  return {
    season_id: seasonId,
    statistics: JSON.parse(row.statistics),
    closing_balance: toBist(row.closing_units),
    closed_at: row.closed_at,
  };
}

// A late cron records the refund in the ending season, before its closing snapshot/reset.
// Status changes, the unique refund and its provenance commit together.
export async function refundExpiredPredictions(db, now) {
  if (now < FIRST_SEASON_START) return;
  const boundary = competitionSeason(now).starts_at;
  const rows = await db
    .prepare(
      "SELECT id,created_at FROM predictions WHERE status='active' AND is_admin_test=0 AND created_at<?",
    )
    .bind(boundary)
    .all();
  for (const p of rows.results) {
    const season = calendarSeason(p.created_at);
    const refundedAt = season.ends_at - 1;
    await db.batch([
      db
        .prepare(
          "UPDATE predictions SET status='refunded',payout=stake,settled_at=?1,updated_at=?1 WHERE id=?2 AND status='active'",
        )
        .bind(refundedAt, p.id),
      db
        .prepare(
          "INSERT OR IGNORE INTO transactions(user_id,amount,type,ref,created_at) SELECT user_id,stake,'refund','prediction:'||id,?1 FROM predictions WHERE id=?2 AND status='refunded' AND settled_at=?1 AND NOT EXISTS(SELECT 1 FROM transactions WHERE type='refund' AND ref='prediction:'||?2)",
        )
        .bind(refundedAt, p.id),
      db
        .prepare(
          "INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,reason) SELECT 'prediction_cancellation',id,'owner-approved season policy',json_object('season_id',?1,'status',status,'refunded_at',?2),?3,'Unsettled at season boundary; refund belongs to old season' FROM predictions WHERE id=?4 AND status='refunded' AND settled_at=?2 AND NOT EXISTS(SELECT 1 FROM content_versions WHERE kind='prediction_cancellation' AND target_id=?4)",
        )
        .bind(season.id, refundedAt, now, p.id),
    ]);
  }
}
