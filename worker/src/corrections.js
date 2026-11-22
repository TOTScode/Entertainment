import { SeasonError, freezeDue, audit } from "./seasons.js";
export async function requireFrozenDecision(db, body, now) {
  await freezeDue(db, now);
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM seasons WHERE qualification_frozen_at IS NOT NULL")
    .first();
  if (r.n && (!body.retain_frozen_admissions || !String(body.post_freeze_reason || "").trim()))
    throw new SeasonError(
      "После фиксации финалистов подтвердите отдельное решение сохранить допуски с причиной; изменить допуск можно только отдельным решением администратора",
    );
}
export async function voidQuestion(db, id, body, admin, now) {
  if (!String(body.reason || "").trim()) throw new SeasonError("Укажите причину отмены", 400);
  await requireFrozenDecision(db, body, now);
  const q = await db.prepare("SELECT * FROM quiz_questions WHERE id=?").bind(id).first();
  if (!q) throw new SeasonError("Вопрос не найден", 404);
  if (q.voided_at) return { already_voided: true };
  await db.batch([
    db
      .prepare("UPDATE quiz_questions SET voided_at=?,version=version+1 WHERE id=? AND voided_at IS NULL")
      .bind(now, id),
    db
      .prepare(
        `INSERT OR IGNORE INTO transactions(user_id,amount,type,ref,created_at)
 SELECT user_id,-amount,'quiz_reward_reversal',ref,?1 FROM transactions WHERE type='quiz_reward' AND ref LIKE 'quiz_question:%' AND CAST(substr(ref,15) AS INTEGER)=?2`,
      )
      .bind(now, id),
    db
      .prepare(
        "INSERT INTO audit_log(admin_id,action,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        admin,
        "question_void",
        body.reason,
        JSON.stringify(q),
        JSON.stringify({
          voided_at: now,
          post_freeze_reason: body.post_freeze_reason || null,
          retain_frozen_admissions: Boolean(body.retain_frozen_admissions),
        }),
        now,
      ),
  ]);
  return { voided: true };
}
export async function decideFinalist(db, seasonId, body, admin, now) {
  const rules = await db
    .prepare("SELECT qualification_frozen_at AS frozen_at FROM seasons WHERE id=?")
    .bind(seasonId)
    .first();
  if (
    !rules?.frozen_at ||
    typeof body.admitted !== "boolean" ||
    !Number.isSafeInteger(body.user_id) ||
    !String(body.reason || "").trim()
  )
    throw new SeasonError("Нужны зафиксированный сезон, участник, решение и причина", 400);
  const user = await db.prepare("SELECT id FROM users WHERE id=?").bind(body.user_id).first();
  if (!user) throw new SeasonError("Участник не найден", 404);
  await db.batch([
    db
      .prepare(
        "INSERT INTO finalist_decisions(season_id,user_id,admitted,reason,admin_id,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(seasonId, body.user_id, Number(body.admitted), body.reason, admin, now),
    db
      .prepare(
        "INSERT INTO audit_log(admin_id,action,target_user_id,reason,after_data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        admin,
        "finalist_decision",
        body.user_id,
        body.reason,
        JSON.stringify({ season_id: seasonId, admitted: body.admitted }),
        now,
      ),
  ]);
  return { ok: true };
}
