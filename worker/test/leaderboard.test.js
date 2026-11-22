import { test } from "node:test";
import assert from "node:assert/strict";

import { history, leaderboard, moscowDay, periodStart, publicProfile, takeSnapshot, userStats } from "../src/leaderboard.js";
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
