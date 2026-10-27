const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (id) => document.getElementById(id);
const TABS = ["quizzes", "predictions", "table", "profile"];
let me = null;
let adminTarget = null;
let boardPeriod = "all";
let historyNext = undefined; // undefined — ещё не грузили, null — больше нет
let historyLoading = false;
let clockSkew = 0;
const serverNow = () => Date.now() / 1000 + clockSkew;

const TX_LABELS = {
  signup_bonus: "Бонус за регистрацию",
  admin_adjustment: "Корректировка администратора",
  quiz_reward: "Награда за викторину",
  bet: "Прогноз",
  payout: "Выигрыш по прогнозу",
  refund: "Возврат",
  payout_reversal: "Отмена выигрыша (исправление счёта)",
};

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Стаж от даты регистрации: «1 год 10 месяцев 3 дня» (нулевые части не показываем)
function tenure(fromTs, now = new Date()) {
  const from = new Date(fromTs * 1000);
  let y = now.getFullYear() - from.getFullYear();
  let m = now.getMonth() - from.getMonth();
  let d = now.getDate() - from.getDate();
  if (d < 0) {
    m -= 1;
    d += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); // дней в прошлом месяце
  }
  if (m < 0) {
    y -= 1;
    m += 12;
  }
  const parts = [];
  if (y > 0) parts.push(`${y} ${plural(y, "год", "года", "лет")}`);
  if (m > 0) parts.push(`${m} ${plural(m, "месяц", "месяца", "месяцев")}`);
  if (d > 0 || !parts.length) parts.push(`${d} ${plural(d, "день", "дня", "дней")}`);
  return parts.join(" ");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": tg?.initData || "" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Ошибка сервера"), { data });
  // Сервер присылает своё время, чтобы таймер ожидания не зависел от часов телефона
  if (typeof data.now === "number") clockSkew = data.now - Date.now() / 1000;
  return data;
}

function showError(text) {
  $("loading").classList.add("hidden");
  $("error").textContent = text;
  $("error").classList.remove("hidden");
}

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? "ok" : "bad"}`;
}

function openTab(name) {
  for (const t of TABS) $(`tab-${t}`).classList.toggle("hidden", t !== name);
  if (name === "table") loadBoard();
  if (name === "predictions") loadPredictionsTab();
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  try { localStorage.setItem("tots_tab", name); } catch {}
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function renderProfile() {
  $("name").textContent = me.name;
  $("username").textContent = me.username ? "@" + me.username : "";
  const avatar = $("avatar");
  if (me.photo_url) {
    avatar.style.backgroundImage = `url("${encodeURI(me.photo_url)}")`;
    avatar.textContent = "";
  } else {
    avatar.textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  }
  $("balance").textContent = fmt(me.balance);
  $("chip-balance").textContent = fmt(me.balance);
  $("tenure").textContent = `Стаж ${tenure(me.registered_at)}`;
  $("tenure").title = `В TOTS с ${formatDate(me.registered_at)}`;
  if (me.stats) {
    $("stat-earned").textContent = `+${fmt(me.stats.earned)}`;
    $("stat-spent").textContent = `−${fmt(me.stats.spent)}`;
  }
}

// BIST показываем с одним знаком после запятой, лишние знаки отбрасываем: 19.37 → 19.3
function fmt(n) {
  return (Math.trunc(Math.round((n || 0) * 1e4) / 1e3) / 10).toFixed(1);
}

function signed(n) {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : fmt(0);
}

function avatarEl(user, extra = "") {
  const el = document.createElement("div");
  el.className = `avatar ${extra}`;
  if (user.photo_url) el.style.backgroundImage = `url("${encodeURI(user.photo_url)}")`;
  else el.textContent = (user.name || "?").trim().charAt(0).toUpperCase();
  return el;
}

// --- таблица ---

function boardRow(r) {
  const li = document.createElement("li");
  li.className = `brow${r.id === me.id ? " me" : ""}`;
  const rank = document.createElement("span");
  rank.className = `rank${r.rank <= 3 ? " top" : ""}`;
  rank.textContent = ["🥇", "🥈", "🥉"][r.rank - 1] || r.rank;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = r.name;
  const score = document.createElement("span");
  score.className = "score";
  score.textContent = boardPeriod === "all" ? fmt(r.score) : signed(r.score);
  const chg = document.createElement("span");
  chg.className = "chg";
  if (r.change > 0) { chg.textContent = `▲${r.change}`; chg.classList.add("plus"); }
  else if (r.change < 0) { chg.textContent = `▼${-r.change}`; chg.classList.add("minus"); }
  const ava = avatarEl(r, "mini");
  // Тап по аватару или имени открывает профиль участника
  if (r.id !== me.id) { ava.onclick = who.onclick = () => openUser(r); }
  else { ava.onclick = who.onclick = () => openTab("profile"); }
  li.append(rank, ava, who, score, chg);
  return li;
}

let boardObserver = null;
async function loadBoard() {
  const period = boardPeriod;
  const list = $("board");
  try {
    const data = await api(`/api/leaderboard?period=${period}`);
    if (period !== boardPeriod) return; // пока грузили, переключили вкладку
    list.innerHTML = "";
    $("board-note").textContent =
      data.since == null ? `Участников: ${data.total}` :
      `${period === "week" ? "Заработано за неделю" : "Заработано за месяц"} с ${new Date(data.since * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" })}`;
    let myRow = null;
    for (const r of data.rows) {
      const li = boardRow(r);
      if (r.id === me.id) myRow = li;
      list.appendChild(li);
    }
    // Своя строка закреплена внизу, пока её не видно в списке
    const pinned = $("board-me");
    pinned.innerHTML = "";
    boardObserver?.disconnect();
    if (data.me) pinned.appendChild(boardRow(data.me));
    if (!data.me) pinned.classList.add("hidden");
    else if (!myRow) pinned.classList.remove("hidden");
    else {
      boardObserver = new IntersectionObserver(([e]) => pinned.classList.toggle("hidden", e.isIntersecting));
      boardObserver.observe(myRow);
    }
  } catch (e) {
    list.innerHTML = "";
    $("board-note").textContent = e.message;
  }
}

// --- профиль другого участника ---

function fillUser(u) {
  const ava = avatarEl(u);
  $("u-avatar").style.backgroundImage = ava.style.backgroundImage;
  $("u-avatar").textContent = ava.textContent;
  $("u-name").textContent = u.name;
  if (u.rank != null) $("u-rank").textContent = u.rank;
  if (u.balance != null) $("u-balance").textContent = fmt(u.balance);
  if ("username" in u) {
    $("u-username").textContent = u.username ? "@" + u.username : "";
    $("u-username").href = u.username ? `https://t.me/${encodeURIComponent(u.username)}` : "";
  }
  if (u.registered_at) $("u-tenure").textContent = `Стаж ${tenure(u.registered_at)}`;
  if (u.stats) {
    $("u-earned").textContent = `+${fmt(u.stats.earned)}`;
    $("u-spent").textContent = `−${fmt(u.stats.spent)}`;
  }
}

// Карточка открывается сразу с тем, что уже известно из таблицы, остальное догружается
let openUserId = null;
async function openUser(row) {
  openUserId = row.id;
  for (const f of ["u-username", "u-tenure", "u-rank", "u-balance", "u-earned", "u-spent"]) $(f).textContent = "";
  $("u-tenure").textContent = "\u00a0";
  fillUser({ id: row.id, name: row.name, photo_url: row.photo_url, ...(boardPeriod === "all" ? { rank: row.rank, balance: row.score } : {}) });
  $("user-dialog").classList.remove("hidden");
  if (me.is_admin) {
    $("u-admin").classList.remove("hidden");
    $("u-id").textContent = row.id;
    $("u-amount").value = "";
    $("u-reason").value = "";
    $("u-msg").classList.add("hidden");
    $("u-history").innerHTML = "";
    userHistoryNext = undefined;
    loadUserHistory();
  }
  try {
    const u = await api(`/api/users/${row.id}`);
    if (openUserId === row.id) fillUser(u);
  } catch (e) {
    $("u-tenure").textContent = e.message;
  }
}

// --- админка в карточке участника ---

let userHistoryNext;
async function loadUserHistory() {
  const id = openUserId;
  const q = userHistoryNext ? `&before=${userHistoryNext}` : "";
  try {
    const data = await api(`/api/admin/history?user_id=${id}${q}`);
    if (id !== openUserId) return;
    appendHistory($("u-history"), data.items);
    userHistoryNext = data.next;
    $("u-more").classList.toggle("hidden", data.next === null);
  } catch (e) {
    $("u-more").classList.add("hidden");
  }
}

async function userAdjust() {
  const id = openUserId;
  const btn = $("u-apply");
  btn.disabled = true;
  try {
    const res = await api("/api/admin/adjust", {
      method: "POST",
      body: JSON.stringify({ user_id: id, amount: Number($("u-amount").value), reason: $("u-reason").value }),
    });
    $("u-amount").value = "";
    $("u-reason").value = "";
    showMsg($("u-msg"), "Баланс изменён и записан в журнал", true);
    tg?.HapticFeedback?.notificationOccurred("success");
    // Обновляем карточку, историю, таблицу и журнал действий администраторов
    fillUser(await api(`/api/users/${id}`));
    $("u-history").innerHTML = "";
    userHistoryNext = undefined;
    loadUserHistory();
    loadBoard();
    loadAudit();
    if (res.user.id === me.id) {
      me = { ...me, ...(await api("/api/me")) };
      renderProfile();
    }
  } catch (e) {
    showMsg($("u-msg"), e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// --- история операций ---

function appendHistory(list, items) {
  for (const t of items) {
    const li = document.createElement("li");
    li.className = "hist";
    const label = document.createElement("span");
    label.textContent = TX_LABELS[t.type] || t.type;
    if (t.match) {
      const sub = document.createElement("span");
      sub.className = "reason";
      sub.textContent = `${t.match} · ${outcomeLabel(t.market, t.outcome)}`;
      label.appendChild(sub);
    }
    if (t.reason) {
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = `«${t.reason}»`;
      label.appendChild(reason);
    }
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(t.created_at * 1000).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    label.appendChild(when);
    const amount = document.createElement("b");
    amount.className = t.amount > 0 ? "plus" : "minus";
    amount.textContent = signed(t.amount);
    li.append(label, amount);
    list.appendChild(li);
  }
}

async function loadHistory() {
  if (historyLoading || historyNext === null) return;
  historyLoading = true;
  const more = $("history-more");
  try {
    const q = historyNext ? `?before=${historyNext}` : "";
    const data = await api(`/api/history${q}`);
    const list = $("history");
    appendHistory(list, data.items);
    historyNext = data.next;
    if (!list.children.length) list.innerHTML = '<li class="muted">Пока нет операций</li>';
    more.classList.toggle("hidden", historyNext === null);
  } catch (e) {
    more.textContent = e.message;
  } finally {
    historyLoading = false;
  }
}

function resetHistory() {
  $("history").innerHTML = "";
  historyNext = undefined;
  loadHistory();
}

function openNickDialog() {
  $("nick-input").value = me.nickname || "";
  $("nick-input").placeholder = me.telegram_name;
  $("nick-msg").classList.add("hidden");
  $("nick-dialog").classList.remove("hidden");
  $("nick-input").focus();
}

function closeNickDialog() {
  $("nick-dialog").classList.add("hidden");
}

async function saveNickname() {
  const btn = $("nick-save");
  btn.disabled = true;
  try {
    me = { ...me, ...(await api("/api/nickname", { method: "POST", body: JSON.stringify({ nickname: $("nick-input").value }) })) };
    renderProfile();
    closeNickDialog();
    tg?.HapticFeedback?.notificationOccurred("success");
  } catch (e) {
    showMsg($("nick-msg"), e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// --- админка ---

async function adminSearch() {
  const list = $("admin-users");
  list.innerHTML = "";
  try {
    const { users } = await api(`/api/admin/users?q=${encodeURIComponent($("admin-q").value)}`);
    if (!users.length) list.innerHTML = '<li class="muted">Никого не нашли</li>';
    for (const u of users) {
      const li = document.createElement("li");
      li.className = "pick";
      const label = document.createElement("span");
      label.textContent = `${u.name}${u.username ? " · @" + u.username : ""} · ${u.id}`;
      const bal = document.createElement("b");
      bal.textContent = `${fmt(u.balance)} BIST`;
      li.append(label, bal);
      li.onclick = () => {
        adminTarget = u;
        list.querySelectorAll("li").forEach((el) => el.classList.toggle("active", el === li));
        $("admin-target").textContent = `${u.name}: ${fmt(u.balance)} BIST`;
        $("admin-form").classList.remove("hidden");
        $("admin-msg").classList.add("hidden");
      };
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = e.message;
    list.appendChild(li);
  }
}

async function adminApply() {
  if (!adminTarget) return;
  const btn = $("admin-apply");
  btn.disabled = true;
  try {
    const res = await api("/api/admin/adjust", {
      method: "POST",
      body: JSON.stringify({ user_id: adminTarget.id, amount: Number($("admin-amount").value), reason: $("admin-reason").value }),
    });
    adminTarget = res.user;
    $("admin-target").textContent = `${res.user.name}: ${fmt(res.user.balance)} BIST`;
    $("admin-amount").value = "";
    $("admin-reason").value = "";
    showMsg($("admin-msg"), "Баланс изменён и записан в журнал", true);
    if (res.user.id === me.id) {
      me = { ...me, ...(await api("/api/me")) };
      renderProfile();
      resetHistory();
    }
    adminSearch();
    loadAudit();
  } catch (e) {
    showMsg($("admin-msg"), e.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function loadAudit() {
  const list = $("admin-audit");
  try {
    const { entries } = await api("/api/admin/audit");
    list.innerHTML = entries.length ? "" : '<li class="muted">Пока пусто</li>';
    for (const e of entries) {
      const li = document.createElement("li");
      if (e.action === "match_result") {
        li.textContent =
          `${new Date(e.created_at * 1000).toLocaleString("ru-RU")} · ${e.after.match}: счёт ${e.before.score.join(":")} → ` +
          `${e.after.score.join(":")}, прогнозы пересчитаны · «${e.reason}» · админ ${e.admin_id}`;
        list.appendChild(li);
        continue;
      }
      li.textContent =
        `${new Date(e.created_at * 1000).toLocaleString("ru-RU")} · ${e.target_name}: ${signed(e.after.amount)} BIST ` +
        `(${fmt(e.before.balance)} → ${fmt(e.after.balance)}) · «${e.reason}» · админ ${e.admin_id}`;
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = "";
  }
}

// --- прогнозы ---

const COMMISSION = { "1x2": 7, score: 10 };
const STAKE_MIN = 1;
const STAKE_MAX = 100;
let predTournament = "";
let predView = "matches";
let mineScope = "active";
let mineNext;
let matchesCache = [];
let bet = null; // открытое окно прогноза: { match, market, outcome }
let betTimer = null;

function outcomeLabel(market, outcome) {
  if (market === "score") return `счёт ${outcome}`;
  return { 1: "П1", X: "Ничья", 2: "П2" }[outcome] || outcome;
}

// Та же формула, что на сервере: ставка + ставка × (коэффициент − 1) × (1 − комиссия)
function payoutOf(stake, price, market) {
  const units = stake * 10000;
  const cents = Math.round(price * 100);
  return (units + Math.floor((units * (cents - 100) * (100 - COMMISSION[market])) / 10000)) / 10000;
}

function kickoff(ts) {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Завтра";
  if (diff === -1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });
}

// Почему прогноз сейчас не принимается
function closedNote(m) {
  if (m.status === "finished") return null;
  if (m.status === "cancelled") return "Матч отменён, прогнозы возвращены";
  if (m.status === "postponed") return "Матч перенесён, приём прогнозов закрыт";
  if (m.start_time <= serverNow()) return "Матч идёт, ждём результат";
  return "Приём прогнозов закрыт: нет свежих коэффициентов";
}

function predLine(p) {
  const what = `${outcomeLabel(p.market, p.outcome)} · ${fmt(p.stake)} BIST × ${p.price.toFixed(2)}`;
  if (p.status === "won") return `✅ ${what} · выигрыш ${fmt(p.payout)}`;
  if (p.status === "lost") return `❌ ${what} · не сыграл`;
  if (p.status === "refunded") return `↩️ ${what} · возврат`;
  return `🎯 ${what} · возможная выплата ${fmt(p.payout)}`;
}

function matchCard(m) {
  const card = document.createElement("div");
  card.className = "card match";
  const top = document.createElement("div");
  top.className = "match-top";
  top.innerHTML = "<span></span><span></span>";
  top.children[0].textContent = m.tournament_name;
  top.children[1].textContent = m.status === "finished" ? "Завершён" : kickoff(m.start_time);
  const teams = document.createElement("div");
  teams.className = "match-teams";
  teams.innerHTML = "<span></span>";
  teams.firstChild.textContent = `${m.home} — ${m.away}`;
  if (m.score) {
    const sc = document.createElement("span");
    sc.className = "score";
    sc.textContent = m.score.join(" : ");
    teams.appendChild(sc);
  }
  teams.onclick = () => openBet(m, "1x2");
  card.append(top, teams);

  const mine1x2 = m.my.find((p) => p.market === "1x2");
  if (Object.keys(m.odds).length || m.has_score) {
    const odds = document.createElement("div");
    odds.className = "odds";
    for (const o of ["1", "X", "2"]) {
      if (!m.odds[o]) continue;
      const b = document.createElement("button");
      b.className = "odd";
      if (mine1x2?.outcome === o) b.classList.add(mine1x2.status === "won" ? "won" : mine1x2.status === "lost" ? "lost" : "mine");
      b.innerHTML = "<small></small><span></span>";
      b.firstChild.textContent = outcomeLabel("1x2", o);
      b.lastChild.textContent = m.odds[o].toFixed(2);
      b.disabled = !m.open;
      b.onclick = () => openBet(m, "1x2", o);
      odds.appendChild(b);
    }
    if (m.has_score) {
      const b = document.createElement("button");
      b.className = "odd more";
      if (m.my.some((p) => p.market === "score")) b.classList.add("mine");
      b.innerHTML = "<small>Точный</small><span>счёт</span>";
      b.disabled = !m.open;
      b.onclick = () => openBet(m, "score");
      odds.appendChild(b);
    }
    card.appendChild(odds);
  }
  if (!m.open) {
    const note = closedNote(m);
    if (note) {
      const el = document.createElement("div");
      el.className = "match-note";
      el.textContent = note;
      card.appendChild(el);
    }
  }
  for (const p of m.my) {
    const el = document.createElement("div");
    el.className = "my-pred";
    el.textContent = predLine(p);
    card.appendChild(el);
  }
  return card;
}

function renderChips(tournaments) {
  const box = $("t-chips");
  if (box.children.length) return;
  for (const t of [{ code: "", name: "Все" }, ...tournaments]) {
    const b = document.createElement("button");
    b.textContent = t.name;
    b.dataset.code = t.code;
    b.classList.toggle("active", t.code === predTournament);
    b.onclick = () => {
      predTournament = t.code;
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      try { localStorage.setItem("tots_tournament", t.code); } catch {}
      loadMatches();
    };
    box.appendChild(b);
  }
}

async function loadMatches() {
  const t = predTournament;
  const list = $("match-list");
  try {
    const data = await api(`/api/matches${t ? `?t=${t}` : ""}`);
    if (t !== predTournament) return;
    renderChips(data.tournaments);
    matchesCache = data.matches;
    list.innerHTML = "";
    const now = serverNow();
    // Сначала ближайшие матчи по порядку, потом прошедшие — свежие сверху
    const upcoming = data.matches.filter((m) => m.status !== "finished" && m.status !== "cancelled" && m.start_time > now - 3 * 3600);
    const past = data.matches.filter((m) => !upcoming.includes(m)).reverse();
    if (!data.matches.length) {
      list.innerHTML = '<div class="card muted">Матчей на ближайшие две недели пока нет. Расписание обновляется автоматически.</div>';
      return;
    }
    let day = null;
    for (const m of upcoming) {
      const label = dayLabel(m.start_time);
      if (label !== day) {
        day = label;
        const h = document.createElement("div");
        h.className = "day";
        h.textContent = label;
        list.appendChild(h);
      }
      list.appendChild(matchCard(m));
    }
    if (past.length) {
      const h = document.createElement("div");
      h.className = "day";
      h.textContent = "Прошедшие";
      list.appendChild(h);
      for (const m of past) list.appendChild(matchCard(m));
    }
  } catch (e) {
    list.innerHTML = "";
    const el = document.createElement("div");
    el.className = "card error";
    el.textContent = e.message;
    list.appendChild(el);
  }
}

async function loadMine(reset = false) {
  const list = $("mine-list");
  if (reset) {
    list.innerHTML = "";
    mineNext = undefined;
  }
  const scope = mineScope;
  try {
    const data = await api(`/api/predictions?scope=${scope}${mineNext ? `&before=${mineNext}` : ""}`);
    if (scope !== mineScope) return;
    for (const p of data.items) {
      const li = document.createElement("li");
      li.className = "hist pred-item";
      const label = document.createElement("span");
      label.textContent = `${p.match.home} — ${p.match.away}`;
      const sub = document.createElement("span");
      sub.className = "hist-sub";
      sub.textContent = predLine(p);
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = `${p.match.tournament_name} · ${dayLabel(p.match.start_time)}, ${kickoff(p.match.start_time)}` +
        (p.match.score ? ` · ${p.match.score.join(":")}` : "");
      label.append(sub, when);
      li.appendChild(label);
      li.onclick = () => openBet({ ...p.match, my: [] }, p.market);
      list.appendChild(li);
    }
    mineNext = data.next;
    if (!list.children.length) {
      list.innerHTML = `<li class="muted">${scope === "active" ? "Активных прогнозов нет. Выберите матч во вкладке «Матчи»." : "Пока нет завершённых прогнозов"}</li>`;
    }
    $("mine-more").classList.toggle("hidden", data.next === null);
  } catch (e) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = e.message;
    list.appendChild(li);
  }
}

function loadPredictionsTab() {
  if (predView === "matches") loadMatches();
  else loadMine(true);
}

// --- окно прогноза ---

async function openBet(match, market, outcome = null) {
  bet = { match: { ...match, odds: { "1x2": {}, score: {} } }, market, outcome, loading: true };
  $("bet-msg").classList.add("hidden");
  $("fix-msg").classList.add("hidden");
  $("bet-stake").value = "";
  for (const f of ["fix-home", "fix-away", "fix-reason"]) $(f).value = "";
  renderBet();
  $("bet-dialog").classList.remove("hidden");
  try {
    const full = await api(`/api/matches/${match.id}`);
    if (bet?.match.id !== match.id) return;
    bet.match = full;
    bet.loading = false;
    const current = full.my.find((p) => p.market === bet.market && p.status === "active");
    if (current && !bet.outcome) bet.outcome = current.outcome;
    if (current && !$("bet-stake").value) $("bet-stake").value = current.stake;
    renderBet();
  } catch (e) {
    bet.loading = false;
    showMsg($("bet-msg"), e.message, false);
  }
}

function closeBet() {
  $("bet-dialog").classList.add("hidden");
  clearInterval(betTimer);
  bet = null;
}

function renderBet() {
  const m = bet.match;
  $("bet-title").textContent = `${m.home} — ${m.away}`;
  $("bet-sub").textContent = `${m.tournament_name} · ${dayLabel(m.start_time)}, ${kickoff(m.start_time)}`;
  const state = $("bet-state");
  const note = m.score ? `Итог основного времени: ${m.score.join(" : ")}` : m.open ? null : closedNote(m);
  state.textContent = note || "";
  state.classList.toggle("hidden", !note);
  document.querySelectorAll("#bet-markets button").forEach((b) => b.classList.toggle("active", b.dataset.market === bet.market));

  const odds = m.odds[bet.market] || {};
  const box = $("bet-outcomes");
  box.innerHTML = "";
  box.classList.toggle("grid", bet.market === "score");
  const keys = bet.market === "1x2" ? ["1", "X", "2"].filter((o) => odds[o]) : scoreColumns(Object.keys(odds));
  if (bet.market === "score" && keys.length) {
    for (const h of ["Победа хозяев", "Ничья", "Победа гостей"]) {
      const el = document.createElement("div");
      el.className = "muted small grid-head";
      el.textContent = h;
      box.appendChild(el);
    }
  }
  for (const o of keys) {
    if (!o) { box.appendChild(document.createElement("span")); continue; }
    const b = document.createElement("button");
    b.className = "odd";
    b.classList.toggle("picked", o === bet.outcome);
    b.innerHTML = "<small></small><span></span>";
    b.firstChild.textContent = bet.market === "1x2" ? outcomeLabel("1x2", o) : o;
    b.lastChild.textContent = odds[o].toFixed(2);
    b.disabled = !m.open;
    b.onclick = () => { bet.outcome = o; renderBet(); };
    box.appendChild(b);
  }
  if (!keys.length) box.innerHTML = `<div class="muted small">${bet.loading ? "Загрузка…" : "Коэффициентов на этот рынок нет"}</div>`;

  const current = m.my.find((p) => p.market === bet.market && p.status === "active");
  const settled = m.my.filter((p) => p.market === bet.market && p.status !== "active");
  const cur = $("bet-current");
  const lines = [...(current ? [`Ваш прогноз: ${predLine(current)}`] : []), ...settled.map(predLine)];
  cur.textContent = lines.join("\n");
  cur.style.whiteSpace = "pre-line";
  cur.classList.toggle("hidden", !lines.length);

  $("bet-form").classList.toggle("hidden", !m.open || !bet.outcome);
  $("bet-cancel").classList.toggle("hidden", !m.open || !current);
  $("bet-submit").textContent = current ? "Заменить прогноз" : "Сделать прогноз";
  updatePayout();
  tickCooldown();
  clearInterval(betTimer);
  if (current && current.next_change_at > serverNow()) betTimer = setInterval(tickCooldown, 1000);

  const admin = me.is_admin && m.status === "finished";
  $("bet-admin").classList.toggle("hidden", !admin);
  if (admin && m.score && !$("fix-home").value && !$("fix-away").value) {
    $("fix-home").value = m.score[0];
    $("fix-away").value = m.score[1];
  }
}

// Сетка точного счёта в три колонки: победа хозяев, ничья, победа гостей; пустые места — null
function scoreColumns(scores) {
  const goals = (s) => s.split(":").map(Number);
  const byTotal = (a, b) => {
    const [ah, aa] = goals(a);
    const [bh, ba] = goals(b);
    return ah + aa - (bh + ba) || Math.abs(ah - aa) - Math.abs(bh - ba);
  };
  const cols = [
    scores.filter((s) => goals(s)[0] > goals(s)[1]).sort(byTotal),
    scores.filter((s) => goals(s)[0] === goals(s)[1]).sort(byTotal),
    scores.filter((s) => goals(s)[0] < goals(s)[1]).sort(byTotal),
  ];
  const rows = Math.max(...cols.map((c) => c.length));
  const cells = [];
  for (let i = 0; i < rows; i++) for (const c of cols) cells.push(c[i] || null);
  return cells;
}

function updatePayout() {
  if (!bet?.outcome) return;
  const price = bet.match.odds[bet.market]?.[bet.outcome];
  const stake = Number($("bet-stake").value);
  const el = $("bet-payout");
  if (!price) { el.textContent = ""; return; }
  if (!Number.isInteger(stake) || stake < STAKE_MIN || stake > STAKE_MAX) {
    el.textContent = `${outcomeLabel(bet.market, bet.outcome)} × ${price.toFixed(2)} · ставка от ${STAKE_MIN} до ${STAKE_MAX} BIST, целым числом`;
    return;
  }
  const payout = payoutOf(stake, price, bet.market);
  el.textContent = `${outcomeLabel(bet.market, bet.outcome)} × ${price.toFixed(2)} · при выигрыше получите ${fmt(payout)} BIST (+${fmt(payout - stake)})`;
}

// Пока идёт пауза после прошлого действия, кнопки показывают обратный отсчёт
function tickCooldown() {
  const current = bet?.match.my.find((p) => p.market === bet.market && p.status === "active");
  const wait = current ? Math.ceil(current.next_change_at - serverNow()) : 0;
  const submit = $("bet-submit");
  const cancel = $("bet-cancel");
  if (wait > 0) {
    const t = `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`;
    submit.disabled = cancel.disabled = true;
    submit.textContent = `Заменить можно через ${t}`;
    cancel.textContent = `Отменить можно через ${t}`;
  } else {
    clearInterval(betTimer);
    submit.disabled = cancel.disabled = false;
    submit.textContent = current ? "Заменить прогноз" : "Сделать прогноз";
    cancel.textContent = "Отменить прогноз";
  }
}

async function afterBetChange(balance) {
  me.balance = balance;
  renderProfile();
  resetHistory();
  tg?.HapticFeedback?.notificationOccurred("success");
  if (bet) {
    const id = bet.match.id;
    const full = await api(`/api/matches/${id}`).catch(() => null);
    if (full && bet?.match.id === id) { bet.match = full; renderBet(); }
  }
  loadPredictionsTab();
}

async function submitBet() {
  const btn = $("bet-submit");
  btn.disabled = true;
  try {
    const res = await api("/api/predictions", {
      method: "POST",
      body: JSON.stringify({ match_id: bet.match.id, market: bet.market, outcome: bet.outcome, stake: Number($("bet-stake").value) }),
    });
    showMsg($("bet-msg"), res.replaced ? "Прогноз заменён, прошлая ставка вернулась на баланс" : "Прогноз принят", true);
    await afterBetChange(res.balance);
  } catch (e) {
    showMsg($("bet-msg"), e.message, false);
    btn.disabled = false;
  }
}

async function cancelBet() {
  const current = bet.match.my.find((p) => p.market === bet.market && p.status === "active");
  if (!current) return;
  const btn = $("bet-cancel");
  btn.disabled = true;
  try {
    const res = await api(`/api/predictions/${current.id}/cancel`, { method: "POST" });
    showMsg($("bet-msg"), "Прогноз отменён, ставка вернулась на баланс", true);
    bet.outcome = null;
    $("bet-stake").value = "";
    await afterBetChange(res.balance);
  } catch (e) {
    showMsg($("bet-msg"), e.message, false);
    btn.disabled = false;
  }
}

async function fixResult() {
  const btn = $("fix-apply");
  btn.disabled = true;
  try {
    const id = bet.match.id;
    await api(`/api/admin/matches/${id}/result`, {
      method: "POST",
      body: JSON.stringify({ home: Number($("fix-home").value), away: Number($("fix-away").value), reason: $("fix-reason").value }),
    });
    $("fix-reason").value = "";
    showMsg($("fix-msg"), "Счёт исправлен, прогнозы пересчитаны и записаны в журнал", true);
    me = { ...me, ...(await api("/api/me")) };
    renderProfile();
    resetHistory();
    loadAudit();
    const full = await api(`/api/matches/${id}`);
    if (bet?.match.id === id) { bet.match = full; renderBet(); }
    loadPredictionsTab();
  } catch (e) {
    showMsg($("fix-msg"), e.message, false);
  } finally {
    btn.disabled = false;
  }
}

function initPredictions() {
  try { predTournament = localStorage.getItem("tots_tournament") || ""; } catch {}
  document.querySelectorAll("#pred-view button").forEach((b) => (b.onclick = () => {
    predView = b.dataset.view;
    document.querySelectorAll("#pred-view button").forEach((x) => x.classList.toggle("active", x === b));
    $("pred-matches").classList.toggle("hidden", predView !== "matches");
    $("pred-mine").classList.toggle("hidden", predView !== "mine");
    loadPredictionsTab();
  }));
  document.querySelectorAll("#mine-scope button").forEach((b) => (b.onclick = () => {
    mineScope = b.dataset.scope;
    document.querySelectorAll("#mine-scope button").forEach((x) => x.classList.toggle("active", x === b));
    loadMine(true);
  }));
  $("mine-more").onclick = () => loadMine();
  document.querySelectorAll("#bet-markets button").forEach((b) => (b.onclick = () => {
    if (bet.market === b.dataset.market) return;
    bet.market = b.dataset.market;
    const current = bet.match.my.find((p) => p.market === bet.market && p.status === "active");
    bet.outcome = current?.outcome || null;
    $("bet-stake").value = current ? current.stake : "";
    $("bet-msg").classList.add("hidden");
    renderBet();
  }));
  document.querySelectorAll(".quick button").forEach((b) => (b.onclick = () => {
    $("bet-stake").value = b.dataset.stake;
    updatePayout();
  }));
  $("bet-stake").addEventListener("input", updatePayout);
  $("bet-submit").onclick = submitBet;
  $("bet-cancel").onclick = cancelBet;
  $("fix-apply").onclick = fixResult;
  $("bet-close").onclick = closeBet;
  $("bet-dialog").addEventListener("click", (e) => e.target === e.currentTarget && closeBet());
}

// --- запуск ---

function startTab() {
  // Ссылки вида t.me/<бот>/<app>?startapp=quiz_<id> открывают нужный раздел
  const param = tg?.initDataUnsafe?.start_param || "";
  const quiz = /^quiz_(\w+)$/.exec(param);
  if (quiz) {
    $("quiz-soon").textContent = `Викторина #${quiz[1]} откроется здесь, как только раздел заработает.`;
    return "quizzes";
  }
  if (/^(predictions|table|profile|quizzes)$/.test(param)) return param;
  try {
    const saved = localStorage.getItem("tots_tab");
    if (TABS.includes(saved)) return saved;
  } catch {}
  return "profile";
}

async function init() {
  if (!tg?.initData) {
    showError("Откройте TOTS из Telegram по ссылке на бота.");
    return;
  }
  try {
    me = await api("/api/me");
  } catch (e) {
    showError(e.message);
    return;
  }
  renderProfile();
  if (me.is_new) {
    $("welcome").textContent = `🎉 Добро пожаловать! Вам начислено ${fmt(me.balance)} BIST.`;
    $("welcome").classList.remove("hidden");
    tg.HapticFeedback?.notificationOccurred("success");
  }
  $("nick-edit").onclick = openNickDialog;
  $("nick-close").onclick = closeNickDialog;
  $("nick-save").onclick = saveNickname;
  $("nick-input").addEventListener("keydown", (e) => e.key === "Enter" && saveNickname());
  // Закрытие по тапу на затемнение вокруг окна
  $("nick-dialog").addEventListener("click", (e) => e.target === e.currentTarget && closeNickDialog());
  $("user-close").onclick = () => $("user-dialog").classList.add("hidden");
  $("user-dialog").addEventListener("click", (e) => e.target === e.currentTarget && e.target.classList.add("hidden"));
  if (me.is_admin) {
    $("admin").classList.remove("hidden");
    $("admin-search").onclick = adminSearch;
    $("admin-q").addEventListener("keydown", (e) => e.key === "Enter" && adminSearch());
    $("admin-apply").onclick = adminApply;
    $("u-apply").onclick = userAdjust;
    $("u-more").onclick = loadUserHistory;
    loadAudit();
  }
  document.querySelectorAll("#tab-table .segmented button").forEach((b) => (b.onclick = () => {
    boardPeriod = b.dataset.period;
    document.querySelectorAll("#tab-table .segmented button").forEach((x) => x.classList.toggle("active", x === b));
    loadBoard();
  }));
  initPredictions();
  // Подгрузка истории при прокрутке до конца списка
  new IntersectionObserver(([e]) => e.isIntersecting && loadHistory()).observe($("history-more"));
  loadHistory();
  document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  $("loading").classList.add("hidden");
  $("nav").classList.remove("hidden");
  $("balance-chip").classList.remove("hidden");
  openTab(startTab());
}

init();
