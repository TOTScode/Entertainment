import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { UNIT } from "../src/money.js";
import {
  cancelMatch, cancelPrediction, correctionStatements, getMatch, listMatches, payoutUnits, placePrediction, settleMatch,
} from "../src/predictions.js";
import { saveOdds, sync } from "../src/sync.js";
import { opOdds } from "../src/providers.js";
import { createDb, roundTrips } from "./fake-d1.js";

const NOW = 1_800_000_000;
let db;

function addUser(id, bist = 100) {
  db.raw.prepare("INSERT INTO users (id, first_name, created_at) VALUES (?, ?, 0)").run(id, `U${id}`);
  db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (?, ?, 'signup_bonus', 0)").run(id, bist * UNIT);
}
const balance = (id) => db.raw.prepare("SELECT SUM(amount) AS b FROM transactions WHERE user_id = ?").get(id).b / UNIT;
const match = (id) => db.raw.prepare("SELECT * FROM matches WHERE id = ?").get(id);

async function addMatch({ start = NOW + 3600, oddsAt = NOW, tournament = "PL", op = "op1" } = {}) {
  await saveOdds(db, tournament, [{
    op_id: op, home: "Chelsea", away: "Manchester United", start_time: start, status: "scheduled",
    odds: [
      { market: "1x2", outcome: "1", price: 2 }, { market: "1x2", outcome: "X", price: 3.5 }, { market: "1x2", outcome: "2", price: 4.1 },
      { market: "score", outcome: "2:1", price: 9 }, { market: "score", outcome: "1:1", price: 6.5 },
    ],
  }], oddsAt);
  return db.raw.prepare("SELECT id FROM matches WHERE op_id = ?").get(op).id;
}

beforeEach(() => {
  db = createDb();
  addUser(1);
  addUser(2);
});

test("выплата по формуле: 10 BIST × 2.00 с комиссией 7% = 19.3", () => {
  assert.equal(payoutUnits(10 * UNIT, 2, 7), 19.3 * UNIT);
  assert.equal(payoutUnits(10 * UNIT, 9, 10), 82 * UNIT); // 10 + 10 × 8 × 0.9
  assert.equal(payoutUnits(3 * UNIT, 1.87, 7), 5.4273 * UNIT); // 3 + 3 × 0.87 × 0.93
});

test("ставка: лимиты, баланс, коэффициент фиксируется", async () => {
  const id = await addMatch();
  const bet = (stake, uid = 1, outcome = "1") => placePrediction(db, uid, { match_id: id, market: "1x2", outcome, stake }, NOW);
  await assert.rejects(bet(0), /от 1 до 100/);
  await assert.rejects(bet(101), /от 1 до 100/);
  await assert.rejects(bet(1.5), /от 1 до 100/);
  await assert.rejects(placePrediction(db, 1, { match_id: id, market: "1x2", outcome: "5", stake: 1 }, NOW), /Нет коэффициента/);

  db.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (2, ?, 'admin_adjustment', 0)").run(-95 * UNIT);
  await assert.rejects(bet(10, 2), /Недостаточно BIST/);
  assert.equal(balance(2), 5);

  const res = await bet(10);
  assert.equal(res.balance, 90);
  assert.equal(res.prediction.price, 2);
  assert.equal(res.prediction.payout, 19.3);
  // Исход и точный счёт одновременно
  await placePrediction(db, 1, { match_id: id, market: "score", outcome: "2:1", stake: 5 }, NOW);
  assert.equal(balance(1), 85);
  // Новые коэффициенты не меняют уже принятый прогноз
  await saveOdds(db, "PL", [{ op_id: "op1", home: "Chelsea", away: "Manchester United", start_time: NOW + 3600, status: "scheduled", odds: [{ market: "1x2", outcome: "1", price: 1.5 }] }], NOW);
  assert.equal((await getMatch(db, 1, id, NOW)).my[0].price, 2);
});

test("приём закрыт после начала матча и без свежих коэффициентов", async () => {
  const started = await addMatch({ start: NOW - 60, op: "a" });
  await assert.rejects(placePrediction(db, 1, { match_id: started, market: "1x2", outcome: "1", stake: 1 }, NOW), /закрыт/);
  const stale = await addMatch({ oddsAt: NOW - 31 * 3600, op: "b" });
  await assert.rejects(placePrediction(db, 1, { match_id: stale, market: "1x2", outcome: "1", stake: 1 }, NOW), /закрыт/);
  // Даже в обход проверок база не примет прогноз на начавшийся матч
  assert.throws(
    () => db.raw.prepare("INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, commission, created_at, updated_at) VALUES (1, ?, '1x2', '1', 1, 2, 7, ?, ?)").run(started, NOW, NOW),
    /match_closed/,
  );
});

test("замена и отмена: не чаще раза в 5 минут, сумму можно менять", async () => {
  const id = await addMatch();
  const bet = (outcome, stake, at) => placePrediction(db, 1, { match_id: id, market: "1x2", outcome, stake }, at);
  const first = await bet("1", 10, NOW);
  await assert.rejects(bet("X", 20, NOW + 299), /через 1 мин/);
  const second = await bet("X", 20, NOW + 300);
  assert.equal(second.replaced, true);
  assert.equal(second.balance, 80);
  assert.equal(second.prediction.price, 3.5);
  const rows = db.raw.prepare("SELECT status FROM predictions ORDER BY id").all().map((r) => r.status);
  assert.deepEqual(rows, ["replaced", "active"]);

  await assert.rejects(cancelPrediction(db, 1, second.prediction.id, NOW + 500), /через/);
  const cancelled = await cancelPrediction(db, 1, second.prediction.id, NOW + 600);
  assert.equal(cancelled.balance, 100);
  // После отмены новая ставка — тоже через 5 минут
  await assert.rejects(bet("1", 1, NOW + 700), /через/);
  await bet("1", 1, NOW + 900);
  const types = db.raw.prepare("SELECT type, amount / ? AS a FROM transactions WHERE user_id = 1 AND type != 'signup_bonus' ORDER BY id").all(UNIT);
  assert.deepEqual(types.map((t) => [t.type, t.a]), [["bet", -10], ["refund", 10], ["bet", -20], ["refund", 20], ["bet", -1]]);
  assert.ok(first.prediction.id);
});

test("расчёт: выигрыш по формуле, повторный расчёт ничего не начисляет", async () => {
  const id = await addMatch();
  await placePrediction(db, 1, { match_id: id, market: "1x2", outcome: "1", stake: 10 }, NOW);
  await placePrediction(db, 1, { match_id: id, market: "score", outcome: "2:1", stake: 10 }, NOW);
  await placePrediction(db, 2, { match_id: id, market: "1x2", outcome: "2", stake: 10 }, NOW);
  assert.equal(await settleMatch(db, match(id), [2, 1], NOW + 9000), true);
  assert.equal(balance(1), 80 + 19.3 + 82);
  assert.equal(balance(2), 90);
  assert.equal(await settleMatch(db, match(id), [2, 1], NOW + 9100), false);
  assert.equal(balance(1), 181.3);
  const statuses = db.raw.prepare("SELECT user_id, market, status FROM predictions ORDER BY id").all().map((r) => `${r.user_id}${r.market}${r.status}`);
  assert.deepEqual(statuses, ["11x2won", "1scorewon", "21x2lost"]);
  assert.equal(match(id).status, "finished");
});

test("отмена матча возвращает ставки, исправление счёта пересчитывает выигрыши", async () => {
  const a = await addMatch({ op: "a" });
  await placePrediction(db, 1, { match_id: a, market: "1x2", outcome: "1", stake: 10 }, NOW);
  await cancelMatch(db, match(a), NOW + 9000);
  assert.equal(balance(1), 100);
  assert.equal(db.raw.prepare("SELECT status FROM predictions").get().status, "refunded");

  const b = await addMatch({ op: "b" });
  await placePrediction(db, 1, { match_id: b, market: "1x2", outcome: "1", stake: 10 }, NOW);
  await placePrediction(db, 2, { match_id: b, market: "1x2", outcome: "X", stake: 10 }, NOW);
  await settleMatch(db, match(b), [1, 0], NOW + 9000);
  assert.equal(balance(1), 109.3);
  // Админ исправил счёт на 1:1 — выигрыш первого списан, второй получил свой
  await db.batch(correctionStatements(db, match(b), [1, 1], NOW + 9500));
  assert.equal(balance(1), 90);
  assert.equal(balance(2), 90 + 10 + 10 * 2.5 * 0.93);
  assert.equal(match(b).settle_version, 2);
});

test("коэффициенты из ответа OddsPapi и перенос матча", async () => {
  const fixture = {
    bookmakerOdds: {
      pinnacle: {
        markets: {
          101: { outcomes: { 101: { players: { 0: { price: 1.8 } } }, 102: { players: { 0: { price: 4.07 } } }, 103: { players: { 0: { price: 4.26, active: false } } } } },
          10336: { outcomes: { 10346: { players: { 0: { price: 9.5 } } }, 10399: { players: { 0: { price: 1 } } } } },
          1012: { outcomes: { 1012: { players: { 0: { price: 2 } } } } },
        },
      },
    },
  };
  assert.deepEqual(opOdds(fixture), [
    { market: "1x2", outcome: "1", price: 1.8 },
    { market: "1x2", outcome: "X", price: 4.07 },
    { market: "score", outcome: "2:1", price: 9.5 },
  ]);

  const id = await addMatch();
  await saveOdds(db, "PL", [{ op_id: "op1", home: "Chelsea", away: "Manchester United", start_time: NOW + 86400 * 7, status: "scheduled", odds: [] }], NOW + 10);
  assert.equal(match(id).start_time, NOW + 86400 * 7);
  // Пустой ответ по коэффициентам не стирает прежние
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM odds WHERE match_id = ?").get(id).n, 5);
});

test("синхронизация: результат АПЛ из football-data.org, ЛЕ из OddsPapi, резерв лимита", async () => {
  const pl = await addMatch({ op: "pl1", start: NOW - 3 * 3600, oddsAt: NOW - 4 * 3600 });
  const el = await addMatch({ op: "el1", tournament: "EL", start: NOW - 3 * 3600, oddsAt: NOW - 4 * 3600 });
  db.raw.prepare("INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, commission, created_at, updated_at) VALUES (1, ?, '1x2', '1', ?, 2, 7, ?, ?)").run(pl, 10 * UNIT, NOW - 4 * 3600, NOW - 4 * 3600);
  db.raw.prepare("INSERT INTO predictions (user_id, match_id, market, outcome, stake, price, commission, created_at, updated_at) VALUES (2, ?, 'score', '1:1', ?, 6.5, 10, ?, ?)").run(el, 10 * UNIT, NOW - 4 * 3600, NOW - 4 * 3600);

  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const body = (() => {
      if (u.pathname === "/v4/account") return { current_subscription_id: 1, subscriptions: [{ subscription_id: 1, request_limit: 250, request_count: 208 }] };
      if (u.pathname.startsWith("/v4/competitions/PL")) return { matches: [{ id: 99, status: "FINISHED", utcDate: new Date((NOW - 3 * 3600) * 1000).toISOString(), homeTeam: { name: "Chelsea FC", shortName: "Chelsea" }, awayTeam: { name: "Manchester United FC", shortName: "Man United" }, score: { duration: "EXTRA_TIME", fullTime: { home: 3, away: 2 }, regularTime: { home: 2, away: 2 } } }] };
      if (u.pathname === "/v4/fixtures") return [{ fixtureId: "el1", startTime: new Date((NOW - 3 * 3600) * 1000).toISOString(), statusName: "Finished" }];
      if (u.pathname === "/v4/scores") return { scores: { periods: { fulltime: { participant1Score: 1, participant2Score: 1 }, result: { participant1Score: 2, participant2Score: 1 } } } };
      if (u.pathname === "/v4/odds-by-tournaments") return [];
      return {};
    })();
    return new Response(JSON.stringify(body));
  };
  const log = await sync({ DB: db, FOOTBALL_DATA_TOKEN: "t", ODDSPAPI_KEY: "k" }, NOW);
  // Основное время АПЛ 2:2 (без дополнительного) — исход «1» проиграл
  assert.equal(match(pl).status, "finished");
  assert.deepEqual([match(pl).home_score, match(pl).away_score], [2, 2]);
  assert.equal(match(pl).fd_id, 99);
  // ЛЕ 1:1 в основное время — точный счёт сыграл: 10 + 10 × 5.5 × 0.9
  assert.equal(balance(2), 100 + 59.5); // ставка в тесте записана без списания
  // Было 42 запроса, 2 ушли на результаты ЛЕ; оставшиеся 40 — резерв, на коэффициенты их тратить нельзя
  assert.ok(!calls.includes("/v4/odds-by-tournaments"), calls.join(","));
  assert.ok(log.some((l) => l.includes("лимит OddsPapi")));
});

test("список матчей: одно обращение к базе, коэффициенты на исход и мои прогнозы", async () => {
  const id = await addMatch();
  await placePrediction(db, 1, { match_id: id, market: "1x2", outcome: "X", stake: 3 }, NOW);
  roundTrips.count = 0;
  const list = await listMatches(db, 1, { now: NOW });
  assert.equal(roundTrips.count, 1);
  assert.equal(list.tournaments.length, 6);
  const m = list.matches[0];
  assert.deepEqual(m.odds, { 1: 2, X: 3.5, 2: 4.1 });
  assert.equal(m.open, true);
  assert.equal(m.has_score, true);
  assert.equal(m.my[0].outcome, "X");
  assert.equal(m.my[0].next_change_at, NOW + 300);
});

test("история показывает матч и исход для операций по прогнозам", async () => {
  const { history } = await import("../src/leaderboard.js");
  const id = await addMatch();
  await placePrediction(db, 1, { match_id: id, market: "score", outcome: "2:1", stake: 4 }, NOW);
  const h = await history(db, 1);
  assert.deepEqual([h.items[0].type, h.items[0].amount, h.items[0].match, h.items[0].outcome], ["bet", -4, "Chelsea — Manchester United", "2:1"]);
  assert.equal(h.items[1].match, null);
});
