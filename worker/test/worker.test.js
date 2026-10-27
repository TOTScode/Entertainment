import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";

import worker from "../src/index.js";
import { addTransaction, getBalance, LedgerError, yearsSince } from "../src/users.js";
import { createDb } from "./fake-d1.js";

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
  await addTransaction(env.DB, { userId: 7, amount: 5, type: "quiz_reward" });
  await addTransaction(env.DB, { userId: 7, amount: -15, type: "bet" });
  assert.equal(await getBalance(env.DB, 7), 0);
  await assert.rejects(addTransaction(env.DB, { userId: 7, amount: -1, type: "bet" }), LedgerError);
  const sum = env.DB.raw.prepare("SELECT SUM(amount) AS s FROM transactions WHERE user_id = 7").get().s;
  assert.equal(sum, 0);
  assert.equal((await call("/api/me", alexey)).data.balance, 0);
});

test("ник: проверка, уникальность без учёта регистра, сброс", async () => {
  await call("/api/me", alexey);
  await call("/api/me", { id: 8, first_name: "Иван" });
  assert.equal((await call("/api/nickname", alexey, { method: "POST", body: { nickname: "ab" } })).status, 400);
  assert.equal((await call("/api/nickname", alexey, { method: "POST", body: { nickname: "<script>" } })).status, 400);
  const ok = await call("/api/nickname", alexey, { method: "POST", body: { nickname: "  Гол  Мастер " } });
  assert.equal(ok.data.name, "Гол Мастер");
  const taken = await call("/api/nickname", { id: 8 }, { method: "POST", body: { nickname: "гол мастер" } });
  assert.equal(taken.status, 409);
  const reset = await call("/api/nickname", alexey, { method: "POST", body: { nickname: "" } });
  assert.equal(reset.data.name, "Алексей");
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
  assert.equal(tx.amount, 25);
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
  assert.deepEqual(rows.map((r) => [r.user_id, r.b]), [[1, 10], [2, 37]]);
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
  assert.equal(board.data.period, "week");
  assert.equal(board.data.rows.length, 2);
  assert.equal(board.data.me.id, 7);

  const hist = await call("/api/history", alexey);
  assert.deepEqual(hist.data.items.map((t) => [t.amount, t.type]), [[10, "signup_bonus"]]);
  assert.equal((await call("/api/leaderboard")).status, 401);
});

test("расписание делает снимок рейтинга", async () => {
  await call("/api/me", alexey);
  const waits = [];
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 27, 21, 1) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const row = env.DB.raw.prepare("SELECT * FROM rank_snapshots").get();
  assert.deepEqual([row.day, row.user_id, row.rank], ["2026-10-28", 7, 1]);
});
