import { test } from "node:test";
import assert from "node:assert/strict";
import { rankParticipants } from "../src/quiz-ranking.js";
import { shortSeasonName } from "../src/seasons.js";
import { createDb } from "./fake-d1.js";

test("quiz rating uses exact question ratio, ignores money/forecasts/qualification; ties share place", () => {
  const rows = [
    { id: 1, name: "Б", quizzes: 3, quiz_correct: 1, quiz_answers: 3, quiz_percent: 33.33, qualified: false },
    {
      id: 2,
      name: "А",
      quizzes: 4,
      quiz_correct: 1,
      quiz_answers: 4,
      qualified: true,
      balance: 1e9,
      predictions: 999,
    },
    { id: 3, name: "В", quizzes: 2, quiz_correct: 1, quiz_answers: 4 },
    { id: 4, name: "Г", quizzes: 100, quiz_correct: 0, quiz_answers: 0 },
    { id: 5, name: "Д", quizzes: 1, quiz_correct: 501, quiz_answers: 1000 },
  ];
  const ranked = rankParticipants(rows);
  assert.deepEqual(
    ranked.map((r) => [r.id, r.rank]),
    [
      [2, 1],
      [1, 1],
      [5, 3],
      [3, 4],
      [4, 5],
    ],
  );
  assert.equal(ranked[1].quiz_rating, 1); // 3 * (1/3), not rounded percentage
  assert.equal(ranked.at(-1).quiz_rating, 0);
  assert.equal(rows[0].rank, undefined); // source records remain unchanged
});

test("season labels retain winter across two years", () => {
  assert.equal(shortSeasonName("2026-winter"), "Зима 26/27");
  assert.equal(shortSeasonName("2027-spring"), "Весна 27");
  assert.equal(shortSeasonName("2099-winter"), "Зима 99/00");
  assert.equal(shortSeasonName("2026-autumn"), "Осень 26");
});

test("20-second migration changes default/queued quizzes while preserving started timers and other settings", () => {
  const db = createDb({ upTo: 13 }),
    now = db.raw.prepare("SELECT unixepoch() t").get().t;
  db.raw
    .prepare("INSERT INTO api_state VALUES('quiz_settings',?,?)")
    .run(JSON.stringify({ every_days: 3, attempts: 2, time_limit: 60 }), now);
  const insert = db.raw.prepare(
    "INSERT INTO quizzes(title,reward,position,starts_at,ends_at,created_by,created_at,updated_at,attempts_limit,time_limit) VALUES(?,10000,1,?,?,1,?,?,2,60)",
  );
  insert.run("active", now - 10, now + 100, now - 10, now);
  insert.run("queued", now + 100, now + 200, now, now);
  insert.run("ended", now - 100, now - 20, now - 100, now - 20);
  db.applyRemaining(13);
  const rows = db.raw.prepare("SELECT title,time_limit,attempts_limit FROM quizzes ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => [r.title, r.time_limit, r.attempts_limit]),
    [
      ["active", 60, 2],
      ["queued", 20, 2],
      ["ended", 60, 2],
    ],
  );
  const settings = JSON.parse(
    db.raw.prepare("SELECT value FROM api_state WHERE key='quiz_settings'").get().value,
  );
  assert.deepEqual(settings, { every_days: 3, attempts: 2, time_limit: 20 });
});
