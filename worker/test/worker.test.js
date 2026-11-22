import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";

import worker from "../src/index.js";
import { addTransaction, getBalance, LedgerError, yearsSince } from "../src/users.js";
import { createDb, roundTrips } from "./fake-d1.js";
import { UNIT } from "../src/money.js";

const TOKEN = "123:TEST";
const ADMIN = 1;

function initData(user, token = TOKEN) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  fields.hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams(fields).toString();
}

let env;
let sent;
beforeEach(() => {
  env = {
    DB: createDb(),
    BOT_TOKEN: TOKEN + "\n",
    START_BALANCE: "10",
    ADMIN_IDS: `${ADMIN}, 999`,
    ASSETS: { fetch: async () => new Response("asset") },
  };
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}");
  };
});

async function call(path, user, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["X-Telegram-Init-Data"] = initData(user);
  const res = await worker.fetch(
    new Request(`https://tots.test${path}`, { method, headers, body: body && JSON.stringify(body) }),
    env,
  );
  return { status: res.status, data: await res.json().catch(() => null) };
}

const alexey = { id: 7, first_name: "Алексей", username: "greendend" };

test("profile flows count only lost stakes and net winnings, including corrected results", async () => {
  const { placePrediction, settleMatch, cancelMatch, correctionStatements } = await import('../src/predictions.js');
  const ts = Date.parse('2026-12-10T12:00:00+03:00') / 1000;
  await call('/api/me', alexey);
  const stats = async (expected) => {
    assert.deepEqual((await call('/api/me', alexey)).data.stats, expected);
    assert.deepEqual((await call('/api/users/7', alexey)).data.stats, expected);
  };
  const create = async () => {
    const match = env.DB.raw.prepare("INSERT INTO matches(tournament,home,away,start_time,odds_updated_at,updated_at) VALUES('PL','A','B',?,?,?) RETURNING *").get(ts+3600,ts,ts);
    env.DB.raw.prepare("INSERT INTO odds VALUES(?,'1x2','1',3)").run(match.id);
    await placePrediction(env.DB, 7, {match_id:match.id,market:'1x2',outcome:'1',stake:10}, ts);
    return match;
  };
  const won = await create();
  await stats({earned:10,spent:0}); // active 10 is reserved, not spent
  await settleMatch(env.DB, won, [1,0], ts+7200);
  await stats({earned:30,spent:0}); // signup 10 + profit 20; payout is 30
  const cancelled = await create();
  await cancelMatch(env.DB, cancelled, ts+7200);
  await stats({earned:30,spent:0});
  const lost = await create();
  await settleMatch(env.DB, lost, [0,1], ts+7200);
  await stats({earned:30,spent:10});
  await env.DB.batch(correctionStatements(env.DB, {...won,settle_version:1}, [0,1], ts+7300));
  await stats({earned:10,spent:20});
  await env.DB.batch(correctionStatements(env.DB, {...won,settle_version:2}, [1,0], ts+7400));
  await stats({earned:30,spent:10});
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE type='payout_reversal'").get().n,1);
});

test("без подписи Telegram API недоступно", async () => {
  assert.equal((await call("/api/me")).status, 401);
});

test("регистрация начисляет 10 BIST один раз", async () => {
  const first = await call("/api/me", alexey);
  assert.equal(first.data.balance, 10);
  assert.equal(first.data.is_new, true);
  assert.equal(first.data.years_in_tots, 0);
  const second = await call("/api/me", { ...alexey, first_name: "Лёша" });
  assert.equal(second.data.balance, 10);
  assert.equal(second.data.is_new, false);
  assert.equal(second.data.name, "Лёша");
});

test("баланс равен сумме транзакций и не уходит в минус", async () => {
  await call("/api/me", alexey);
  await addTransaction(env.DB, { userId: 7, amount: 5 * UNIT, type: "quiz_reward" });
  await addTransaction(env.DB, { userId: 7, amount: -15 * UNIT, type: "bet" });
  assert.equal(await getBalance(env.DB, 7), 0);
  await assert.rejects(addTransaction(env.DB, { userId: 7, amount: -1, type: "bet" }), LedgerError);
  // Триггер в базе не даёт уйти в минус и при прямой записи
  assert.throws(() => env.DB.raw.prepare("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (7, -1, 'bet', 0)").run(), /insufficient_balance/);
  const sum = env.DB.raw.prepare("SELECT SUM(amount) AS s FROM transactions WHERE user_id = 7").get().s;
  assert.equal(sum, 0);
  assert.equal((await call("/api/me", alexey)).data.balance, 0);
});

test("ник нельзя изменить или сбросить прямым запросом", async () => {
  await call("/api/me", alexey);
  env.DB.raw.prepare("UPDATE users SET nickname = 'Гол Мастер', nickname_key = 'гол мастер' WHERE id = 7").run();
  for (const nickname of ["Другой ник", ""]) {
    const result = await call("/api/nickname", alexey, { method: "POST", body: { nickname } });
    assert.equal(result.status, 403);
    assert.equal(result.data.error, "Изменение ника недоступно");
    assert.equal((await call("/api/me", alexey)).data.name, "Гол Мастер");
  }
});

test("админка: доступ только из ADMIN_IDS, корректировка пишется в журнал и аудит", async () => {
  await call("/api/me", alexey);
  assert.equal((await call("/api/admin/users?q=green", alexey)).status, 403);

  const admin = { id: ADMIN, first_name: "Админ" };
  assert.equal((await call("/api/me", admin)).data.is_admin, true);
  const found = await call("/api/admin/users?q=@greendend", admin);
  assert.equal(found.data.users[0].id, 7);

  const noReason = await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: 5, reason: " " } });
  assert.equal(noReason.status, 400);
  const tooMuch = await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: -11, reason: "штраф" } });
  assert.equal(tooMuch.status, 409);

  const adj = await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: 25, reason: "Победа в конкурсе" } });
  assert.equal(adj.data.user.balance, 35);
  const tx = env.DB.raw.prepare("SELECT * FROM transactions WHERE type = 'admin_adjustment'").get();
  assert.equal(tx.amount, 25 * UNIT);
  assert.equal(tx.ref, `audit:${adj.data.audit_id}`);

  const audit = await call("/api/admin/audit", admin);
  assert.equal(audit.data.entries.length, 1);
  assert.deepEqual(audit.data.entries[0].before, { balance: 10 });
  assert.equal(audit.data.entries[0].after.balance, 35);
  assert.equal(audit.data.entries[0].reason, "Победа в конкурсе");
});

test("миграция переносит существующие балансы в журнал", () => {
  const db = createDb({ upTo: 1 });
  db.raw.exec("INSERT INTO users (id, first_name, balance, created_at) VALUES (1, 'A', 10, 0), (2, 'B', 37, 0)");
  db.applyRemaining(1);
  const rows = db.raw.prepare("SELECT user_id, SUM(amount) AS b FROM transactions GROUP BY user_id ORDER BY user_id").all();
  assert.deepEqual(rows.map((r) => [r.user_id, r.b]), [[1, 10 * UNIT], [2, 37 * UNIT]]);
});

test("стаж считается в полных годах", () => {
  const reg = Date.UTC(2024, 9, 27) / 1000;
  assert.equal(yearsSince(reg, new Date(Date.UTC(2025, 9, 26))), 0);
  assert.equal(yearsSince(reg, new Date(Date.UTC(2025, 9, 27))), 1);
  assert.equal(yearsSince(reg, new Date(Date.UTC(2027, 0, 1))), 2);
});

test("вебхук: чужой секрет отклоняется, /start отвечает кнопкой приложения, /id — ID", async () => {
  const hook = (secret, text) =>
    worker.fetch(
      new Request("https://tots.test/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({ message: { text, chat: { id: 55 }, from: { id: 55 } } }),
      }),
      env,
    );
  assert.equal((await hook("wrong", "/start")).status, 403);

  const secret = createHash("sha256").update(TOKEN).digest("hex").slice(0, 32);
  assert.equal((await hook(secret, "/start")).status, 200);
  assert.equal(sent[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(sent[0].body.reply_markup.inline_keyboard[0][0].web_app.url, "https://tots.test/");

  await hook(secret, "/id");
  assert.match(sent[1].body.text, /55/);
});

test("API таблицы, истории и статистики", async () => {
  await call("/api/me", alexey);
  await call("/api/me", { id: 8, first_name: "Иван" });
  const me = await call("/api/me", alexey);
  assert.deepEqual(me.data.stats, { earned: 10, spent: 0 });

  const board = await call("/api/leaderboard?period=week", alexey);
  assert.equal(board.data.sort, "quiz_rating_desc");
  assert.equal(board.data.rows.length, 0); // no publication without consent
  assert.equal(board.data.me.id, 7);

  const hist = await call("/api/history", alexey);
  assert.deepEqual(hist.data.items.map((t) => [t.amount, t.type]), [[10, "signup_bonus"]]);
  assert.equal((await call("/api/leaderboard")).status, 401);
});

test("расписание до старта создаёт только первый зимний сезон", async () => {
  await call("/api/me", alexey);
  const waits = [];
  await worker.scheduled({ cron: "1 21 * * *", scheduledTime: Date.UTC(2026, 9, 27, 21, 1) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const row = env.DB.raw.prepare("SELECT * FROM rank_snapshots").get();
  assert.equal(row, undefined);
  assert.equal(env.DB.raw.prepare("SELECT id FROM seasons WHERE id='2026-winter'").get().id, "2026-winter");
});

test("история показывает причину корректировки, чужой профиль открывается без истории", async () => {
  await call("/api/me", alexey);
  const admin = { id: ADMIN, first_name: "Админ", username: "boss" };
  await call("/api/me", admin);
  await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: 5, reason: "Лучший комментарий" } });

  const hist = await call("/api/history", alexey);
  assert.deepEqual(hist.data.items.map((t) => [t.type, t.reason]), [["admin_adjustment", "Лучший комментарий"], ["signup_bonus", null]]);

  const other = await call("/api/users/1", alexey);
  assert.equal(other.status,404); // private by default
  const owner=await call('/api/users/1',admin);
  assert.equal(owner.data.balance,10);
  env.DB.raw.prepare('UPDATE users SET public_profile=1 WHERE id=1').run();
  const visible=await call('/api/users/1',alexey);
  for(const k of ['balance','stats','username','registered_at','rank'])assert.equal(visible.data[k],undefined,k);
  assert.equal((await call("/api/users/404", alexey)).status, 404);
});

test("запросы не делают N+1; история и проверка политики — два обращения", async () => {
  await call("/api/me", alexey);
  await call("/api/me", { id: 8, first_name: "Иван" });
  env.DB.raw.prepare("UPDATE users SET public_profile=1").run();
  for (const path of ["/api/me", "/api/leaderboard", "/api/leaderboard?period=week", "/api/users/8", "/api/history"]) {
    roundTrips.count = 0;
    assert.equal((await call(path, alexey)).status, 200);
    assert.ok(roundTrips.count <= 15, path+" bounded trips: "+roundTrips.count);
    if(path === "/api/history")assert.equal(roundTrips.count,2);
  }
});

test("админка: история операций любого пользователя", async () => {
  await call("/api/me", alexey);
  const admin = { id: ADMIN, first_name: "Админ" };
  await call("/api/me", admin);
  await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: -3, reason: "Флуд" } });
  assert.equal((await call("/api/admin/history?user_id=1", alexey)).status, 403);
  const hist = await call("/api/admin/history?user_id=7", admin);
  assert.deepEqual(hist.data.items.map((t) => [t.amount, t.reason]), [[-3, "Флуд"], [10, null]]);
});

test("дробные BIST: перенос журнала без изменения балансов и корректировка с десятыми", async () => {
  const db = createDb({ upTo: 3 });
  db.raw.exec("INSERT INTO users (id, first_name, created_at) VALUES (1, 'A', 0)");
  db.raw.exec("INSERT INTO transactions (user_id, amount, type, created_at) VALUES (1, 10, 'signup_bonus', 0), (1, 27, 'admin_adjustment', 0)");
  db.applyRemaining(3);
  assert.equal(db.raw.prepare("SELECT SUM(amount) AS b FROM transactions").get().b, 37 * UNIT);

  await call("/api/me", alexey);
  const admin = { id: ADMIN, first_name: "Админ" };
  await call("/api/me", admin);
  const ok = await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: 2.5, reason: "Полбалла" } });
  assert.equal(ok.data.user.balance, 12.5);
  const bad = await call("/api/admin/adjust", admin, { method: "POST", body: { user_id: 7, amount: 0.25, reason: "x" } });
  assert.equal(bad.status, 400);
  assert.equal((await call("/api/me", alexey)).data.balance, 12.5);
  assert.equal((await call("/api/history", alexey)).data.items[0].amount, 2.5);
});

test('privacy API: no public monetary fields; owner and authorized admin only; requests cannot be read by others',async()=>{
 const owner={id:7,first_name:'A'},stranger={id:8,first_name:'B'},admin={id:ADMIN,first_name:'Admin'};
 for(const u of [owner,stranger,admin])await call('/api/me',u);
 env.DB.raw.prepare('UPDATE users SET public_profile=1,public_avatar=0 WHERE id=7').run();
 const res=await call('/api/users/7',stranger);assert.equal(res.status,200);
 for(const k of ['balance','stats','stake','payout','username','registered_at','rank'])assert.equal(res.data[k],undefined,k);
 assert.equal(res.data.photo_url,null);assert.equal((await call('/api/users/7',owner)).data.balance,10);assert.equal((await call('/api/users/7',admin)).data.balance,10);
 assert.equal((await call('/api/admin/history?user_id=7',stranger)).status,403);
 const ownHistory=await call('/api/history?user_id=7',stranger);assert.ok(ownHistory.data.items.every(t=>t.amount===10));
 assert.equal((await call('/api/preferences',stranger,{method:'PUT',body:{public_profile:true,confirm_consent:true}})).status,400);
 const report=await call('/api/requests',owner,{method:'POST',body:{kind:'data_correction',message:'test personal correction'}});assert.equal(report.status,201);
 assert.equal((await call('/api/requests',stranger)).data.items.length,0);assert.equal((await call('/api/requests',owner)).data.items.length,1);
 assert.equal((await call('/api/admin/requests',stranger)).status,403);assert.equal((await call('/api/admin/requests',admin)).data.items.length,1);
 const board=await call('/api/leaderboard?sort=balance',stranger);assert.equal(board.data.sort,'quiz_rating_desc');for(const r of board.data.rows)assert.equal(r.balance,undefined);
});

test('processing consent: public policy precedes registration; separate versioned grant and withdrawal',async()=>{
 const admin={id:ADMIN,first_name:'Admin'},fresh={id:77,first_name:'New'};await call('/api/me',admin);
 const policy={operator:'test operator',operator_address:'test address',contacts:'test@example.invalid',policy_text:'test-only policy',purposes:'test',legal_bases:'test',retention:'test',rights:'test',personal_data:'test',operations:'test',withdrawal:'test',cross_border_basis:'test',age_requirements:'test',processing_basis:'consent',processing_legal_reference:'test',processing_consent:'test consent',publication_consent:'test profile consent',avatar_consent:'test avatar consent',marketing_consent:'test ads consent',services:[{name:'test',purpose:'test',countries:['test']}],legal_review_confirmed:true};
 assert.equal((await call('/api/admin/policy',admin,{method:'PUT',body:{version:'test-1',publish:true,policy}})).status,200);
 assert.equal((await call('/api/policy')).data.policy.version,'test-1');
 assert.equal((await call('/api/me',fresh)).status,403);assert.equal(env.DB.raw.prepare('SELECT id FROM users WHERE id=77').get(),undefined);
 assert.equal((await call('/api/consents',fresh,{method:'POST',body:{granted:true,policy_version:'test-1',confirm_consent:true}})).status,200);
 assert.equal((await call('/api/me',fresh)).status,200);
 assert.equal((await call('/api/preferences',fresh,{method:'PUT',body:{public_profile:true,public_avatar:true,marketing_opt_in:true,policy_version:'test-1',confirm_consent:true}})).status,200);
 assert.equal((await call('/api/consents',fresh,{method:'POST',body:{granted:false}})).status,200);
 assert.equal((await call('/api/matches',fresh)).status,403);
 assert.equal(env.DB.raw.prepare('SELECT public_profile FROM users WHERE id=77').get().public_profile,0);
 assert.equal((await call('/api/requests',fresh,{method:'POST',body:{kind:'data_deletion',message:'test withdrawal request'}})).status,201);
 assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id=77 AND type='signup_bonus'").get().n,1);
});

test('admin prediction exception is server-authorized; forged flags fail; normal balance and seasonal exclusion',async()=>{
 const originalNow=Date.now;let clock=Date.parse('2026-12-10T12:00:00+03:00')/1000;Date.now=()=>clock*1000;
 try {
  const player={id:7,first_name:'Player'},admin={id:ADMIN,first_name:'Admin'};
  await call('/api/me',player);await call('/api/me',admin);
  env.DB.raw.prepare('UPDATE users SET public_profile=1').run();
  const old=env.DB.raw.prepare("INSERT INTO matches(tournament,home,away,start_time,status,home_score,away_score,odds_updated_at,settled_at,settle_version,updated_at) VALUES('PL','A','B',?,'finished',1,0,?,?,1,?) RETURNING id").get(clock-1000000,clock-1000000,clock-1,clock).id;
  env.DB.raw.prepare("INSERT INTO odds VALUES(?,'1x2','1',2)").run(old);
  const payload={match_id:old,market:'1x2',outcome:'1',stake:1,is_admin_test:true,admin:true};
  assert.equal((await call('/api/predictions',player,{method:'POST',body:payload})).status,409);
  const result=await call('/api/predictions',admin,{method:'POST',body:payload});assert.equal(result.status,409);
  assert.equal((await call('/api/matches/'+old,admin)).data.open,false);assert.equal((await call('/api/matches/'+old,player)).data.open,false);
  const future=env.DB.raw.prepare("INSERT INTO matches(tournament,home,away,start_time,odds_updated_at,updated_at) VALUES('PL','C','D',?,?,?) RETURNING *").get(clock+60,clock,clock);
  env.DB.raw.prepare("INSERT INTO odds VALUES(?,'1x2','1',2)").run(future.id);
  const real=await call('/api/predictions',player,{method:'POST',body:{...payload,match_id:future.id}});assert.equal(real.status,200);assert.equal(real.data.prediction.is_admin_test,false);
  clock+=120;await (await import('../src/predictions.js')).settleMatch(env.DB,future,[1,0],clock);
  const board=(await call('/api/leaderboard',player)).data;
  assert.equal(board.rows.find(r=>r.id===ADMIN).predictions,0);assert.equal(board.rows.find(r=>r.id===7).predictions,1);
 } finally {Date.now=originalNow;}
});

test('participant moderation: backend authorization, blocking, appeal, unblock and immutable history', async()=>{
 const admin={id:ADMIN,first_name:'Admin'};await call('/api/me',alexey);await call('/api/me',admin);
 const path='/api/admin/users/action',payload={user_id:alexey.id,action:'block',reason:'Проверка модерации'};
 assert.equal((await call(path,alexey,{method:'POST',body:payload})).status,403);
 assert.equal((await call(path,admin,{method:'POST',body:{...payload,reason:''}})).status,400);
 assert.equal((await call(path,admin,{method:'POST',body:{...payload,user_id:ADMIN}})).status,409);
 env.DB.raw.prepare('UPDATE users SET public_profile=1,public_avatar=1 WHERE id=?').run(alexey.id);
 const count=env.DB.raw.prepare('SELECT COUNT(*) n FROM transactions').get().n;
 const blocked=await call(path,admin,{method:'POST',body:payload});assert.equal(blocked.status,200);assert.equal(blocked.data.user.is_blocked,true);
 assert.equal(blocked.data.user.public_profile,false);
 assert.equal((await call('/api/me',alexey)).data.is_blocked,true);
 assert.equal((await call('/api/quiz',alexey)).status,403);
 assert.equal((await call('/api/predictions',alexey,{method:'POST',body:{}})).data.code,'account_blocked');
 assert.equal((await call('/api/preferences',alexey,{method:'PUT',body:{public_profile:true}})).status,403);
 assert.equal((await call('/api/history',alexey)).status,200);
 assert.equal((await call('/api/requests',alexey,{method:'POST',body:{kind:'privacy_question',message:'Проверить блокировку'}})).status,201);
 assert.throws(()=>env.DB.raw.prepare('UPDATE users SET public_profile=1 WHERE id=?').run(alexey.id),/account_blocked/);
 assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM transactions').get().n,count);
 const unblock=await call(path,admin,{method:'POST',body:{...payload,action:'unblock',reason:'Проверка завершена'}});assert.equal(unblock.status,200);assert.equal(unblock.data.user.is_blocked,false);assert.equal(unblock.data.user.public_profile,false);
 assert.equal((await call('/api/quiz',alexey)).status,200);
 assert.deepEqual(env.DB.raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'user_%' ORDER BY id").all().map(x=>x.action),['user_block','user_unblock']);
});

test('hide participant profile preserves history; balance adjustment and audit are atomic',async()=>{
 const admin={id:ADMIN,first_name:'Admin'};await call('/api/me',alexey);await call('/api/me',admin);
 env.DB.raw.prepare('UPDATE users SET public_profile=1,public_avatar=1 WHERE id=?').run(alexey.id);
 const hide=await call('/api/admin/users/action',admin,{method:'POST',body:{user_id:alexey.id,action:'hide_profile',reason:'Просьба участника'}});assert.equal(hide.status,200);assert.equal(hide.data.user.public_avatar,false);
 assert.equal((await call('/api/admin/adjust',admin,{method:'POST',body:{user_id:alexey.id,amount:2.5,reason:'Награда'}})).data.user.balance,12.5);
 assert.equal((await call('/api/admin/adjust',admin,{method:'POST',body:{user_id:alexey.id,amount:-1.5,reason:'Исправление'}})).data.user.balance,11);
 env.DB.raw.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
 const count=env.DB.raw.prepare('SELECT COUNT(*) n FROM transactions').get().n;
 await assert.rejects(call('/api/admin/adjust',admin,{method:'POST',body:{user_id:alexey.id,amount:5,reason:'Rollback test'}}),/test audit failure/);
 assert.equal(await getBalance(env.DB,alexey.id),11*UNIT);
 assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM transactions').get().n,count);
});
