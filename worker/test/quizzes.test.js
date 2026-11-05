import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { UNIT } from "../src/money.js";
import {
  answerQuestion, createQuiz, deleteQuiz, isCorrect, moveQuiz, nextMidnight, openQuestion, pastQuiz, quizState, saveSettings,
  scheduleQueue, updateQuiz,
} from "../src/quizzes.js";
import { createDb, roundTrips } from "./fake-d1.js";

// 1_800_000_000 — 15.01.2027 08:00 UTC, то есть 11:00 по Москве
const NOW = 1_800_000_000;
const MIDNIGHT = nextMidnight(NOW); // 16.01 00:00 МСК
let db;

const balance = (id) => db.raw.prepare("SELECT SUM(amount) AS b FROM transactions WHERE user_id = ?").get(id).b / UNIT;
const quiz = (id) => db.raw.prepare("SELECT * FROM quizzes WHERE id = ?").get(id);
const qid = (quizId, n = 1) => db.raw.prepare("SELECT id FROM quiz_questions WHERE quiz_id = ? AND position = ?").get(quizId, n).id;

function addUser(id, bist = 10) {
  db.raw.prepare("INSERT INTO users (id, first_name, created_at) VALUES (?, ?, 0)").run(id, `U${id}`);
  db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, 'signup_bonus', 0)").run(id, bist * UNIT);
}

const make = (title, at = NOW, extra = {}) =>
  createQuiz(db, 1, {
    title,
    reward: 2,
    questions: [
      { text: "Кто забил в финале ЛЧ 2005?", answers: "Джеррард\nСтивен Джеррард\nGerrard" },
      { text: "Год основания «Спартака»?", answers: ["1922"] },
    ],
    ...extra,
  }, at);

beforeEach(() => {
  db = createDb();
  addUser(1);
  addUser(2);
});

test("ответ: без учёта регистра, ё, пробелов и знаков препинания, по любому варианту", () => {
  const v = ["Джеррард", "Стивен Джеррард", "Gerrard"];
  assert.ok(isCorrect("  СТИВЕН   джеррард ", v));
  assert.ok(isCorrect("gerrard!", v));
  assert.ok(isCorrect("Королёв", ["Королев"]));
  assert.ok(!isCorrect("Лэмпард", v));
  assert.ok(!isCorrect("   ", v));
});

test("очередь: первая начинается сразу, следующие — с полуночи по Москве, раз в N дней", async () => {
  assert.equal(new Date((MIDNIGHT + 3 * 3600) * 1000).toISOString(), "2027-01-16T00:00:00.000Z");
  const a = await make("A");
  const b = await make("B");
  const c = await make("C");
  assert.deepEqual([quiz(a).starts_at, quiz(a).ends_at], [NOW, MIDNIGHT]);
  assert.deepEqual([quiz(b).starts_at, quiz(b).ends_at], [MIDNIGHT, MIDNIGHT + 86400]);
  assert.equal(quiz(c).starts_at, MIDNIGHT + 86400);

  // Раз в 2 дня: текущая не меняется, следующие сдвигаются
  await saveSettings(db, { every_days: 2, time_limit: 60, attempts: 1 }, NOW + 60);
  assert.equal(quiz(a).ends_at, MIDNIGHT);
  assert.deepEqual([quiz(b).starts_at, quiz(b).ends_at], [MIDNIGHT, MIDNIGHT + 2 * 86400]);
  assert.equal(quiz(c).starts_at, MIDNIGHT + 2 * 86400);

  // Перестановка и удаление из очереди
  await moveQuiz(db, c, "up", NOW + 60);
  assert.equal(quiz(c).starts_at, MIDNIGHT);
  await deleteQuiz(db, c, NOW + 60);
  assert.equal(quiz(c), undefined);
  assert.equal(quiz(b).starts_at, MIDNIGHT);

  // Снять текущую: следующая начинается сразу
  await deleteQuiz(db, a, NOW + 120);
  assert.equal(quiz(a).ends_at, NOW + 120);
  assert.equal(quiz(b).starts_at, NOW + 120);
  // Пустая очередь после конца: новая начнётся сразу
  assert.deepEqual(scheduleQueue([{ id: 9, starts_at: null, ends_at: null }], 1, NOW), [{ id: 9, starts_at: NOW, ends_at: MIDNIGHT }]);
});

test("прохождение: правильные ответы скрыты, награда один раз, попытки и таймер", async () => {
  const id = await make("A");
  roundTrips.count = 0;
  const state = await quizState(db, 1, NOW);
  assert.equal(roundTrips.count, 1);
  assert.equal(state.current.title, "A");
  assert.equal(state.current.reward, 2);
  // До открытия нет ни текста, ни ответов
  assert.equal(state.current.questions[0].text, undefined);
  assert.equal(JSON.stringify(state).includes("Джеррард"), false);

  const q1 = qid(id, 1);
  const opened = await openQuestion(db, 1, q1, NOW);
  assert.equal(opened.question.text, "Кто забил в финале ЛЧ 2005?");
  assert.equal(opened.question.deadline, NOW + 60);
  assert.equal(opened.question.answers, undefined);
  // Повторное открытие не сбрасывает время
  assert.equal((await openQuestion(db, 1, q1, NOW + 30)).question.deadline, NOW + 60);

  const res = await answerQuestion(db, 1, q1, "стивен ДЖЕРРАРД", NOW + 20);
  assert.equal(res.correct, true);
  assert.equal(res.balance, 12);
  await assert.rejects(answerQuestion(db, 1, q1, "Джеррард", NOW + 25), /уже ответили/);
  assert.equal(balance(1), 12);

  // Неправильный ответ тратит единственную попытку
  const q2 = qid(id, 2);
  await assert.rejects(answerQuestion(db, 1, q2, "1922", NOW), /Сначала откройте/);
  await openQuestion(db, 1, q2, NOW);
  assert.equal((await answerQuestion(db, 1, q2, "1921", NOW + 10)).correct, false);
  await assert.rejects(answerQuestion(db, 1, q2, "1922", NOW + 20), /Попытки закончились/);

  // Время вышло
  await openQuestion(db, 2, q1, NOW);
  await assert.rejects(answerQuestion(db, 2, q1, "Gerrard", NOW + 66), /Время/);
  assert.equal(balance(2), 10);

  // Правильные варианты видны после окончания викторины
  assert.equal((await pastQuiz(db, 1, id, NOW + 100)).questions[0].answers, undefined);
  const past = await pastQuiz(db, 1, id, MIDNIGHT);
  assert.deepEqual(past.questions[0].answers, ["Джеррард", "Стивен Джеррард", "Gerrard"]);
  assert.equal(past.questions[1].answer, "1921");
  const after = await quizState(db, 1, MIDNIGHT);
  assert.equal(after.current, null);
  assert.deepEqual(after.past.map((p) => [p.title, p.total, p.right]), [["A", 2, 1]]);
});

test("несколько попыток без таймера; правка викторины; история показывает викторину", async () => {
  await saveSettings(db, { every_days: 1, time_limit: 0, attempts: 2 }, NOW);
  const id = await make("Вторая");
  const q = qid(id, 1);
  await openQuestion(db, 1, q, NOW);
  assert.equal((await answerQuestion(db, 1, q, "Лэмпард", NOW + 5000)).question.attempts_left, 1);
  assert.equal((await answerQuestion(db, 1, q, "Gerrard", NOW + 6000)).correct, true);

  // Правка: первый вопрос остаётся, второй заменяется новым
  await updateQuiz(db, id, { title: "Вторая", reward: 1, questions: [{ id: q, text: "Новый текст", answers: "Джеррард" }, { text: "Ещё", answers: "да" }] }, NOW + 7000);
  const rows = db.raw.prepare("SELECT id, text FROM quiz_questions WHERE quiz_id = ? ORDER BY position").all(id);
  assert.equal(rows[0].id, q);
  assert.deepEqual(rows.map((r) => r.text), ["Новый текст", "Ещё"]);
  await assert.rejects(updateQuiz(db, id, { title: "", questions: [] }, NOW), /название/);
  await assert.rejects(createQuiz(db, 1, { title: "X", questions: [{ text: "Вопрос", answers: "" }] }, NOW), /правильный ответ/);

  const { history } = await import("../src/leaderboard.js");
  const h = await history(db, 1);
  assert.deepEqual([h.items[0].type, h.items[0].amount, h.items[0].quiz], ["quiz_reward", 2, "Вторая"]);
});
