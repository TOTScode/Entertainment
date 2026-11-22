import { SeasonError } from "./seasons.js";
export async function activePolicy(db) {
  const r = await db
    .prepare(
      "SELECT version,body FROM policy_documents WHERE published_at IS NOT NULL ORDER BY published_at DESC,version DESC LIMIT 1",
    )
    .first();
  return r ? { ...JSON.parse(r.body), version: r.version } : null;
}
export function validatePolicy(p) {
  const keys = [
    "operator",
    "contacts",
    "policy_text",
    "purposes",
    "legal_bases",
    "retention",
    "rights",
    "publication_consent",
    "avatar_consent",
    "marketing_consent",
    "processing_consent",
    "operator_address",
    "personal_data",
    "operations",
    "withdrawal",
    "cross_border_basis",
    "age_requirements",
  ];
  if (
    keys.some((k) => typeof p[k] !== "string" || !p[k].trim()) ||
    !Array.isArray(p.services) ||
    !p.services.length ||
    p.services.some(
      (s) =>
        !s.name ||
        !s.purpose ||
        !Array.isArray(s.countries) ||
        !s.countries.length ||
        s.countries.some((c) => !String(c).trim()),
    ) ||
    p.legal_review_confirmed !== true ||
    !["consent", "contract", "statutory"].includes(p.processing_basis) ||
    typeof p.processing_legal_reference !== "string" ||
    !p.processing_legal_reference.trim()
  )
    throw new SeasonError(
      "Заполните оператора, контакты, политику, основания, сроки, согласия, сервисы и подтверждённые страны; нужна правовая проверка",
      400,
    );
}
export async function preferences(db, id) {
  return db
    .prepare("SELECT public_profile,public_avatar,marketing_opt_in,marketing_opt_out FROM users WHERE id=?")
    .bind(id)
    .first();
}
export async function savePreferences(db, id, body, now) {
  const old = await preferences(db, id);
  if (!old) throw new SeasonError("Пользователь не найден", 404);
  const policy = await activePolicy(db);
  const keys = ["public_profile", "public_avatar", "marketing_opt_in"];
  for (const k of [...keys, "marketing_opt_out"])
    if (k in body && typeof body[k] !== "boolean")
      throw new SeasonError("Настройки должны иметь значение true/false", 400);
  if (
    keys.some((k) => body[k] === true) &&
    (!policy || body.policy_version !== policy.version || body.confirm_consent !== true)
  )
    throw new SeasonError("Сначала прочитайте действующую политику и подтвердите отдельные согласия", 400);
  const next = Object.fromEntries(keys.map((k) => [k, k in body ? Number(body[k]) : old[k]]));
  next.marketing_opt_out =
    "marketing_opt_out" in body ? Number(body.marketing_opt_out) : old.marketing_opt_out;
  if (next.marketing_opt_out) next.marketing_opt_in = 0;
  if (!next.public_profile) next.public_avatar = 0;
  await db.batch([
    db
      .prepare(
        "UPDATE users SET public_profile=?,public_avatar=?,marketing_opt_in=?,marketing_opt_out=? WHERE id=?",
      )
      .bind(next.public_profile, next.public_avatar, next.marketing_opt_in, next.marketing_opt_out, id),
    ...[...keys, "marketing_opt_out"]
      .filter((k) => next[k] !== old[k])
      .map((k) =>
        db
          .prepare(
            "INSERT INTO privacy_events(user_id,purpose,granted,policy_version,created_at) VALUES(?,?,?,?,?)",
          )
          .bind(id, k, next[k], policy?.version || null, now),
      ),
  ]);
  return next;
}
export async function createRequest(db, id, b, now) {
  if (
    !["quiz_error", "prediction_error", "data_correction", "data_deletion", "privacy_question"].includes(
      b.kind,
    )
  )
    throw new SeasonError("Выберите тип обращения", 400);
  const message = String(b.message || "").trim();
  if (!message || message.length > 4000) throw new SeasonError("Опишите обращение (до 4000 символов)", 400);
  const result = await db
    .prepare(
      "INSERT INTO user_requests(user_id,kind,target_type,target_id,message,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      id,
      b.kind,
      b.kind === "quiz_error" ? "question" : b.kind === "prediction_error" ? "match" : null,
      Number.isSafeInteger(b.target_id) ? b.target_id : null,
      message,
      now,
    )
    .run();
  return { id: result.meta.last_row_id, status: "open" };
}
export async function processingConsent(db, id, policy) {
  if (!policy || policy.processing_basis !== "consent") return true;
  const row = await db
    .prepare(
      "SELECT granted,policy_version FROM privacy_events WHERE user_id=? AND purpose='processing' ORDER BY id DESC LIMIT 1",
    )
    .bind(id)
    .first();
  return Boolean(row?.granted && row.policy_version === policy.version);
}
export async function recordProcessingConsent(db, id, b, policy, now) {
  if (typeof b.granted !== "boolean") throw new SeasonError("Выберите согласие или отзыв", 400);
  if (b.granted && (!policy || b.policy_version !== policy.version || b.confirm_consent !== true))
    throw new SeasonError("Прочитайте действующую политику и подтвердите согласие", 400);
  const statements = [
    db
      .prepare(
        "INSERT INTO privacy_events(user_id,purpose,granted,policy_version,created_at) VALUES(?,'processing',?,?,?)",
      )
      .bind(id, Number(b.granted), policy?.version || null, now),
  ];
  if (!b.granted) {
    statements.push(
      db.prepare("UPDATE users SET public_profile=0,public_avatar=0,marketing_opt_in=0 WHERE id=?").bind(id),
    );
    for (const purpose of ["public_profile", "public_avatar", "marketing_opt_in"])
      statements.push(
        db
          .prepare(
            "INSERT INTO privacy_events(user_id,purpose,granted,policy_version,created_at) VALUES(?,?,0,?,?)",
          )
          .bind(id, purpose, policy?.version || null, now),
      );
  }
  await db.batch(statements);
  return { granted: b.granted };
}
