import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./fake-d1.js";
import {
  calendarSeason,
  ensureCalendar,
  activateSeason,
  configureSeasonPolicy,
  advanceSeasons,
  seasonState,
  saveFinalRules,
  freezeFinalists,
  enterFinal,
  submitFinal,
} from "../src/seasons.js";
import { leaderboard, publicProfile } from "../src/leaderboard.js";
import { participantStats } from "../src/statistics.js";
import { createQuiz, openQuestion, answerQuestion, saveSettings } from "../src/quizzes.js";
import { voidQuestion, decideFinalist } from "../src/corrections.js";
import { savePreferences, validatePolicy, createRequest } from "../src/privacy.js";
import { finalScores, reviewFinal, publishTiebreak, tiebreak } from "../src/finals.js";
import { sendMarketing } from "../src/bot.js";
const U = 10000,
  at = (s) => Date.parse(s) / 1000,
  NOW = at("2027-02-21T23:58:20+03:00");
function user(db, id, balance = 10, name = "Игрок " + id) {
  db.raw
    .prepare(
      "INSERT INTO users(id,nickname,photo_url,created_at,public_profile,public_avatar) VALUES(?,?,?, ?,1,1)",
    )
    .run(id, name, "https://example.invalid/photo", NOW - 100000);
  tx(db, id, balance, NOW - 100000, "signup_bonus");
}
function tx(db, id, bist, when = NOW, type = "admin_adjustment") {
  db.raw
    .prepare("INSERT INTO transactions(user_id,amount,type,created_at) VALUES(?,?,?,?)")
    .run(id, bist * U, type, when);
}
const balance = (db, id) =>
  db.raw.prepare("SELECT SUM(amount) AS b FROM transactions WHERE user_id=?").get(id).b / U;
function rules(s) {
  return {
    season_id: s.id,
    threshold: 100,
    organizer: "TEST ONLY",
    contacts: "test@example.invalid",
    eligibility: "test eligibility",
    cutoff: NOW + 100,
    final_start: at("2027-03-02T12:00:00+03:00"),
    final_end: at("2027-03-03T12:00:00+03:00"),
    results_at: at("2027-03-04T12:00:00+03:00"),
    prizes_due: at("2027-03-05T12:00:00+03:00"),
    appeals_until: at("2027-03-06T12:00:00+03:00"),
    pending_policy: "exclude_pending",
    pending_predictions: "Unsettled payouts are excluded; already deducted stakes remain deducted.",
    tasks: "test tasks",
    assessment: "knowledge score",
    attempts: 1,
    tie_knowledge_task: "additional knowledge test",
    prizes: "test fixture prize, not announced",
    prize_funding: "organizer",
    appeals: "test contact",
    corrections: "audited correction",
    disputes: "human review",
    human_review_confirmed: true,
    questions: [
      {
        id: "q1",
        text: "test question",
        source: "test author",
        rubric: "one point",
        reviewed_by: 1,
        reviewed_at: NOW,
      },
    ],
  };
}
async function published(db) {
  const s = await ensureCalendar(db, NOW);
  await saveFinalRules(db, s.id, rules(s), 1, NOW, { publish: true });
  return s;
}

test("Minsk seasons: every boundary, cross-year winter, leap February, end exclusive", () => {
  for (const [date, id] of [
    ["2026-11-30T23:59:59+03:00", "2026-autumn"],
    ["2026-12-01T00:00:00+03:00", "2026-winter"],
    ["2027-01-01T00:00:00+03:00", "2026-winter"],
    ["2027-03-01T00:00:00+03:00", "2027-spring"],
    ["2027-06-01T00:00:00+03:00", "2027-summer"],
    ["2027-09-01T00:00:00+03:00", "2027-autumn"],
    ["2028-02-29T23:59:59+03:00", "2027-winter"],
    ["2028-03-01T00:00:00+03:00", "2028-spring"],
  ]) {
    const t = at(date),
      s = calendarSeason(t);
    assert.equal(s.id, id);
    assert.ok(t >= s.starts_at && t < s.ends_at);
    assert.notEqual(calendarSeason(s.ends_at).id, id);
  }
  assert.equal(
    (calendarSeason(at("2028-02-29T10:00:00+03:00")).ends_at -
      calendarSeason(at("2028-02-29T10:00:00+03:00")).starts_at) /
      86400,
    91,
  );
  assert.equal(
    (calendarSeason(at("2027-02-28T10:00:00+03:00")).ends_at -
      calendarSeason(at("2027-02-28T10:00:00+03:00")).starts_at) /
      86400,
    90,
  );
});
test("without approval no reset; activation is ledger-only, idempotent, never repeats signup", async () => {
  const db = createDb();
  user(db, 1, 123);
  await advanceSeasons(db, NOW);
  assert.equal(balance(db, 1), 123);
  await assert.rejects(
    activateSeason(db, { season_id: "2026-winter", owner_approved: true }, 1, NOW),
    /баланс/,
  );
  await activateSeason(
    db,
    {
      season_id: "2026-winter",
      opening_bist: 10,
      pending_policy: "refund_old_season",
      owner_approved: true,
      repeat_each_season: true,
      reason: "test approval",
    },
    1,
    NOW,
  );
  assert.equal(balance(db, 1), 10);
  tx(db, 1, 10, NOW + 1);
  await advanceSeasons(db, NOW + 5);
  assert.equal(balance(db, 1), 20);
  const next = at("2027-03-01T00:00:00+03:00");
  await advanceSeasons(db, next);
  await advanceSeasons(db, next + 1);
  assert.equal(balance(db, 1), 10);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='signup_bonus'").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='season_opening'").get().n, 2);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM season_summaries").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions").get().n, 4);
});
test("live qualification loses and recovers; exact-cutoff freeze survives reset and final entry is free", async () => {
  const db = createDb();
  user(db, 1, 99);
  user(db, 2, 100);
  const s = await published(db);
  assert.equal((await seasonState(db, 1, NOW)).qualified, false);
  tx(db, 1, 1, NOW + 1);
  assert.equal((await seasonState(db, 1, NOW + 2)).qualified, true);
  tx(db, 1, -1, NOW + 3);
  assert.equal((await seasonState(db, 1, NOW + 4)).qualified, false);
  tx(db, 1, 1, NOW + 5);
  tx(db, 2, -1, NOW + 100); // at deadline belongs after the exclusive cutoff, must not revoke frozen admission
  assert.equal(await freezeFinalists(db, s.id, NOW + 120), true);
  assert.equal(await freezeFinalists(db, s.id, NOW + 130), false);
  tx(db, 1, -50, NOW + 140);
  assert.equal((await seasonState(db, 1, NOW + 141)).qualified, true);
  const fn = rules(s).final_start;
  await activateSeason(
    db,
    {
      season_id: "2027-spring",
      opening_bist: 10,
      pending_policy: "refund_old_season",
      owner_approved: true,
      reason: "test",
    },
    1,
    fn,
  );
  const f = await enterFinal(db, s.id, 1, fn);
  assert.equal(f.attempts, 1);
  assert.equal(balance(db, 1), 10);
  await enterFinal(db, s.id, 1, fn + 1);
  await submitFinal(db, s.id, 1, { q1: "answer" }, fn + 2);
  await assert.rejects(submitFinal(db, s.id, 1, { q1: "again" }, fn + 3), /исчерпаны/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM final_entries WHERE user_id=1").get().n, 1);
  const archive = await leaderboard(db, { userId: 1, seasonId: s.id, ts: fn });
  assert.equal(archive.me.qualified, true);
  assert.equal(archive.qualification_frozen, true);
  await assert.rejects(
    db
      .prepare("INSERT INTO transactions(user_id,amount,type,created_at) VALUES(1,100,'x',?)")
      .bind(NOW + 10)
      .run(),
    /cutoff_locked|season_closed/,
  );
});
test("rule publication blocks missing fields, changed cutoff, unreviewed final questions and edits", async () => {
  const db = createDb(),
    s = await ensureCalendar(db, NOW);
  await assert.rejects(saveFinalRules(db, s.id, {}, 1, NOW, { publish: true }), /Заполните/);
  const r = rules(s);
  await assert.rejects(
    saveFinalRules(db, s.id, { ...r, cutoff: r.cutoff + 1 }, 1, NOW, { publish: true }),
    /семь дней/,
  );
  await assert.rejects(
    saveFinalRules(db, s.id, { ...r, human_review_confirmed: false }, 1, NOW, { publish: true }),
    /человеком/,
  );
  await saveFinalRules(db, s.id, r, 1, NOW, { publish: true });
  await assert.rejects(saveFinalRules(db, s.id, r, 1, NOW), /неизменяемы/);
});
test("quiz rating order ignores qualification and money; equal scores share rank; avatar requires opt-in", async () => {
  const db = createDb();
  user(db, 1, 100, "Я");
  user(db, 2, 1000, "А");
  user(db, 3, 99, "Б");
  user(db, 4, 100, "А");
  db.raw.prepare("UPDATE users SET public_avatar=0 WHERE id=2").run();
  const b = await leaderboard(db, { userId: 1, ts: NOW });
  assert.deepEqual(
    b.rows.map((r) => r.id),
    [2, 4, 3, 1],
  );
  assert.equal(b.rows[0].photo_url, null);
  assert.deepEqual(
    b.rows.map((r) => r.rank),
    [1, 1, 1, 1],
  );
  for (const r of b.rows)
    for (const key of ["balance", "stake", "payout", "earned", "spent", "rating", "change", "username"])
      assert.equal(r[key], undefined, key);
  const p = await publicProfile(db, 1, { viewerId: 3, now: NOW });
  assert.equal(p.balance, undefined);
  assert.equal(p.stats, undefined);
  assert.equal((await publicProfile(db, 1, { viewerId: 1, now: NOW })).balance, 100);
  assert.equal((await publicProfile(db, 1, { viewerId: 3, admin: true, now: NOW })).balance, 100);
  db.raw.prepare("UPDATE users SET public_profile=0 WHERE id=1").run();
  assert.equal(await publicProfile(db, 1, { viewerId: 3, now: NOW }), null);
  const c = await leaderboard(db, { userId: 1, ts: NOW });
  assert.equal(
    c.rows.some((r) => r.id === 1),
    false,
  );
  assert.equal(c.me.id, 1);
});
test("quiz counts per completed quiz, precision by questions; forecasts all settled markets, void/refund excluded", async () => {
  const db = createDb();
  user(db, 1);
  await saveSettings(db, { every_days: 1, time_limit: 0, attempts: 2 }, NOW);
  const id = await createQuiz(
    db,
    1,
    {
      title: "test",
      reward: 1,
      questions: [
        { text: "A?", answers: ["a"], source: "test" },
        { text: "B?", answers: ["b"], source: "test" },
      ],
    },
    NOW,
  );
  const qs = db.raw.prepare("SELECT id FROM quiz_questions ORDER BY id").all();
  await openQuestion(db, 1, qs[0].id, NOW);
  await answerQuestion(db, 1, qs[0].id, "wrong", NOW + 1);
  await answerQuestion(db, 1, qs[0].id, "a", NOW + 2);
  let st = (await participantStats(db, { from: calendarSeason(NOW).starts_at, to: NOW + 10 })).get(1);
  assert.equal(st.quizzes, 0);
  assert.equal(st.quiz_answers, 1);
  assert.equal(st.quiz_percent, 100);
  await openQuestion(db, 1, qs[1].id, NOW + 3);
  await answerQuestion(db, 1, qs[1].id, "bad", NOW + 4);
  await answerQuestion(db, 1, qs[1].id, "bad", NOW + 5);
  const m = db.raw
    .prepare(
      "INSERT INTO matches(tournament,home,away,start_time,status,updated_at) VALUES('PL','A','B',?,'scheduled',?) RETURNING id",
    )
    .get(NOW - 1, NOW).id;
  for (const [status, market] of [
    ["won", "score"],
    ["lost", "1x2"],
    ["refunded", "score"],
    ["cancelled", "1x2"],
  ])
    db.raw
      .prepare(
        "INSERT INTO predictions(user_id,match_id,market,outcome,stake,price,status,created_at,updated_at,settled_at) VALUES(1,?,?,?,10000,2,?,?,?,?)",
      )
      .run(m, market, "1", status, NOW - 100, NOW, NOW);
  st = (await participantStats(db, { from: calendarSeason(NOW).starts_at, to: NOW + 10 })).get(1);
  assert.equal(st.quizzes, 1);
  assert.equal(st.quiz_percent, 50);
  assert.equal(st.predictions, 2);
  assert.equal(st.prediction_percent, 50);
  await voidQuestion(db, qs[0].id, { reason: "wrong task" }, 1, NOW + 20);
  assert.equal(balance(db, 1), 10);
  await voidQuestion(db, qs[0].id, { reason: "again" }, 1, NOW + 21);
  assert.equal(balance(db, 1), 10);
  st = (await participantStats(db, { from: calendarSeason(NOW).starts_at, to: NOW + 30 })).get(1);
  assert.equal(st.quiz_percent, 0);
  assert.equal(st.quizzes, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM quiz_answers").get().n, 2);
  assert.ok(db.raw.prepare("SELECT COUNT(*) n FROM content_versions WHERE kind='answer'").get().n >= 6);
  assert.throws(() => db.raw.prepare("DELETE FROM transactions").run(), /append_only/);
});
test("post-freeze correction requires separate reason, never silently changes finalist list", async () => {
  const db = createDb();
  user(db, 1, 100);
  const s = await published(db);
  await freezeFinalists(db, s.id, NOW + 200);
  const qz = db.raw
    .prepare(
      "INSERT INTO quizzes(title,reward,position,created_by,created_at,updated_at) VALUES('x',0,1,1,0,0) RETURNING id",
    )
    .get().id;
  const q = db.raw
    .prepare("INSERT INTO quiz_questions(quiz_id,position,text,answers) VALUES(?,1,'?','[]') RETURNING id")
    .get(qz).id;
  await assert.rejects(voidQuestion(db, q, { reason: "bad" }, 1, NOW + 300), /отдельное решение/);
  await voidQuestion(
    db,
    q,
    { reason: "bad", retain_frozen_admissions: true, post_freeze_reason: "retain published list" },
    1,
    NOW + 300,
  );
  await decideFinalist(
    db,
    s.id,
    { user_id: 1, admitted: false, reason: "separate human decision" },
    1,
    NOW + 301,
  );
  const r = rules(s);
  await assert.rejects(enterFinal(db, s.id, 1, r.final_start), /допуска/);
  assert.equal(
    db.raw.prepare("SELECT qualified FROM season_participants WHERE user_id=1").get().qualified,
    1,
  );
  assert.ok(
    db.raw.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='finalist_decision'").get().n === 1,
  );
});
test("consent cannot be inferred from Telegram: publication gated, withdrawal always available, ads off by default", async () => {
  const db = createDb();
  user(db, 1);
  db.raw.prepare("UPDATE users SET public_profile=0,public_avatar=0").run();
  await assert.rejects(
    savePreferences(db, 1, { public_profile: true, confirm_consent: true }, NOW),
    /политику/,
  );
  await savePreferences(db, 1, { public_profile: false, public_avatar: false, marketing_opt_in: false }, NOW);
  assert.equal(await sendMarketing(db, "unused", 1, "test"), false);
  assert.throws(() => validatePolicy({}), /оператора/);
  const p = {
    operator: "test",
    contacts: "test",
    policy_text: "test only",
    purposes: "test",
    legal_bases: "test",
    retention: "test",
    rights: "test",
    publication_consent: "test",
    avatar_consent: "test",
    marketing_consent: "test",
    processing_consent: "test",
    operator_address: "test",
    personal_data: "test",
    operations: "test",
    withdrawal: "test",
    cross_border_basis: "test",
    age_requirements: "test",
    processing_basis: "consent",
    processing_legal_reference: "test",
    services: [{ name: "test", purpose: "test", countries: ["test"] }],
    legal_review_confirmed: true,
  };
  validatePolicy(p);
  db.raw.prepare("INSERT INTO policy_documents VALUES(?,?,?,?)").run("test-v1", JSON.stringify(p), NOW, 1);
  await savePreferences(
    db,
    1,
    {
      public_profile: true,
      public_avatar: true,
      marketing_opt_in: true,
      confirm_consent: true,
      policy_version: "test-v1",
    },
    NOW + 1,
  );
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM privacy_events").get().n, 3);
  await savePreferences(db, 1, { public_profile: false, marketing_opt_in: false }, NOW + 2);
  assert.equal(db.raw.prepare("SELECT public_avatar FROM users").get().public_avatar, 0);
  const req = await createRequest(db, 1, { kind: "data_deletion", message: "test request" }, NOW);
  assert.ok(req.id);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions").get().n, 1);
});
test("human-scored final ties require knowledge task, never random winner", async () => {
  const db = createDb();
  user(db, 1, 100);
  user(db, 2, 150);
  const s = await published(db);
  await freezeFinalists(db, s.id, NOW + 200);
  const r = rules(s);
  for (const id of [1, 2]) {
    await submitFinal(db, s.id, id, { q1: "test" }, r.final_start);
    await reviewFinal(db, s.id, { user_id: id, round: 1, score: 1, reason: "rubric" }, 9, r.final_end);
  }
  let scores = await finalScores(db, s.id, r.final_end);
  assert.equal(scores.needs_knowledge_tiebreak, true);
  assert.equal(scores.ready, false);
  await publishTiebreak(
    db,
    s.id,
    {
      text: "knowledge?",
      source: "test",
      rubric: "test",
      human_review_confirmed: true,
      starts_at: r.final_end + 1,
      ends_at: r.final_end + 100,
    },
    9,
    r.final_end,
  );
  for (const id of [1, 2]) {
    await tiebreak(db, s.id, id, r.final_end + 2, "answer");
    await reviewFinal(
      db,
      s.id,
      { user_id: id, score: id, tiebreak: true, reason: "knowledge rubric" },
      9,
      r.final_end + 101,
    );
  }
  scores = await finalScores(db, s.id, r.final_end + 102);
  assert.equal(scores.ready, true);
  assert.equal(scores.needs_knowledge_tiebreak, false);
});
test("migration preserves complete legacy ledger/answers/predictions and does not activate/reset", () => {
  const db = createDb({ upTo: 12 });
  db.raw.prepare("INSERT INTO users(id,first_name,created_at) VALUES(1,'Legacy',0)").run();
  tx(db, 1, 27, 0, "signup_bonus");
  const before = db.raw.prepare("SELECT * FROM transactions").all();
  db.applyRemaining(12);
  assert.deepEqual(db.raw.prepare("SELECT * FROM transactions").all(), before);
  assert.equal(balance(db, 1), 27);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM seasons").get().n, 0);
  assert.equal(db.raw.prepare("SELECT public_profile FROM users").get().public_profile, 0);
});

test("delayed freeze excludes both late rewards and late answers; zero denominators remain null", async () => {
  const db = createDb();
  user(db, 1, 99);
  const s = await published(db);
  await saveSettings(db, { every_days: 1, time_limit: 0, attempts: 2 }, NOW);
  const qz = await createQuiz(
    db,
    1,
    { title: "test", reward: 1, questions: [{ text: "Q", answers: ["a"], source: "test" }] },
    NOW,
  );
  const q = db.raw.prepare("SELECT id FROM quiz_questions WHERE quiz_id=?").get(qz).id;
  db.raw.prepare("UPDATE quizzes SET ends_at=? WHERE id=?").run(NOW + 300, qz);
  await openQuestion(db, 1, q, NOW + 1);
  await answerQuestion(db, 1, q, "bad", NOW + 2);
  await answerQuestion(db, 1, q, "a", NOW + 101); // direct-domain call emulates an already in-flight request
  await freezeFinalists(db, s.id, NOW + 200);
  const snap = db.raw.prepare("SELECT * FROM season_participants WHERE user_id=1").get();
  assert.equal(snap.qualified, 0);
  const st = JSON.parse(snap.statistics);
  assert.equal(st.quizzes, 0);
  assert.equal(st.quiz_percent, null);
  assert.equal(st.prediction_percent, null);
});

test("migration retains full legacy entities; leap century uses Gregorian calendar", () => {
  const db = createDb({ upTo: 12 });
  db.raw.exec(`INSERT INTO users(id,first_name,created_at) VALUES(1,'legacy',0);
 INSERT INTO transactions(user_id,amount,type,created_at) VALUES(1,200000,'signup_bonus',0);
 INSERT INTO quizzes(title,reward,position,starts_at,ends_at,created_by,created_at,updated_at) VALUES('legacy quiz',10000,1,1,100,1,0,0);
 INSERT INTO quiz_questions(quiz_id,position,text,answers) VALUES(1,1,'old question','["old answer"]');
 INSERT INTO quiz_answers(user_id,question_id,opened_at,attempts,correct,answer,answered_at) VALUES(1,1,2,1,1,'old answer',3);
 INSERT INTO matches(tournament,home,away,start_time,status,updated_at) VALUES('PL','a','b',100,'scheduled',0);
 INSERT INTO predictions(user_id,match_id,market,outcome,stake,price,status,payout,created_at,updated_at,settled_at) VALUES(1,1,'1x2','1',10000,2,'won',20000,1,120,120);`);
  const tables = ["transactions", "quizzes", "quiz_questions", "quiz_answers", "predictions", "matches"];
  const before = Object.fromEntries(
    tables.map((t) => [
      t,
      db.raw
        .prepare("SELECT * FROM " + t)
        .all()
        .map((r) => ({ ...r })),
    ]),
  );
  db.applyRemaining(12);
  for (const t of tables) {
    const after = db.raw
      .prepare("SELECT * FROM " + t)
      .all()
      .map((r) => Object.fromEntries(Object.keys(before[t][0]).map((k) => [k, r[k]])));
    assert.deepEqual(after, before[t], t);
  }
  assert.equal(db.raw.prepare("SELECT public_profile FROM users").get().public_profile, 0);
  const winter = calendarSeason(at("2100-02-28T12:00:00+03:00"));
  assert.equal((winter.ends_at - winter.starts_at) / 86400, 90);
});

test("season archive freezes qualification without final rules; preserves balance before rollout activation", async () => {
  const db = createDb();
  user(db, 1, 123);
  const s = await ensureCalendar(db, NOW);
  await advanceSeasons(db, at("2027-03-01T00:00:00+03:00"));
  assert.equal(balance(db, 1), 123);
  assert.equal(
    db.raw.prepare("SELECT closing_units FROM season_summaries WHERE user_id=1").get().closing_units,
    123 * U,
  );
  const b = await leaderboard(db, { userId: 1, seasonId: s.id, ts: at("2027-03-01T00:00:01+03:00") });
  assert.equal(b.qualification_unavailable, false);
  assert.equal(b.rows[0].qualified, true);
  assert.equal(b.rows[0].closing_balance, undefined);
  assert.equal(b.rows[0].closing_units, undefined);
});

test("DB protects published terms and frozen facts against stale/concurrent writes", async () => {
  const db = createDb();
  user(db, 1, 100);
  const s = await published(db);
  await freezeFinalists(db, s.id, NOW + 200);
  assert.throws(
    () => db.raw.prepare("UPDATE final_rules SET body=? WHERE season_id=?").run("{}", s.id),
    /immutable/,
  );
  assert.throws(
    () => db.raw.prepare("UPDATE season_participants SET qualified=0 WHERE season_id=?").run(s.id),
    /immutable/,
  );
  await decideFinalist(
    db,
    s.id,
    { user_id: 1, admitted: false, reason: "test separate decision" },
    1,
    NOW + 201,
  );
  const b = await leaderboard(db, { userId: 1, ts: NOW + 202 });
  assert.equal(b.me.qualified, true); // immutable original qualification
  const own = await seasonState(db, 1, NOW + 203);
  assert.equal(own.admission_decision.admitted, 0);
});

test("approved boundary policy: no next-season bets; refund unsettled into old archive, reset exactly 10 once", async () => {
  const { placePrediction, isOpen, settleMatch } = await import("../src/predictions.js");
  const db = createDb();
  user(db, 1, 101);
  user(db, 2, 102);
  const s = await ensureCalendar(db, NOW);
  const match = (start) =>
    db.raw
      .prepare(
        "INSERT INTO matches(tournament,home,away,start_time,odds_updated_at,updated_at) VALUES('PL','A','B',?,?,?) RETURNING *",
      )
      .get(start, NOW, NOW);
  const late = match(NOW + 200),
    pending = match(s.ends_at - 100),
    future = match(s.ends_at);
  for (const m of [late, pending, future]) db.raw.prepare("INSERT INTO odds VALUES(?,'1x2','1',2)").run(m.id);
  await configureSeasonPolicy(
    db,
    {
      opening_bist: 10,
      pending_policy: "refund_old_season",
      repeat_each_season: true,
      owner_approved: true,
      reason: "test approved policy",
    },
    1,
    NOW,
  );
  assert.equal(balance(db, 1), 101); // configuration preserves the active season
  await placePrediction(db, 1, { match_id: late.id, market: "1x2", outcome: "1", stake: 2 }, NOW);
  await placePrediction(db, 2, { match_id: pending.id, market: "1x2", outcome: "1", stake: 5 }, NOW);
  assert.equal(isOpen(future, NOW), false);
  await assert.rejects(
    placePrediction(db, 1, { match_id: future.id, market: "1x2", outcome: "1", stake: 1 }, NOW),
    /закрыт/,
  );
  await advanceSeasons(db, NOW + 100); // cutoff without final rules
  await settleMatch(db, late, [1, 0], NOW + 300);
  assert.equal(balance(db, 1), 103);
  assert.equal((await seasonState(db, 1, NOW + 301)).qualified, false); // late winnings affect statistics only
  assert.equal((await leaderboard(db, { userId: 1, ts: NOW + 301 })).me.prediction_percent, 100);
  await advanceSeasons(db, s.ends_at + 60); // delayed boundary cron
  await advanceSeasons(db, s.ends_at + 61);
  assert.equal(balance(db, 1), 10);
  assert.equal(balance(db, 2), 10);
  const p = db.raw.prepare("SELECT * FROM predictions WHERE user_id=2").get();
  assert.equal(p.status, "refunded");
  assert.equal(p.settled_at, s.ends_at - 1);
  const refund = db.raw.prepare("SELECT * FROM transactions WHERE user_id=2 AND type='refund'").get();
  assert.equal(refund.amount, 5 * U);
  assert.equal(refund.created_at, s.ends_at - 1);
  assert.equal(
    db.raw.prepare("SELECT closing_units FROM season_summaries WHERE user_id=2").get().closing_units,
    102 * U,
  );
  assert.equal(
    db.raw.prepare("SELECT qualified FROM season_participants WHERE season_id=? AND user_id=2").get(s.id)
      .qualified,
    0,
  );
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='season_opening'").get().n, 2);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='refund'").get().n, 1);
  assert.equal(
    db.raw.prepare("SELECT COUNT(*) n FROM content_versions WHERE kind='prediction_cancellation'").get().n,
    1,
  );
  await settleMatch(db, pending, [1, 0], s.ends_at + 70);
  assert.equal(balance(db, 2), 10); // canceled old forecast cannot earn a new-season payout
  assert.equal((await leaderboard(db, { userId: 2, seasonId: s.id, ts: s.ends_at + 71 })).me.predictions, 0);
});

test("final planning may follow automatic cutoff; drafts never grant entry; opt-out unchecked is not ad consent", async () => {
  const db = createDb();
  user(db, 1, 100);
  const s = await ensureCalendar(db, NOW);
  await advanceSeasons(db, NOW + 100);
  assert.equal((await seasonState(db, 1, NOW + 101)).qualified, true);
  await saveFinalRules(db, s.id, rules(s), 1, NOW + 102);
  await assert.rejects(enterFinal(db, s.id, 1, rules(s).final_start), /не опубликованы/);
  await saveFinalRules(db, s.id, rules(s), 1, NOW + 103, { publish: true });
  assert.equal((await enterFinal(db, s.id, 1, rules(s).final_start)).attempts, 1);
  assert.equal(db.raw.prepare("SELECT marketing_opt_out FROM users WHERE id=1").get().marketing_opt_out, 0);
  await savePreferences(db, 1, { marketing_opt_out: true }, NOW + 104);
  assert.equal(db.raw.prepare("SELECT marketing_opt_out FROM users WHERE id=1").get().marketing_opt_out, 1);
  await savePreferences(db, 1, { marketing_opt_out: false }, NOW + 105);
  assert.equal(db.raw.prepare("SELECT marketing_opt_in FROM users WHERE id=1").get().marketing_opt_in, 0);
  assert.equal(await sendMarketing(db, "fake-token", 1, "not sent"), false);
});
