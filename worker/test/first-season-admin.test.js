import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./fake-d1.js";
import {
  FIRST_SEASON_START as START,
  ensureCalendar,
  advanceSeasons,
  seasonState,
  configureSeasonPolicy,
  calendarSeason,
} from "../src/seasons.js";
import { leaderboard } from "../src/leaderboard.js";
import { placePrediction, cancelPrediction, getMatch, listMatches, settleMatch } from "../src/predictions.js";
import { participantStats } from "../src/statistics.js";
const U = 10000;
const addUser = (db, id, now, bist = 10) => {
  db.raw
    .prepare("INSERT INTO users(id,nickname,created_at,public_profile) VALUES(?,?,?,1)")
    .run(id, "Игрок " + id, now - 1000);
  db.raw
    .prepare("INSERT INTO transactions(user_id,amount,type,created_at) VALUES(?,?,'signup_bonus',?)")
    .run(id, bist * U, now - 1000);
};
const match = (db, now, start, status = "scheduled") => {
  const m = db.raw
    .prepare(
      "INSERT INTO matches(tournament,home,away,start_time,status,odds_updated_at,updated_at,home_score,away_score,settled_at,settle_version) VALUES('PL','A','B',?,?,?,?,?,?,?,?) RETURNING *",
    )
    .get(
      start,
      status,
      now - 999999,
      now,
      status === "finished" ? 1 : null,
      status === "finished" ? 0 : null,
      status === "finished" ? now - 1 : null,
      status === "finished" ? 1 : 0,
    );
  db.raw.prepare("INSERT INTO odds VALUES(?,'1x2','1',2)").run(m.id);
  return m;
};
const balance = (db, id) =>
  db.raw.prepare("SELECT SUM(amount)/10000.0 b FROM transactions WHERE user_id=?").get(id).b;

test("only winter 26/27 exists before launch; no qualification or ranks until Dec 1; first reset is once", async () => {
  const db = createDb(),
    now = START - 100;
  addUser(db, 1, now, 123);
  const s = await ensureCalendar(db, now);
  assert.equal(s.id, "2026-winter");
  await advanceSeasons(db, now);
  const state = await seasonState(db, 1, now);
  assert.equal(state.season.pending_start, true);
  assert.equal(state.qualified, false);
  assert.deepEqual(
    state.seasons.map((s) => s.id),
    ["2026-winter"],
  );
  const board = await leaderboard(db, { userId: 1, ts: now });
  assert.equal(board.rows.length, 0);
  assert.equal(board.me.qualified, false);
  await assert.rejects(leaderboard(db, { userId: 1, ts: now, seasonId: "2026-autumn" }), /Сезон не найден/);
  assert.throws(
    () => db.raw.prepare("INSERT INTO seasons(id,starts_at,ends_at) VALUES('2026-autumn',1,2)").run(),
    /season_before_launch/,
  );
  await configureSeasonPolicy(
    db,
    {
      opening_bist: 10,
      pending_policy: "refund_old_season",
      repeat_each_season: true,
      owner_approved: true,
      reason: "test",
    },
    1,
    now,
  );
  assert.equal(balance(db, 1), 123);
  await advanceSeasons(db, START);
  await advanceSeasons(db, START + 1);
  assert.equal(balance(db, 1), 10);
  assert.equal((await seasonState(db, 1, START)).season.pending_start, false);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='season_opening'").get().n, 1);
  await advanceSeasons(db, s.ends_at + 1);
  assert.deepEqual(
    (await seasonState(db, 1, s.ends_at + 1)).seasons.map((s) => s.id),
    ["2027-spring", "2026-winter"],
  );
});

test("admin may predict closed/stale/cancelled events on ordinary balance; all such forecasts excluded from season stats", async () => {
  const db = createDb(),
    now = START + 86400;
  addUser(db, 1, now);
  addUser(db, 2, now);
  await ensureCalendar(db, now);
  const finished = match(db, now, now - 999999, "finished");
  await assert.rejects(
    placePrediction(
      db,
      2,
      { match_id: finished.id, market: "1x2", outcome: "1", stake: 1, is_admin_test: true, admin: true },
      now,
    ),
    /закрыт/,
  );
  const win = await placePrediction(
    db,
    1,
    { match_id: finished.id, market: "1x2", outcome: "1", stake: 1 },
    now,
    { admin: true },
  );
  assert.equal(win.prediction.is_admin_test, true);
  assert.equal(win.prediction.status, "won");
  assert.equal(win.balance, 11);
  const detail = await getMatch(db, 1, finished.id, now, { admin: true });
  assert.equal(detail.open, true);
  assert.equal(detail.admin_mode, true);
  assert.equal((await getMatch(db, 2, finished.id, now)).open, false);
  const cancelled = match(db, now, now - 999999, "cancelled");
  const refund = await placePrediction(
    db,
    1,
    { match_id: cancelled.id, market: "1x2", outcome: "1", stake: 2 },
    now,
    { admin: true },
  );
  assert.equal(refund.prediction.status, "refunded");
  assert.equal(refund.balance, 11);
  const s = calendarSeason(now),
    future = match(db, now, s.ends_at + 1000);
  const active = await placePrediction(
    db,
    1,
    { match_id: future.id, market: "1x2", outcome: "1", stake: 2 },
    now,
    { admin: true },
  );
  assert.equal(active.prediction.next_change_at, now);
  await assert.rejects(cancelPrediction(db, 1, active.prediction.id, now + 1), /права администратора/);
  assert.equal((await cancelPrediction(db, 1, active.prediction.id, now + 1, { admin: true })).balance, 11);
  assert.ok((await listMatches(db, 1, { now, admin: true })).matches.some((m) => m.id === finished.id));
  assert.ok(!(await listMatches(db, 2, { now })).matches.some((m) => m.id === finished.id));
  const stats = await participantStats(db, { from: START, to: now + 2 });
  assert.equal(stats.get(1)?.predictions || 0, 0);
  assert.equal(balance(db, 1), 11);
  assert.equal(
    db.raw.prepare("SELECT COUNT(*) n FROM content_versions WHERE kind='admin_prediction'").get().n,
    3,
  );
});

test("admin future forecast survives season boundary, credits ordinary balance but not seasonal statistics", async () => {
  const db = createDb(),
    now = START + 86400;
  addUser(db, 1, now);
  await ensureCalendar(db, now);
  const s = calendarSeason(now),
    future = match(db, now, s.ends_at + 1000);
  await configureSeasonPolicy(
    db,
    {
      opening_bist: 10,
      pending_policy: "refund_old_season",
      repeat_each_season: true,
      owner_approved: true,
      reason: "test",
    },
    1,
    now,
  );
  await placePrediction(db, 1, { match_id: future.id, market: "1x2", outcome: "1", stake: 2 }, now, {
    admin: true,
  });
  await advanceSeasons(db, s.ends_at + 1);
  assert.equal(balance(db, 1), 10);
  assert.equal(db.raw.prepare("SELECT status FROM predictions").get().status, "active");
  await settleMatch(db, future, [1, 0], s.ends_at + 1001);
  assert.equal(balance(db, 1), 14);
  const stats = await participantStats(db, { from: s.ends_at, to: s.ends_at + 1002 });
  assert.equal(stats.get(1)?.predictions || 0, 0);
  assert.equal(
    (await leaderboard(db, { userId: 1, seasonId: s.id, ts: s.ends_at + 1002 })).me.predictions,
    0,
  );
});

test("concurrent result cannot duplicate admin refund or leave replacement unsettled on a finished event", async () => {
  for (const operation of ["cancel", "replace"]) {
    const db = createDb(),
      now = START + 86400;
    addUser(db, 1, now);
    await ensureCalendar(db, now);
    const m = match(db, now, now + 1);
    const placed = await placePrediction(
      db,
      1,
      { match_id: m.id, market: "1x2", outcome: "1", stake: 1 },
      now,
      { admin: true },
    );
    const batch = db.batch.bind(db);
    let settled = false;
    db.batch = async (statements) => {
      if (!settled) {
        settled = true;
        await settleMatch({ ...db, batch }, m, [1, 0], now + 2);
      }
      return batch(statements);
    };
    if (operation === "cancel") {
      await assert.rejects(
        cancelPrediction(db, 1, placed.prediction.id, now + 3, { admin: true }),
        /уже изменился/,
      );
      assert.equal(balance(db, 1), 11);
    } else {
      const replacement = await placePrediction(
        db,
        1,
        { match_id: m.id, market: "1x2", outcome: "1", stake: 2 },
        now + 3,
        { admin: true },
      );
      assert.equal(replacement.replaced, false);
      assert.equal(replacement.prediction.status, "won");
      assert.equal(balance(db, 1), 13);
    }
    assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n, 0);
  }
});
