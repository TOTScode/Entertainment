// Викторины: очередь со сменой в 00:00 по Москве, вопросы с медиа, текстовые ответы и награды в BIST.
// Правильные варианты ответа уходят в приложение только после окончания викторины.

import { toBist, toUnits } from "./money.js";

const MSK = 3 * 3600; // Москва: UTC+3 без перехода на летнее время
const DAY = 86400;
const GRACE = 5; // секунд запаса на задержку сети при ответе с таймером
export const QUALIFY_BIST = 100; // порог квалификации в финальную викторину сезона
export const DEFAULT_SETTINGS = { every_days: 1, time_limit: 60, attempts: 1 };
const SETTINGS_KEY = "quiz_settings";
const PAST_LIMIT = 10;

export class QuizError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// Следующая полночь по Москве после момента t
export const nextMidnight = (t) => (Math.floor((t + MSK) / DAY) + 1) * DAY - MSK;

// Ответ сравнивается без учёта регистра, «ё», знаков препинания и лишних пробелов
export function normalizeAnswer(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const isCorrect = (answer, variants) => {
  const a = normalizeAnswer(answer);
  return a !== "" && variants.some((v) => normalizeAnswer(v) === a);
};

function parseSettings(row) {
  const s = { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  return { every_days: s.every_days, time_limit: s.time_limit, attempts: s.attempts };
}

export async function getSettings(db) {
  return parseSettings(await db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SETTINGS_KEY).first());
}

export function validateSettings(body) {
  const s = {
    every_days: Number(body.every_days),
    time_limit: Number(body.time_limit),
    attempts: Number(body.attempts),
  };
  if (!Number.isInteger(s.every_days) || s.every_days < 1 || s.every_days > 30) throw new QuizError("Смена викторины — раз в 1–30 дней", 400);
  if (!Number.isInteger(s.time_limit) || s.time_limit < 0 || s.time_limit > 3600) throw new QuizError("Время на вопрос — от 0 (без таймера) до 3600 секунд", 400);
  if (!Number.isInteger(s.attempts) || s.attempts < 1 || s.attempts > 10) throw new QuizError("Попыток на вопрос — от 1 до 10", 400);
  return s;
}

// Расписание очереди: текущая викторина не меняется, следующие идут за ней по порядку.
// Если сейчас ничего не идёт, первая в очереди начинается сразу и идёт до ближайшей полуночи (+ дни сверх первого).
export function scheduleQueue(rows, everyDays, now) {
  const current = rows.find((q) => q.starts_at != null && q.starts_at <= now && q.ends_at > now);
  let cursor = current ? current.ends_at : null;
  const plan = [];
  for (const q of rows) {
    if (q === current) continue;
    const start = cursor ?? now;
    const end = cursor == null ? nextMidnight(now) + (everyDays - 1) * DAY : cursor + everyDays * DAY;
    plan.push({ id: q.id, starts_at: start, ends_at: end });
    cursor = end;
  }
  return plan;
}

// Пересчитывает время показа всех викторин в очереди (после добавления, удаления, перестановки, смены частоты)
export async function rescheduleStatements(db, now, everyDays) {
  const { results } = await db
    .prepare("SELECT id, starts_at, ends_at FROM quizzes WHERE ends_at IS NULL OR ends_at > ? ORDER BY position, id")
    .bind(now)
    .all();
  return scheduleQueue(results, everyDays, now).map((p) =>
    db.prepare("UPDATE quizzes SET starts_at = ?, ends_at = ? WHERE id = ?").bind(p.starts_at, p.ends_at, p.id),
  );
}

const mediaOf = (q) => (q.media_token ? { url: `/media/${q.media_token}`, kind: q.media_kind, name: q.media_name } : null);

const QUESTION_SQL =
  "SELECT q.*, m.token AS media_token, m.kind AS media_kind, m.name AS media_name FROM quiz_questions q " +
  "LEFT JOIN media m ON m.id = q.media_id";

// Состояние вопроса для игрока. Текст и медиа — только после открытия, правильные варианты — только после окончания.
function playerQuestion(q, a, settings, ended, now) {
  const opened = Boolean(a);
  const deadline = opened && settings.time_limit ? a.opened_at + settings.time_limit : null;
  const attemptsLeft = a ? (a.correct ? 0 : Math.max(0, settings.attempts - a.attempts)) : settings.attempts;
  const expired = deadline != null && now > deadline + GRACE;
  const out = {
    id: q.id,
    position: q.position,
    opened,
    correct: Boolean(a?.correct),
    answer: a?.answer ?? null,
    attempts_left: expired ? 0 : attemptsLeft,
    deadline,
    done: Boolean(a?.correct) || attemptsLeft === 0 || expired,
  };
  if (opened || ended) Object.assign(out, { text: q.text, media: mediaOf(q) });
  if (ended) out.answers = JSON.parse(q.answers);
  return out;
}

// Вкладка «Викторины»: текущая викторина, прошлые с моими результатами, настройки — одно обращение к базе
export async function quizState(db, userId, now) {
  const [current, questions, mine, settings, past] = await db.batch([
    db.prepare("SELECT * FROM quizzes WHERE starts_at <= ?1 AND ends_at > ?1 ORDER BY starts_at LIMIT 1").bind(now),
    db.prepare(`${QUESTION_SQL} WHERE q.quiz_id = (SELECT id FROM quizzes WHERE starts_at <= ?1 AND ends_at > ?1 ORDER BY starts_at LIMIT 1) ORDER BY q.position`).bind(now),
    db
      .prepare(
        "SELECT a.* FROM quiz_answers a JOIN quiz_questions q ON q.id = a.question_id " +
        "WHERE a.user_id = ?2 AND q.quiz_id = (SELECT id FROM quizzes WHERE starts_at <= ?1 AND ends_at > ?1 ORDER BY starts_at LIMIT 1)",
      )
      .bind(now, userId),
    db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SETTINGS_KEY),
    db
      .prepare(
        "SELECT z.id, z.title, z.starts_at, z.ends_at, COUNT(q.id) AS total, " +
        "(SELECT COUNT(*) FROM quiz_answers a JOIN quiz_questions q2 ON q2.id = a.question_id WHERE q2.quiz_id = z.id AND a.user_id = ?2 AND a.correct = 1) AS right_count " +
        `FROM quizzes z LEFT JOIN quiz_questions q ON q.quiz_id = z.id WHERE z.ends_at <= ?1 GROUP BY z.id ORDER BY z.ends_at DESC LIMIT ${PAST_LIMIT}`,
      )
      .bind(now, userId),
  ]);
  const s = parseSettings(settings.results[0]);
  const z = current.results[0];
  const answers = new Map(mine.results.map((a) => [a.question_id, a]));
  return {
    now,
    qualify: QUALIFY_BIST,
    settings: { time_limit: s.time_limit, attempts: s.attempts },
    current: z
      ? {
        id: z.id,
        title: z.title,
        reward: toBist(z.reward),
        ends_at: z.ends_at,
        questions: questions.results.map((q) => playerQuestion(q, answers.get(q.id), s, false, now)),
      }
      : null,
    past: past.results.map((p) => ({ id: p.id, title: p.title, ends_at: p.ends_at, total: p.total, right: p.right_count })),
  };
}

// Прошедшая викторина с правильными ответами и моими ответами
export async function pastQuiz(db, userId, quizId, now) {
  const [quiz, questions, mine, settings] = await db.batch([
    db.prepare("SELECT * FROM quizzes WHERE id = ?").bind(quizId),
    db.prepare(`${QUESTION_SQL} WHERE q.quiz_id = ? ORDER BY q.position`).bind(quizId),
    db.prepare("SELECT a.* FROM quiz_answers a JOIN quiz_questions q ON q.id = a.question_id WHERE q.quiz_id = ? AND a.user_id = ?").bind(quizId, userId),
    db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SETTINGS_KEY),
  ]);
  const z = quiz.results[0];
  if (!z || z.starts_at == null || z.starts_at > now) throw new QuizError("Викторина не найдена", 404);
  const ended = z.ends_at <= now;
  const s = parseSettings(settings.results[0]);
  const answers = new Map(mine.results.map((a) => [a.question_id, a]));
  return {
    now,
    id: z.id,
    title: z.title,
    reward: toBist(z.reward),
    ends_at: z.ends_at,
    ended,
    questions: questions.results.map((q) => playerQuestion(q, answers.get(q.id), s, ended, now)),
  };
}

async function loadQuestion(db, userId, questionId, now) {
  const [q, a, settings] = await db.batch([
    db
      .prepare(`${QUESTION_SQL.replace("SELECT q.*", "SELECT q.*, z.starts_at, z.ends_at, z.reward")} JOIN quizzes z ON z.id = q.quiz_id WHERE q.id = ?`)
      .bind(questionId),
    db.prepare("SELECT * FROM quiz_answers WHERE user_id = ? AND question_id = ?").bind(userId, questionId),
    db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SETTINGS_KEY),
  ]);
  const question = q.results[0];
  if (!question || question.starts_at == null || question.starts_at > now) throw new QuizError("Вопрос не найден", 404);
  if (question.ends_at <= now) throw new QuizError("Эта викторина уже закончилась");
  return { question, answer: a.results[0] || null, settings: parseSettings(settings.results[0]) };
}

// Открыть вопрос: с этого момента идёт время на ответ
export async function openQuestion(db, userId, questionId, now) {
  const { question, answer, settings } = await loadQuestion(db, userId, questionId, now);
  let a = answer;
  if (!a) {
    await db
      .prepare("INSERT INTO quiz_answers (user_id, question_id, opened_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(userId, questionId, now)
      .run();
    a = { opened_at: now, attempts: 0, correct: 0, answer: null };
  }
  return { now, question: playerQuestion(question, a, settings, false, now) };
}

// Ответ на вопрос. Попытки, время и однократность награды проверяются в одной операции базы.
export async function answerQuestion(db, userId, questionId, text, now) {
  const answer = String(text ?? "").trim().slice(0, 200);
  if (!answer) throw new QuizError("Введите ответ", 400);
  const { question, answer: row, settings } = await loadQuestion(db, userId, questionId, now);
  if (!row) throw new QuizError("Сначала откройте вопрос", 400);
  const state = playerQuestion(question, row, settings, false, now);
  if (row.correct) throw new QuizError("Вы уже ответили правильно");
  if (state.deadline != null && now > state.deadline + GRACE) throw new QuizError("Время на ответ вышло");
  if (state.attempts_left <= 0) throw new QuizError("Попытки закончились");

  const correct = isCorrect(answer, JSON.parse(question.answers)) ? 1 : 0;
  const limit = settings.time_limit ? row.opened_at + settings.time_limit + GRACE : Number.MAX_SAFE_INTEGER;
  const results = await db.batch([
    db
      .prepare(
        "UPDATE quiz_answers SET attempts = attempts + 1, correct = ?, answer = ?, answered_at = ? " +
        "WHERE user_id = ? AND question_id = ? AND correct = 0 AND attempts < ? AND ? <= ?",
      )
      .bind(correct, answer, now, userId, questionId, settings.attempts, now, limit),
    // Награда — только если правильный ответ записан; повторно не начисляется (уникальный индекс)
    db
      .prepare(
        "INSERT OR IGNORE INTO transactions (user_id, amount, type, ref, created_at) " +
        "SELECT ?1, ?2, 'quiz_reward', 'quiz_question:' || ?3, ?4 " +
        "WHERE ?2 > 0 AND EXISTS (SELECT 1 FROM quiz_answers WHERE user_id = ?1 AND question_id = ?3 AND correct = 1)",
      )
      .bind(userId, question.reward, questionId, now),
    db.prepare("SELECT * FROM quiz_answers WHERE user_id = ? AND question_id = ?").bind(userId, questionId),
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE user_id = ?").bind(userId),
  ]);
  if (!results[0].meta.changes) throw new QuizError("Ответ уже принят, обновите экран");
  const saved = results[2].results[0];
  return {
    now,
    correct: Boolean(saved.correct),
    reward: saved.correct ? toBist(question.reward) : 0,
    balance: toBist(results[3].results[0].balance),
    question: playerQuestion(question, saved, settings, false, now),
  };
}

// --- админка ---

function validateQuiz(body) {
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!title) throw new QuizError("Укажите название викторины", 400);
  const reward = Number(body.reward ?? 1);
  if (!Number.isFinite(reward) || reward < 0 || reward > 100 || !Number.isInteger(Math.round(reward * 1e6) / 1e5)) {
    throw new QuizError("Награда — от 0 до 100 BIST за ответ, не больше одного знака после запятой", 400);
  }
  const questions = Array.isArray(body.questions) ? body.questions : [];
  if (!questions.length) throw new QuizError("Добавьте хотя бы один вопрос", 400);
  if (questions.length > 50) throw new QuizError("Не больше 50 вопросов в викторине", 400);
  const clean = questions.map((q, i) => {
    const text = String(q.text ?? "").trim().slice(0, 2000);
    const answers = (Array.isArray(q.answers) ? q.answers : String(q.answers ?? "").split("\n"))
      .map((a) => String(a).trim().slice(0, 200))
      .filter((a) => normalizeAnswer(a));
    if (!text && !q.media_id) throw new QuizError(`Вопрос ${i + 1}: нужен текст или файл`, 400);
    if (!answers.length) throw new QuizError(`Вопрос ${i + 1}: укажите хотя бы один правильный ответ`, 400);
    return { id: Number(q.id) || null, text, media_id: Number(q.media_id) || null, answers: [...new Set(answers)].slice(0, 20) };
  });
  return { title, reward: toUnits(reward), questions: clean };
}

export async function adminQuizzes(db, now) {
  const [quizzes, questions, settings, stats] = await db.batch([
    db.prepare("SELECT * FROM quizzes WHERE ends_at IS NULL OR ends_at > ?1 - 30 * 86400 ORDER BY position, id").bind(now),
    db.prepare(`${QUESTION_SQL} JOIN quizzes z ON z.id = q.quiz_id WHERE z.ends_at IS NULL OR z.ends_at > ?1 - 30 * 86400 ORDER BY q.quiz_id, q.position`).bind(now),
    db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SETTINGS_KEY),
    db
      .prepare(
        "SELECT q.quiz_id, COUNT(DISTINCT a.user_id) AS players, SUM(a.correct) AS right_count FROM quiz_answers a " +
        "JOIN quiz_questions q ON q.id = a.question_id JOIN quizzes z ON z.id = q.quiz_id WHERE z.ends_at > ?1 - 30 * 86400 GROUP BY q.quiz_id",
      )
      .bind(now),
  ]);
  const byQuiz = new Map();
  for (const q of questions.results) {
    if (!byQuiz.has(q.quiz_id)) byQuiz.set(q.quiz_id, []);
    byQuiz.get(q.quiz_id).push({ id: q.id, text: q.text, media_id: q.media_id, media: mediaOf(q), answers: JSON.parse(q.answers) });
  }
  const st = new Map(stats.results.map((r) => [r.quiz_id, r]));
  return {
    now,
    settings: parseSettings(settings.results[0]),
    quizzes: quizzes.results.map((z) => ({
      id: z.id,
      title: z.title,
      reward: toBist(z.reward),
      starts_at: z.starts_at,
      ends_at: z.ends_at,
      status: z.ends_at <= now ? "ended" : z.starts_at <= now ? "current" : "queued",
      players: st.get(z.id)?.players || 0,
      right: st.get(z.id)?.right_count || 0,
      questions: byQuiz.get(z.id) || [],
    })),
  };
}

function questionStatements(db, quizId, questions) {
  return questions.map((q, i) =>
    q.id
      ? db
        .prepare("UPDATE quiz_questions SET position = ?, text = ?, media_id = ?, answers = ? WHERE id = ? AND quiz_id = ?")
        .bind(i + 1, q.text, q.media_id, JSON.stringify(q.answers), q.id, quizId)
      : db
        .prepare("INSERT INTO quiz_questions (quiz_id, position, text, media_id, answers) VALUES (?, ?, ?, ?, ?)")
        .bind(quizId, i + 1, q.text, q.media_id, JSON.stringify(q.answers)),
  );
}

export async function createQuiz(db, adminId, body, now) {
  const quiz = validateQuiz(body);
  const settings = await getSettings(db);
  const res = await db
    .prepare(
      "INSERT INTO quizzes (title, reward, position, created_by, created_at, updated_at) " +
      "VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM quizzes), ?, ?, ?)",
    )
    .bind(quiz.title, quiz.reward, adminId, now, now)
    .run();
  const id = res.meta.last_row_id;
  await db.batch([
    ...questionStatements(db, id, quiz.questions.map((q) => ({ ...q, id: null }))),
    ...(await rescheduleStatements(db, now, settings.every_days)),
  ]);
  return id;
}

async function getQuiz(db, id, now) {
  const z = await db.prepare("SELECT * FROM quizzes WHERE id = ?").bind(id).first();
  if (!z) throw new QuizError("Викторина не найдена", 404);
  if (z.ends_at != null && z.ends_at <= now) throw new QuizError("Викторина уже закончилась, её нельзя менять");
  return z;
}

// Правка викторины до её окончания. Удалённые вопросы удаляются вместе с ответами игроков.
export async function updateQuiz(db, id, body, now) {
  await getQuiz(db, id, now);
  const quiz = validateQuiz(body);
  const keep = quiz.questions.filter((q) => q.id).map((q) => q.id);
  const gone = `quiz_id = ? AND id NOT IN (${keep.map(() => "?").join(",") || "NULL"})`;
  await db.batch([
    db.prepare("UPDATE quizzes SET title = ?, reward = ?, updated_at = ? WHERE id = ?").bind(quiz.title, quiz.reward, now, id),
    db.prepare(`DELETE FROM quiz_answers WHERE question_id IN (SELECT id FROM quiz_questions WHERE ${gone})`).bind(id, ...keep),
    db.prepare(`DELETE FROM quiz_questions WHERE ${gone}`).bind(id, ...keep),
    ...questionStatements(db, id, quiz.questions),
  ]);
}

// Удалить викторину из очереди. Текущую — снять: она заканчивается сейчас, следующая начинается сразу.
export async function deleteQuiz(db, id, now) {
  const z = await getQuiz(db, id, now);
  const settings = await getSettings(db);
  if (z.starts_at != null && z.starts_at <= now) {
    await db.prepare("UPDATE quizzes SET ends_at = ?, updated_at = ? WHERE id = ?").bind(now, now, id).run();
  } else {
    await db.batch([
      db.prepare("DELETE FROM quiz_questions WHERE quiz_id = ?").bind(id),
      db.prepare("DELETE FROM quizzes WHERE id = ?").bind(id),
    ]);
  }
  await db.batch(await rescheduleStatements(db, now, settings.every_days));
}

// Поднять или опустить викторину в очереди (только ещё не начавшиеся)
export async function moveQuiz(db, id, dir, now) {
  const z = await getQuiz(db, id, now);
  if (z.starts_at <= now) throw new QuizError("Текущую викторину нельзя переставить");
  const settings = await getSettings(db);
  const neighbor = await db
    .prepare(
      dir === "up"
        ? "SELECT id, position FROM quizzes WHERE position < ? AND starts_at > ? ORDER BY position DESC LIMIT 1"
        : "SELECT id, position FROM quizzes WHERE position > ? AND starts_at > ? ORDER BY position LIMIT 1",
    )
    .bind(z.position, now)
    .first();
  if (!neighbor) return;
  await db.batch([
    db.prepare("UPDATE quizzes SET position = ? WHERE id = ?").bind(neighbor.position, z.id),
    db.prepare("UPDATE quizzes SET position = ? WHERE id = ?").bind(z.position, neighbor.id),
  ]);
  await db.batch(await rescheduleStatements(db, now, settings.every_days));
}

export async function saveSettings(db, body, now) {
  const s = validateSettings(body);
  await db
    .prepare("INSERT INTO api_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(SETTINGS_KEY, JSON.stringify(s), now)
    .run();
  await db.batch(await rescheduleStatements(db, now, s.every_days));
  return s;
}

// --- медиа через Telegram ---

const MAX_MEDIA = 20 * 1024 * 1024; // Bot API отдаёт файлы до 20 МБ

export function mediaKind(mime) {
  if (/^image\//.test(mime)) return "image";
  if (/^audio\//.test(mime)) return "audio";
  if (/^video\//.test(mime)) return "video";
  return "file";
}

// Файл отправляется администратору в чат с ботом, сохраняется file_id, сообщение удаляется
export async function uploadMedia(db, botToken, adminId, file, now) {
  if (!file || typeof file === "string") throw new QuizError("Выберите файл", 400);
  if (file.size > MAX_MEDIA) throw new QuizError("Файл больше 20 МБ", 400);
  const form = new FormData();
  form.append("chat_id", String(adminId));
  form.append("disable_content_type_detection", "true");
  form.append("disable_notification", "true");
  form.append("document", file, file.name || "file");
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new QuizError(
      /chat not found|bot was blocked/i.test(data.description || "")
        ? "Откройте чат с ботом и нажмите «Старт», чтобы загружать файлы"
        : `Telegram не принял файл: ${data.description || res.status}`,
      502,
    );
  }
  const msg = data.result;
  const doc = msg.document || msg.video || msg.audio || msg.animation || msg.voice || msg.photo?.at(-1);
  if (!doc?.file_id) throw new QuizError("Telegram не вернул файл", 502);
  fetch(`https://api.telegram.org/bot${botToken}/deleteMessage?chat_id=${adminId}&message_id=${msg.message_id}`).catch(() => {});
  const mime = file.type || doc.mime_type || "application/octet-stream";
  const token = crypto.randomUUID().replace(/-/g, "");
  const row = await db
    .prepare("INSERT INTO media (token, file_id, kind, mime, name, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(token, doc.file_id, mediaKind(mime), mime, file.name || null, file.size, adminId, now)
    .first();
  return { id: row.id, url: `/media/${token}`, kind: mediaKind(mime), name: file.name || null };
}

// Отдаёт файл из Telegram по token. Поддерживает Range для перемотки аудио и видео.
export async function serveMedia(db, botToken, token, request) {
  const m = await db.prepare("SELECT * FROM media WHERE token = ?").bind(token).first();
  if (!m) return new Response("Not found", { status: 404 });
  const info = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(m.file_id)}`).then((r) => r.json());
  if (!info.ok) return new Response("Not available", { status: 502 });
  const headers = {};
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const file = await fetch(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`, { headers });
  const out = new Headers();
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) if (file.headers.get(h)) out.set(h, file.headers.get(h));
  out.set("Content-Type", m.mime || "application/octet-stream");
  out.set("Cache-Control", "private, max-age=86400");
  if (!out.has("Accept-Ranges")) out.set("Accept-Ranges", "bytes");
  return new Response(file.body, { status: file.status, headers: out });
}

