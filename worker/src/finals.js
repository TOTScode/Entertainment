import { SeasonError, finalistAdmission } from "./seasons.js";
export async function myFinals(db, userId) {
  const r = await db
    .prepare(
      "SELECT season_id,body,frozen_at FROM final_rules WHERE published_at IS NOT NULL AND season_id IN(SELECT id FROM seasons WHERE starts_at>=1796072400) ORDER BY published_at DESC",
    )
    .all();
  const items = [];
  for (const f of r.results)
    if (f.frozen_at && (await finalistAdmission(db, f.season_id, userId))) {
      const b = JSON.parse(f.body);
      const t = await db
        .prepare("SELECT body,participants FROM final_tiebreaks WHERE season_id=?")
        .bind(f.season_id)
        .first();
      items.push({
        season_id: f.season_id,
        starts_at: b.final_start,
        ends_at: b.final_end,
        attempts: b.attempts,
        tiebreak:
          t && JSON.parse(t.participants).includes(userId)
            ? { starts_at: JSON.parse(t.body).starts_at, ends_at: JSON.parse(t.body).ends_at }
            : null,
      });
    }
  return { items };
}
export async function finalScores(db, seasonId, now) {
  const rule = await db.prepare("SELECT * FROM final_rules WHERE season_id=?").bind(seasonId).first();
  if (!rule?.published_at) throw new SeasonError("Правила не опубликованы", 404);
  const r = JSON.parse(rule.body);
  if (now < r.final_end) throw new SeasonError("Финал ещё идёт");
  const rows = await db
    .prepare(
      "SELECT user_id,MAX(score) AS score,SUM(score IS NULL) AS unreviewed FROM final_submissions WHERE season_id=? GROUP BY user_id ORDER BY score DESC,user_id",
    )
    .bind(seasonId)
    .all();
  const pending = rows.results.some((x) => x.unreviewed > 0);
  const groups = new Map();
  for (const x of rows.results) {
    if (x.score == null) continue;
    const g = groups.get(x.score) || [];
    g.push(x.user_id);
    groups.set(x.score, g);
  }
  const tied = [...groups.values()].filter((g) => g.length > 1).flat();
  const tb = await db.prepare("SELECT * FROM final_tiebreaks WHERE season_id=?").bind(seasonId).first();
  const answers = tb
    ? (
        await db
          .prepare("SELECT user_id,score FROM final_tiebreak_answers WHERE season_id=?")
          .bind(seasonId)
          .all()
      ).results
    : [];
  const tieComplete =
    tied.length === 0 ||
    (tb &&
      now >= JSON.parse(tb.body).ends_at &&
      JSON.parse(tb.participants).length === tied.length &&
      tied.every(
        (id) =>
          JSON.parse(tb.participants).includes(id) &&
          answers.some((a) => a.user_id === id && a.score != null),
      ) &&
      [...groups.values()].every(
        (g) => new Set(g.map((id) => answers.find((a) => a.user_id === id)?.score)).size === g.length,
      ));
  return {
    rows: rows.results.map((x) => ({
      ...x,
      tiebreak_score: answers.find((a) => a.user_id === x.user_id)?.score ?? null,
    })),
    pending_review: pending,
    tied,
    needs_knowledge_tiebreak: !tieComplete,
    ready: rows.results.length > 0 && !pending && Boolean(tieComplete),
  };
}
export async function reviewFinal(db, seasonId, b, admin, now) {
  if (
    !Number.isSafeInteger(b.user_id) ||
    !Number.isFinite(b.score) ||
    b.score < 0 ||
    !String(b.reason || "").trim()
  )
    throw new SeasonError("Нужны участник, оценка и обоснование по критериям", 400);
  const table = b.tiebreak ? "final_tiebreak_answers" : "final_submissions";
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE season_id=? AND user_id=? ${b.tiebreak ? "" : "AND round=?"}`)
    .bind(...(b.tiebreak ? [seasonId, b.user_id] : [seasonId, b.user_id, Number(b.round)]))
    .first();
  if (!row) throw new SeasonError("Ответ не найден", 404);
  await db.batch([
    db
      .prepare(
        `UPDATE ${table} SET score=?,reviewed_by=?,reason=? WHERE season_id=? AND user_id=? ${b.tiebreak ? "" : "AND round=?"}`,
      )
      .bind(...[b.score, admin, b.reason, seasonId, b.user_id, ...(b.tiebreak ? [] : [Number(b.round)])]),
    db
      .prepare(
        "INSERT INTO audit_log(admin_id,action,target_user_id,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(admin, "final_human_review", b.user_id, b.reason, JSON.stringify(row), JSON.stringify(b), now),
  ]);
  return { ok: true };
}
export async function publishTiebreak(db, seasonId, b, admin, now) {
  const scores = await finalScores(db, seasonId, now);
  if (scores.pending_review || !scores.tied.length)
    throw new SeasonError("Сначала оцените все ответы и подтвердите равенство");
  if (
    !b.text ||
    !b.source ||
    !b.rubric ||
    b.human_review_confirmed !== true ||
    !Number.isSafeInteger(b.starts_at) ||
    !Number.isSafeInteger(b.ends_at) ||
    b.starts_at < now ||
    b.ends_at <= b.starts_at
  )
    throw new SeasonError("Нужны проверенное задание на знания, источник, критерии и единый срок", 400);
  const old = await db
    .prepare("SELECT season_id FROM final_tiebreaks WHERE season_id=?")
    .bind(seasonId)
    .first();
  if (old)
    throw new SeasonError("Дополнительное задание уже опубликовано; для пересмотра нужно отдельное решение");
  await db.batch([
    db
      .prepare("INSERT INTO final_tiebreaks VALUES(?,?,?,?,?)")
      .bind(seasonId, JSON.stringify(b), JSON.stringify(scores.tied), now, admin),
    db
      .prepare(
        "INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id,reason) VALUES(?,0,?,?,?,?,?)",
      )
      .bind("final_tiebreak", b.source, JSON.stringify(b), now, admin, "human reviewed knowledge task"),
  ]);
  return { ok: true };
}
export async function tiebreak(db, seasonId, userId, now, answer = null) {
  const row = await db.prepare("SELECT * FROM final_tiebreaks WHERE season_id=?").bind(seasonId).first();
  if (!row || !JSON.parse(row.participants).includes(userId))
    throw new SeasonError("Нет допуска к дополнительному заданию", 403);
  const b = JSON.parse(row.body);
  if (now < b.starts_at || now >= b.ends_at)
    throw new SeasonError("Дополнительное задание сейчас недоступно");
  if (answer !== null) {
    if (typeof answer !== "string" || !answer.trim() || answer.length > 10000)
      throw new SeasonError("Введите ответ", 400);
    try {
      await db
        .prepare("INSERT INTO final_tiebreak_answers(season_id,user_id,answer,submitted_at) VALUES(?,?,?,?)")
        .bind(seasonId, userId, answer, now)
        .run();
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) throw new SeasonError("Ответ уже принят");
      throw e;
    }
    return { submitted: true };
  }
  return { text: b.text, source: b.source, rubric: b.rubric, ends_at: b.ends_at, attempts: 1 };
}
