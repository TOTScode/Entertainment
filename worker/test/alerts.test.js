import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { UNIT } from "../src/money.js";
import { checkAlerts } from "../src/alerts.js";
import { createQuiz } from "../src/quizzes.js";
import { createDb } from "./fake-d1.js";

const NOW = 1_800_000_000;
let db;
let sent;
const realFetch = globalThis.fetch;
const env = () => ({ DB: db, BOT_TOKEN: "t", ADMIN_IDS: "1, 2" });

beforeEach(() => {
  db = createDb();
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}");
  };
  db.raw.prepare("INSERT INTO users (id, first_name, created_at) VALUES (5, 'Вася', 0)").run();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const setStatus = (v) =>
  db.raw.prepare("INSERT OR REPLACE INTO api_state (key, value, updated_at) VALUES ('sync_status', ?, 0)").run(JSON.stringify(v));

test("оповещения: все причины, каждому админу, не чаще раза в сутки", async () => {
  setStatus({ failures: 3, last_error: "результаты: HTTP 500", quota: { left: 12, limit: 250 } });
  db.raw.prepare("INSERT INTO matches (tournament, home, away, start_time, status, updated_at) VALUES ('PL', 'Arsenal', 'Chelsea', ?, 'scheduled', 0)").run(NOW - 2 * 86400);
  db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (5, ?, 'admin_adjustment', ?)").run(600 * UNIT, NOW - 100);

  const keys = await checkAlerts(env(), NOW);
  assert.deepEqual(keys.sort(), ["quiz_queue", "quota", "results", "spike:5", "sync"]);
  assert.deepEqual(sent.map((m) => m.chat_id), [1, 2]);
  const text = sent[0].text;
  for (const s of ["осталось 12 запросов", "3 раз подряд", "Arsenal — Chelsea", "Очередь викторин пуста", "Вася (ID 5) получил +600.0 BIST"]) {
    assert.ok(text.includes(s), s);
  }

  // Через час — тишина, через сутки — снова (рост BIST уже старше суток)
  sent = [];
  assert.deepEqual(await checkAlerts(env(), NOW + 3600), []);
  assert.equal(sent.length, 0);
  assert.deepEqual((await checkAlerts(env(), NOW + 86400)).sort(), ["quiz_queue", "quota", "results", "sync"]);
});

test("оповещения: всё в порядке — ничего не отправляем; очередь викторин на исходе", async () => {
  setStatus({ failures: 1, quota: { left: 100, limit: 250 } });
  // Три викторины: текущая до полуночи и ещё две по дню — очередь на 2+ дня вперёд
  for (const t of ["A", "B", "C"]) {
    await createQuiz(db, 1, { title: t, questions: [{ text: "?", answers: "да" }] }, NOW);
  }
  assert.deepEqual(await checkAlerts(env(), NOW), []);
  assert.deepEqual(await checkAlerts(env(), NOW + 86400), ["quiz_queue"]);
  assert.match(sent[0].text, /осталось примерно на \d+ ч/);
  // Без админов или токена молчим
  assert.deepEqual(await checkAlerts({ DB: db, BOT_TOKEN: "t", ADMIN_IDS: "" }, NOW + 5 * 86400), []);
});
