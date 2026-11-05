import { test } from "node:test";
import assert from "node:assert/strict";

import { UNIT } from "../src/money.js";
import { dashboard } from "../src/dashboard.js";
import { createQuiz } from "../src/quizzes.js";
import { createDb, roundTrips } from "./fake-d1.js";

// 15.01.2027 11:00 МСК, пятница
const NOW = 1_800_000_000;
const DAY = 86400;

test("дашборд: одно обращение к базе, цифры сходятся с журналом", async () => {
  const db = createDb();
  const tx = (user, bist, type, at) =>
    db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, ?, ?)").run(user, bist * UNIT, type, at);
  // 12 игроков: у первого 150 BIST, у второго 100, у остальных по 10
  for (let id = 1; id <= 12; id++) {
    db.raw.prepare("INSERT INTO users (id, first_name, created_at) VALUES (?, 'U', ?)").run(id, id <= 2 ? NOW - 20 * DAY : NOW - 3600);
    tx(id, 10, "signup_bonus", id <= 2 ? NOW - 20 * DAY : NOW - 3600);
  }
  tx(1, 140, "admin_adjustment", NOW - 3 * DAY);
  tx(2, 90, "quiz_reward", NOW - 600);
  // Прогноз игрока 3: ставка 4, выигрыш 8
  db.raw.prepare("INSERT INTO matches (id, tournament, home, away, start_time, status, updated_at) VALUES (1, 'PL', 'A', 'B', ?, 'scheduled', 0)").run(NOW - 7200);
  db.raw.prepare("INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, status, payout, created_at, updated_at, settled_at) VALUES (3, 1, '1x2', '1', ?, 2, 'won', ?, ?, 0, ?)")
    .run(4 * UNIT, 8 * UNIT, NOW - 3 * 3600, NOW - 60);
  db.raw.prepare("UPDATE matches SET status = 'finished' WHERE id = 1").run();
  tx(3, -4, "bet", NOW - 3 * 3600);
  tx(3, 8, "payout", NOW - 60);
  await createQuiz(db, 1, { title: "Q", questions: [{ text: "?", answers: "да" }] }, NOW - DAY);
  const qid = db.raw.prepare("SELECT id FROM quiz_questions").get().id;
  db.raw.prepare("INSERT INTO quiz_answers (user_id, question_id, opened_at, attempts, correct, answered_at) VALUES (4, ?, ?, 1, 0, ?)").run(qid, NOW - 100, NOW - 90);

  roundTrips.count = 0;
  const d = await dashboard(db, NOW);
  assert.equal(roundTrips.count, 1);

  const ledger = (since) => db.raw.prepare("SELECT SUM(amount) AS s FROM transactions WHERE created_at >= ?").get(since).s / UNIT;
  for (const p of ["day", "week", "month"]) {
    assert.equal(Math.round((d.bist.issued[p] - d.bist.spent[p]) * 10) / 10, ledger(d.since[p]), p);
  }
  assert.deepEqual(d.bist.issued, { day: 198, week: 338, month: 338 });
  assert.deepEqual(d.bist.spent, { day: 4, week: 4, month: 4 });
  assert.equal(d.bist.total, 354);

  assert.equal(d.players.total, 12);
  assert.deepEqual(d.players.new, { day: 10, week: 10, month: 10 });
  assert.deepEqual(d.players.active, { day: 3, week: 3, month: 3 });
  assert.equal(d.players.qualified, 2);
  // Верхние 10% из 12 — это 2 игрока: (150 + 100) / 354
  assert.equal(d.players.top_n, 2);
  assert.equal(d.players.top_share, 70.6);

  assert.deepEqual([d.predictions.made.day, d.predictions.stake.day, d.predictions.won.day, d.predictions.payout.day], [1, 4, 1, 8]);
  assert.deepEqual(d.predictions.active, { count: 0, stake: 0, players: 0 });
  assert.deepEqual([d.quizzes.opened.day, d.quizzes.wrong.day, d.quizzes.players.day], [1, 1, 1]);
});
