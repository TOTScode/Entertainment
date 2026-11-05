import { test } from "node:test";
import assert from "node:assert/strict";

import { history, leaderboard, moscowDay, periodStart, takeSnapshot, userStats } from "../src/leaderboard.js";
import { addTransaction } from "../src/users.js";
import { UNIT } from "../src/money.js";
import { createDb } from "./fake-d1.js";

// Среда, 28 октября 2026, 12:00 по Москве
const NOW = Date.UTC(2026, 9, 28, 9) / 1000;
const DAY = 86400;

function seed(db, users) {
  for (const [id, createdAt, name] of users) {
    db.raw.prepare("INSERT INTO users (id, first_name, created_at) VALUES (?, ?, ?)").run(id, name, createdAt);
    db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, 'signup_bonus', ?)").run(id, 10 * UNIT, createdAt);
  }
}
const tx = (db, userId, amount, at, type = "quiz_reward") =>
  db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, ?, ?)").run(userId, amount * UNIT, type, at);

test("начало недели и месяца по Москве", () => {
  assert.equal(periodStart("week", NOW), Date.UTC(2026, 9, 25, 21) / 1000); // пн 26.10 00:00 МСК
  assert.equal(periodStart("month", NOW), Date.UTC(2026, 8, 30, 21) / 1000); // 1.10 00:00 МСК
  // Воскресенье 23:30 МСК ещё относится к прошлой неделе
  const sunday = Date.UTC(2026, 10, 1, 20, 30) / 1000;
  assert.equal(periodStart("week", sunday), Date.UTC(2026, 9, 25, 21) / 1000);
  // 21:30 UTC 31 октября — это уже 1 ноября по Москве
  assert.equal(periodStart("month", Date.UTC(2026, 9, 31, 21, 30) / 1000), Date.UTC(2026, 9, 31, 21) / 1000);
  assert.equal(periodStart("all", NOW), null);
  assert.equal(moscowDay(Date.UTC(2026, 9, 27, 21, 1) / 1000), "2026-10-28");
});

// Правильные ответы в викторинах: n штук в момент at
function quizRight(db, userId, n, at) {
  for (let i = 0; i < n; i++) {
    const z = db.raw.prepare("INSERT INTO quizzes (title, reward, position, created_by, created_at, updated_at) VALUES ('Q', 0, 1, 1, 0, 0) RETURNING id").get().id;
    const q = db.raw.prepare("INSERT INTO quiz_questions (quiz_id, position, text, answers) VALUES (?, 1, 'q', '[\"a\"]') RETURNING id").get(z).id;
    db.raw.prepare("INSERT INTO quiz_answers (user_id, question_id, opened_at, attempts, correct, answered_at) VALUES (?, ?, ?, 1, 1, ?)").run(userId, q, at, at);
  }
}
// Рассчитанные прогнозы: won угаданных и lost неугаданных на исход (market — 1x2 или score)
function predictions(db, userId, won, lost, at, market = "1x2") {
  const m = db.raw.prepare("INSERT INTO matches (tournament, home, away, start_time, status, updated_at) VALUES ('PL', 'A', 'B', ?, 'scheduled', 0) RETURNING id").get(at).id;
  for (let i = 0; i < won + lost; i++) {
    db.raw
      .prepare("INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, status, payout, created_at, updated_at, settled_at) VALUES (?, ?, ?, '1', 1, 2, ?, 0, ?, ?, ?)")
      .run(userId, m, market, i < won ? "won" : "lost", at - 3600, at, at);
  }
}

test("общая таблица: по сумме очков, по тапу на ⚽️ — по доле угаданных (от 6 прогнозов)", async () => {
  const db = createDb();
  seed(db, [[1, NOW - 30 * DAY, "A"], [2, NOW - 20 * DAY, "B"], [3, NOW - 10 * DAY, "C"], [4, NOW - DAY, "D"], [5, NOW, "E"]]);
  tx(db, 4, 500, NOW - DAY); // BIST на место не влияют
  quizRight(db, 3, 2, NOW - DAY);
  quizRight(db, 2, 1, NOW - DAY);
  quizRight(db, 1, 1, NOW - DAY);
  predictions(db, 1, 3, 3, NOW - DAY); // 50% из 6
  predictions(db, 2, 2, 3, NOW - DAY); // 5 прогнозов — доля не считается
  predictions(db, 5, 5, 1, NOW - DAY); // 83%, но без викторин
  predictions(db, 5, 3, 0, NOW - DAY, "score"); // точный счёт не учитывается
  const board = await leaderboard(db, { userId: 4, ts: NOW });
  assert.equal(board.total, 5);
  // Очки: E 0+5, A 1+3, B 1+2, C 2+0, D 0
  assert.deepEqual(
    board.rows.map((r) => [r.rank, r.id, r.quiz, r.accuracy, r.won, r.bets]),
    [[1, 5, 0, 83, 5, 6], [2, 1, 1, 50, 3, 6], [3, 2, 1, null, 2, 5], [4, 3, 2, null, 0, 0], [5, 4, 0, null, 0, 0]],
  );
  assert.deepEqual([board.me.rank, board.me.name], [5, "D"]);

  const byAcc = await leaderboard(db, { sort: "accuracy", userId: 4, ts: NOW });
  assert.deepEqual(byAcc.rows.map((r) => r.id), [5, 1, 3, 2, 4]);
  assert.ok(byAcc.rows.every((r) => r.change === null));
});

test("неделя и месяц: только ответы и рассчитанные прогнозы за период", async () => {
  const db = createDb();
  seed(db, [[1, NOW - 60 * DAY, "A"], [2, NOW - 60 * DAY, "B"], [3, NOW - DAY, "Новичок"]]);
  quizRight(db, 1, 5, Date.UTC(2026, 8, 20) / 1000); // сентябрь
  quizRight(db, 1, 1, Date.UTC(2026, 9, 26, 6) / 1000); // эта неделя
  quizRight(db, 2, 3, Date.UTC(2026, 9, 10) / 1000); // этот месяц, прошлая неделя

  const week = await leaderboard(db, { period: "week", userId: 3, ts: NOW });
  assert.deepEqual(week.rows.map((r) => [r.id, r.quiz]), [[1, 1], [2, 0], [3, 0]]);
  assert.equal(week.rows[0].change, null);
  assert.ok(week.since);

  const month = await leaderboard(db, { period: "month", userId: 3, ts: NOW });
  assert.deepEqual(month.rows.map((r) => [r.id, r.quiz]), [[2, 3], [1, 1], [3, 0]]);
  assert.equal(month.me.rank, 3);

  const all = await leaderboard(db, { period: "nonsense", userId: 3, ts: NOW });
  assert.equal(all.period, "all");
  assert.deepEqual(all.rows.map((r) => [r.id, r.quiz]), [[1, 6], [2, 3], [3, 0]]);
});

test("снимок рейтинга: изменение места за сутки, повторный снимок не меняет день", async () => {
  const db = createDb();
  seed(db, [[1, NOW - 30 * DAY, "A"], [2, NOW - 20 * DAY, "B"]]);
  assert.equal((await leaderboard(db, { userId: 2, ts: NOW })).me.change, null);

  assert.equal(await takeSnapshot(db, NOW - DAY), "2026-10-27");
  quizRight(db, 2, 1, NOW);
  assert.equal(await takeSnapshot(db, NOW - DAY), "2026-10-27"); // повтор не перезаписывает
  const board = await leaderboard(db, { userId: 2, ts: NOW });
  assert.deepEqual(board.rows.map((r) => [r.id, r.change]), [[2, 1], [1, -1]]);

  // Снимки старше 40 дней удаляются
  await takeSnapshot(db, NOW + 45 * DAY);
  const days = db.raw.prepare("SELECT DISTINCT day FROM rank_snapshots").all().map((r) => r.day);
  assert.deepEqual(days, [moscowDay(NOW + 45 * DAY)]);
});

test("статистика и история операций сходятся с балансом", async () => {
  const db = createDb();
  seed(db, [[7, NOW, "A"]]);
  for (let i = 0; i < 34; i++) await addTransaction(db, { userId: 7, amount: (i % 2 ? -1 : 2) * UNIT, type: "quiz_reward" });
  const stats = await userStats(db, 7);
  assert.deepEqual(stats, { earned: 10 + 17 * 2, spent: 17 });

  const first = await history(db, 7);
  assert.equal(first.items.length, 30);
  assert.ok(first.items[0].id > first.items[1].id);
  const second = await history(db, 7, { before: first.next });
  assert.equal(second.items.length, 5);
  assert.equal(second.next, null);
  const sum = [...first.items, ...second.items].reduce((s, t) => s + t.amount, 0);
  assert.equal(sum, stats.earned - stats.spent);
  assert.equal(second.items.at(-1).type, "signup_bonus");
});
