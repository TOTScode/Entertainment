const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// Use a controlled palette rather than combining arbitrary Telegram theme colors.
function applyTheme() {
  const theme = tg?.colorScheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  const background = theme === "dark" ? "#101712" : "#edf0ea";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
  tg?.setHeaderColor?.(background);
  tg?.setBackgroundColor?.(background);
}
applyTheme();
tg?.onEvent?.("themeChanged", applyTheme);

const $ = (id) => document.getElementById(id);
const TABS = ["quizzes", "predictions", "table", "profile"];
let me = null;
let adminTarget = null;
let historyNext = undefined; // undefined — ещё не грузили, null — больше нет
let historyLoading = false;
let clockSkew = 0;
const serverNow = () => Date.now() / 1000 + clockSkew;

const TX_LABELS = {
  signup_bonus: "Бонус за регистрацию",
  admin_adjustment: "Корректировка администратора",
  quiz_reward: "Награда за викторину",
  quiz_reward_reversal: "Сторно награды за отменённый вопрос",
  season_opening: "Обновление баланса сезона",
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
  el.setAttribute("role", ok ? "status" : "alert");
  el.className = `msg ${ok ? "ok" : "bad"}`;
}

function showRetry(container, message, retry) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.className = "muted";
  text.textContent = message;
  const button = document.createElement("button");
  button.className = "btn ghost retry-button";
  button.textContent = "Попробовать снова";
  button.onclick = () => { button.disabled = true; retry(); };
  card.append(text, button);
  container.append(card);
}

function openTab(name) {
  window.scrollTo({ top: 0, behavior: "instant" });
  for (const t of TABS) $(`tab-${t}`).classList.toggle("hidden", t !== name);
  if (name === "table") loadBoard();
  if (name === "predictions") loadPredictionsTab();
  if (name === "quizzes") {
    loadQuiz();
    if (me.is_admin) loadQuizAdmin();
  }
  document.querySelectorAll("#nav button").forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  try { localStorage.setItem("tots_tab", name); } catch {}
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function renderProfile() {
  const navPhoto = $("nav-profile-photo");
  const navPlaceholder = $("nav-profile-placeholder");
  navPhoto.onload = () => { navPhoto.hidden = false; navPlaceholder.classList.add("hidden"); };
  navPhoto.onerror = () => { navPhoto.hidden = true; navPlaceholder.classList.remove("hidden"); };
  if (me.photo_url) {
    if (navPhoto.getAttribute("src") !== me.photo_url) {
      navPhoto.hidden = true;
      navPlaceholder.classList.remove("hidden");
      navPhoto.src = me.photo_url;
    }
  } else {
    navPhoto.removeAttribute("src");
    navPhoto.hidden = true;
    navPlaceholder.classList.remove("hidden");
  }
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
  renderQualify();
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
  const tr = document.createElement("tr");
  tr.className = r.id === me.id ? "me" : "";
  const place = document.createElement("td");
  place.className = "place-cell";
  place.textContent = r.rank ?? "—";
  if(r.rank>=1 && r.rank<=3)place.classList.add("leading");
  const name = document.createElement("th");
  name.scope = "row";
  name.className = "name-cell";
  const who = document.createElement("button");
  who.className = "table-participant";
  who.onclick = () => (r.id === me.id ? openTab("profile") : openUser(r));
  const label = document.createElement("span");
  label.textContent = r.name;
  const identity = document.createElement("span");
  identity.className = "participant-identity";
  identity.append(label);
  if (r.qualified === true) {
    const badge = document.createElement("span");
    badge.className = "qualification-badge qualified";
    badge.textContent = "Квалифицирован";
    identity.append(badge);
  }
  who.append(avatarEl(r, "mini"), identity);
  name.append(who);
  tr.append(place, name);
  for (const value of [
    r.quizzes ?? 0,
    r.quiz_percent == null ? "—" : r.quiz_percent + "%",
    r.predictions ?? 0,
    r.prediction_percent == null ? "—" : r.prediction_percent + "%",
  ]) {
    const td = document.createElement("td");
    td.textContent = value;
    tr.append(td);
  }
  return tr;
}
function boardMessage(text) {
  const tr = document.createElement("tr"),
    td = document.createElement("td");
  td.colSpan = 6;
  td.className = "muted";
  td.textContent = text;
  tr.append(td);
  return tr;
}
async function loadBoard() {
  const selectedSeason = boardSeason,
    list = $("board");
  const table=list.closest("table");
  table.classList.add("is-empty");
  list.replaceChildren(boardMessage("Загружаем участников…"));
  $("board-me").classList.add("hidden");
  try {
    const data = await api(
      "/api/leaderboard" + (selectedSeason ? "?season=" + encodeURIComponent(selectedSeason) : ""),
    );
    if (selectedSeason !== boardSeason) return;
    list.replaceChildren();
    table.classList.toggle("is-empty",!data.rows.length);
    $("board-note").textContent =
      data.example ? "Пример оформления · вымышленные участники" : data.season.pending_start ? "Первый сезон начнётся 1 декабря 2026 года" : "Участников: " + data.total + (data.qualification_frozen ? " · отбор зафиксирован" : "");
    for (const r of data.rows) list.append(boardRow(r));
    if (!data.rows.length) list.append(boardMessage(data.season.pending_start ? "Рейтинг появится после начала сезона" : "Участников пока нет"));
  } catch (e) {
    if (selectedSeason !== boardSeason) return;
    table.classList.add("is-empty");
    const row = boardMessage("");
    showRetry(row.firstChild, "Не удалось загрузить таблицу", loadBoard);
    list.replaceChildren(row);
    $("board-note").textContent = e.message;
  }
}

// --- профиль другого участника ---

function fillUser(u) {
  const ava = avatarEl(u);
  $("u-avatar").style.backgroundImage = ava.style.backgroundImage;
  $("u-avatar").textContent = ava.textContent;
  $("u-name").textContent = u.name;
  $("u-rank").parentElement.classList.add("hidden");
  for(const id of ["u-balance","u-earned","u-spent"]) $(id).parentElement.classList.toggle("hidden",!("balance" in u));
  $("u-public-stats").textContent = `Квалификация: ${u.qualified?"Квалифицирован":"Не квалифицирован"} · Викторины: ${u.quizzes??0} · Точность: ${u.quiz_percent==null?"—":u.quiz_percent+"%"} · Прогнозы: ${u.predictions??0} · Точность: ${u.prediction_percent==null?"—":u.prediction_percent+"%"}`;
  $("u-quiz").parentElement.classList.add("hidden");
  $("u-acc").parentElement.classList.add("hidden");
  if (u.balance != null) $("u-balance").textContent = fmt(u.balance);
  $("u-quiz").textContent = u.quizzes??0;
  $("u-acc").textContent = u.prediction_percent==null?"—":u.prediction_percent+"%";
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
  for (const f of ["u-username", "u-tenure", "u-rank", "u-balance", "u-earned", "u-spent", "u-quiz", "u-acc"]) $(f).textContent = "";
  $("u-tenure").textContent = "\u00a0";
  fillUser(row);
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
    if(t.is_admin_test){const note=document.createElement("span");note.className="reason";note.textContent="Прогноз администратора · вне сезонной статистики";label.append(note);}
    if (t.quiz) {
      const sub = document.createElement("span");
      sub.className = "reason";
      sub.textContent = t.quiz;
      label.appendChild(sub);
    }
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

// --- дашборд администратора ---

let dashData = null;
let dashPeriod = "day";

async function loadDashboard() {
  try {
    dashData = await api("/api/admin/dashboard");
    renderDashboard();
  } catch (e) {
    $("dash-body").innerHTML = `<div class="muted">${e.message}</div>`;
  }
}

function renderDashboard() {
  const d = dashData;
  const p = dashPeriod;
  const body = $("dash-body");
  body.innerHTML = "";
  const section = (title) => {
    const h = document.createElement("h4");
    h.textContent = title;
    body.appendChild(h);
  };
  const row = (label, value, sub = false) => {
    const r = document.createElement("div");
    r.className = sub ? "row sub" : "row";
    r.append(Object.assign(document.createElement("span"), { textContent: label }), Object.assign(document.createElement("b"), { textContent: value }));
    body.appendChild(r);
  };
  const pct = (a, b) => (b ? ` (${Math.round((a / b) * 100)}%)` : "");

  section("BIST");
  row("Выдано", `+${fmt(d.bist.issued[p])}`);
  row("Списано", `−${fmt(d.bist.spent[p])}`);
  for (const t of d.bist.by_type) {
    if (!t.count[p]) continue;
    row(`${TX_LABELS[t.type] || t.type} · ${t.count[p]}`, signed(t[p]), true);
  }
  row("Всего на балансах", fmt(d.bist.total));

  section("Игроки");
  row("Всего", d.players.total);
  row("Новых", d.players.new[p]);
  row("Активных", d.players.active[p]);
  row(`Набрали ${d.players.qualify_bist} BIST`, d.players.qualified);
  row(`Доля BIST у топ-10% (${d.players.top_n})`, d.players.top_share == null ? "—" : `${d.players.top_share}%`);

  const pr = d.predictions;
  section("Прогнозы");
  row("Сделано", `${pr.made[p]} от ${pr.players[p]} игр.`);
  row("Поставлено", `${fmt(pr.stake[p])} BIST`);
  row("Угадано", `${pr.won[p]}${pct(pr.won[p], pr.won[p] + pr.lost[p])}`);
  row("Не угадано", pr.lost[p]);
  row("Выплачено", `${fmt(pr.payout[p])} BIST`);
  row("Ждут результата", `${pr.active.count} · ${fmt(pr.active.stake)} BIST`);

  const q = d.quizzes;
  section("Викторины");
  row("Игроков", q.players[p]);
  row("Открыто вопросов", q.opened[p]);
  row("Правильных ответов", `${q.correct[p]}${pct(q.correct[p], q.correct[p] + q.wrong[p])}`);
  row("Неправильных", q.wrong[p]);
  row("Очередь до", q.queue_until ? new Date(q.queue_until * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "пусто");
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

const STAKE_MIN = 1;
const STAKE_MAX = 100;
let predTournament = "";
let predView = "matches";
let mineScope = "active";
let mineNext;
let matchesCache = [];
let bet = null; // открытое окно прогноза: { match, market, outcome }
let betTimer = null;

const activeOf = (match) => match.my.find((p) => p.status === "active");

function outcomeLabel(market, outcome) {
  if (market === "score") return `счёт ${outcome}`;
  return { 1: "П1", X: "Ничья", 2: "П2" }[outcome] || outcome;
}

// Та же формула, что на сервере: ставка × вес прогноза
function payoutOf(stake, price) {
  return Math.floor((stake * 10000 * Math.round(price * 100)) / 100) / 10000;
}

function kickoff(ts) {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Minsk" });
}

function matchDateTime(ts) {
  const date = new Date(ts * 1000).toLocaleDateString("ru-RU", {day:"2-digit",month:"2-digit",year:"numeric",timeZone:"Europe/Minsk"});
  return `${date} · ${kickoff(ts)}`;
}
function matchIsLive(m) {
  const elapsed = serverNow() - m.start_time;
  return elapsed >= 0 && elapsed < 105 * 60 && !["finished", "cancelled", "postponed"].includes(m.status);
}
function matchAcceptsPrediction(m) {
  return m.open && (m.admin_mode || m.start_time > serverNow());
}
function liveTag() {
  const tag = document.createElement("span");
  tag.className = "live-tag";
  tag.textContent = "LIVE";
  return tag;
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
  if (m.start_time <= serverNow()) return matchIsLive(m) ? "Матч идёт · приём прогнозов закрыт" : "Приём закрыт · ждём результат";
  if(seasonInfo?.season.pending_start)return "Приём прогнозов начнётся 1 декабря 2026 года";
  return "Приём прогнозов закрыт: нет свежих данных по матчу";
}

const ICON_PATHS = {
  success: '<circle cx="10" cy="10" r="9" fill="currentColor" fill-opacity=".10" stroke="none"/><path d="m6 10 2.6 2.6L14 7.2"/>',
  error: '<circle cx="10" cy="10" r="8"/><path d="m7 7 6 6m0-6-6 6"/>',
  refund: '<path d="M6 6H3V3m0 3a7 7 0 1 1 0 8"/>',
  target: '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="4"/><circle cx="10" cy="10" r=".8" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2"/>',
  file: '<path d="m7 10 5-5a3 3 0 0 1 4 4l-7 7a4 4 0 0 1-6-6l7-7m-5 9 7-7"/>',
  link: '<path d="m8 12 4-4m-6 3-2 2a3 3 0 0 0 4 4l3-3m-2-8 3-3a3 3 0 0 1 4 4l-2 2"/>',
  edit: '<path d="m4 12 9-9 4 4-9 9-5 1 1-5Zm7-7 4 4"/>',
  trash: '<path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6"/>',
  spark: '<path d="m10 2 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/>',
  up: '<path d="M10 16V4m-5 5 5-5 5 5"/>',
  down: '<path d="M10 4v12m-5-5 5 5 5-5"/>'
};
function uiIcon(kind) {
  return `<svg class="ui-icon icon-${kind}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[kind] || ICON_PATHS.spark}</svg>`;
}
const SUCCESS_ICON = uiIcon("success");
function iconText(element, text, kind) {
  element.innerHTML = uiIcon(kind);
  element.append(text);
}

function renderPredictionLine(element, prediction, prefix = "") {
  element.replaceChildren();
  element.insertAdjacentHTML("beforeend", uiIcon({won:"success",lost:"error",refunded:"refund"}[prediction.status] || "target"));
  element.append(prefix + predLine(prediction));
}

function predLine(p) {
  const what = `${p.is_admin_test ? "Админ · вне сезонной статистики · " : ""}${outcomeLabel(p.market, p.outcome)} · ${fmt(p.stake)} BIST · вес ${p.price.toFixed(2)}`;
  if (p.status === "won") return `${what} · выигрыш ${fmt(p.payout)}`;
  if (p.status === "lost") return `${what} · не сыграл`;
  if (p.status === "refunded") return `${what} · возврат`;
  return `${what} · возможная выплата ${fmt(p.payout)}`;
}

function matchCard(m) {
  const card = document.createElement("div");
  card.className = "card match";
  const top = document.createElement("div");
  top.className = "match-top";
  top.innerHTML = "<span></span><span></span>";
  top.children[0].textContent = m.tournament_name;
  top.children[1].className = "match-time";
  top.children[1].textContent = matchDateTime(m.start_time);
  const live = liveTag();
  top.children[1].append(live);
  const teams = document.createElement("button");
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
  if(m.admin_mode){const note=document.createElement("p");note.className="muted small";note.textContent="Режим администратора · вне сезонной статистики · обычный баланс";card.append(note);}

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
      b.disabled = !matchAcceptsPrediction(m);
      b.onclick = () => openBet(m, "1x2", o);
      odds.appendChild(b);
    }
    if (m.has_score) {
      const b = document.createElement("button");
      b.className = "odd more";
      if (m.my.some((p) => p.market === "score")) b.classList.add("mine");
      b.innerHTML = "<small>Точный</small><span>счёт</span>";
      b.disabled = !matchAcceptsPrediction(m);
      b.onclick = () => openBet(m, "score");
      odds.appendChild(b);
    }
    card.appendChild(odds);
  }
  const timingNote = document.createElement("div");
  timingNote.className = "match-note";
  card.append(timingNote);
  for (const p of m.my) {
    const el = document.createElement("div");
    el.className = "my-pred";
    renderPredictionLine(el, p);
    card.appendChild(el);
  }
  card.updateTiming = () => {
    timingNote.textContent = matchAcceptsPrediction(m) ? "" : (closedNote(m) || "");
    timingNote.classList.toggle("hidden", !timingNote.textContent);
    live.classList.toggle("hidden", !matchIsLive(m) || !m.my.some(p => p.status === "active"));
    card.querySelectorAll(".odd").forEach(button => { button.disabled = !matchAcceptsPrediction(m); });
  };
  card.updateTiming();
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
  list.innerHTML = '<div class="card muted" role="status">Загружаем матчи…</div>';
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
    showRetry(list, e.message, loadMatches);
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
      renderPredictionLine(sub, p);
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = `${p.match.tournament_name} · ${matchDateTime(p.match.start_time)}` +
        (p.match.score ? ` · ${p.match.score.join(":")}` : "");
      const live = liveTag();
      label.append(live, sub, when);
      li.updateTiming = () => live.classList.toggle("hidden", p.status !== "active" || !matchIsLive(p.match));
      li.updateTiming();
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
    const current = activeOf(full);
    if (current?.market === bet.market && !bet.outcome) bet.outcome = current.outcome;
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
  $("bet-timing-rules").textContent = m.admin_mode ? "Один действующий прогноз на матч. Для администратора нет ограничений по времени и ожидания между изменениями. Обычный баланс, без учёта в сезонной статистике." : "Один прогноз на матч. Приём до начала матча. Замена или отмена — не чаще раза в 5 минут.";
  $("bet-title").textContent = `${m.home} — ${m.away}`;
  $("bet-sub").textContent = `${m.tournament_name} · ${matchDateTime(m.start_time)}`;
  const state = $("bet-state");
  const note = m.score ? `Итог основного времени: ${m.score.join(" : ")}` : m.open ? null : closedNote(m);
  state.textContent = [note,m.admin_mode ? "Режим администратора: обычный баланс, прогноз не входит в сезонную статистику." : null].filter(Boolean).join(" · ");
  state.classList.toggle("hidden", !state.textContent);
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
    b.disabled = !matchAcceptsPrediction(m);
    b.onclick = () => { bet.outcome = o; renderBet(); };
    box.appendChild(b);
  }
  if (!keys.length) box.innerHTML = `<div class="muted small">${bet.loading ? "Загрузка…" : "Вариантов для прогноза пока нет"}</div>`;

  const current = activeOf(m);
  const settled = m.my.filter((p) => p.status !== "active");
  const cur = $("bet-current");
  cur.replaceChildren();
  for (const p of [...(current ? [current] : []), ...settled]) {
    const line = document.createElement("div");
    renderPredictionLine(line, p, p === current ? "Ваш прогноз: " : "");
    cur.append(line);
  }
  // На матч — один прогноз: новый прогноз на другой рынок заменит текущий.
  if (current && matchAcceptsPrediction(m) && current.market !== bet.market) {
    const note = document.createElement("div");
    note.textContent = "На матч можно сделать один прогноз: новый заменит текущий.";
    cur.append(note);
  }
  cur.classList.toggle("hidden", !cur.childNodes.length);

  $("bet-form").classList.toggle("hidden", !matchAcceptsPrediction(m) || !bet.outcome);
  $("bet-cancel").classList.toggle("hidden", !matchAcceptsPrediction(m) || !current);
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
  $("bet-submit").disabled = !Number.isInteger(stake) || stake < STAKE_MIN || stake > STAKE_MAX ||
    stake > me.balance + (activeOf(bet.match)?.stake || 0) || !matchAcceptsPrediction(bet.match) || (activeOf(bet.match)?.next_change_at || 0) > serverNow();
  const el = $("bet-payout");
  if (!price) { el.textContent = ""; return; }
  if (!Number.isInteger(stake) || stake < STAKE_MIN || stake > STAKE_MAX) {
    el.textContent = `${outcomeLabel(bet.market, bet.outcome)} · вес ${price.toFixed(2)} · ставка от ${STAKE_MIN} до ${STAKE_MAX} BIST, целым числом`;
    return;
  }
  const payout = payoutOf(stake, price);
  el.textContent = `${outcomeLabel(bet.market, bet.outcome)} · вес ${price.toFixed(2)} · при выигрыше получите ${fmt(payout)} BIST (+${fmt(payout - stake)})`;
}

// Пока идёт пауза после прошлого действия, кнопки показывают обратный отсчёт
function tickCooldown() {
  const current = bet && activeOf(bet.match);
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
    cancel.disabled = false;
    const stake = Number($("bet-stake").value);
    submit.disabled = !bet?.outcome || !Number.isInteger(stake) || stake < STAKE_MIN || stake > STAKE_MAX ||
      stake > me.balance + (current?.stake || 0) || !matchAcceptsPrediction(bet.match);
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
  if (!bet || !matchAcceptsPrediction(bet.match)) {
    showMsg($("bet-msg"), "Приём прогнозов на этот матч закрыт", false);
    return;
  }
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
  const current = activeOf(bet.match);
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
    const current = activeOf(bet.match);
    bet.outcome = current?.market === bet.market ? current.outcome : null;
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

// --- викторины ---

const BOT_APP = "https://t.me/TOTS_official_bot/entertain";
let quiz = null; // состояние вкладки из /api/quiz
let quizTimer = null;
let quizAdmin = null; // очередь и настройки для админки
let editingQuiz = null; // id викторины в правке

function renderQualify() {
  const need = quiz?.qualify || 100;
  const have = Math.max(0,Math.min(me.balance, need));
  const done = seasonInfo?.season.pending_start ? false : seasonInfo?.frozen ? seasonInfo.qualified : me.balance >= need;
  $("qualify").classList.toggle("done", done);
  $("qualify-num").textContent = `${fmt(me.balance)} / ${need} BIST`;
  $("qualify-bar").style.width = `${(have / need) * 100}%`;
  $("qualify-progress").setAttribute("aria-valuemax", need);
  $("qualify-progress").setAttribute("aria-valuenow", have);
  $("qualify-text").textContent = seasonInfo?.season.pending_start ? "Первый сезон начнётся 1 декабря 2026 года" : done
    ? "Квалифицирован"
    : "Не квалифицирован";
}

function mediaEl(media) {
  const box = document.createElement("div");
  box.className = "q-media";
  let el;
  if (media.kind === "image") {
    el = document.createElement("img");
    el.alt = "";
  } else if (media.kind === "audio" || media.kind === "video") {
    el = document.createElement(media.kind);
    el.controls = true;
    el.preload = "metadata";
    if (media.kind === "video") el.playsInline = true;
  } else {
    el = document.createElement("a");
    el.target = "_blank";
    el.rel = "noopener";
    iconText(el, media.name || "Открыть файл", "file");
    el.href = media.url;
  }
  if (el.tagName !== "A") el.src = media.url;
  box.appendChild(el);
  return box;
}

function left(ts) {
  const s = Math.max(0, Math.round(ts - serverNow()));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

function questionEl(q, i, live) {
  const box = document.createElement("div");
  box.className = "question";
  const head = document.createElement("div");
  head.className = "q-num";
  head.innerHTML = "<span></span><span></span>";
  head.firstChild.textContent = `Вопрос ${i + 1}`;
  box.appendChild(head);

  if (q.text !== undefined) {
    if (q.media) box.appendChild(mediaEl(q.media));
    if (q.text) {
      const t = document.createElement("div");
      t.className = "q-text";
      t.textContent = q.text;
      box.appendChild(t);
    }
  }
  const result = document.createElement("div");
  result.className = "q-result";
  if (q.correct) result.innerHTML = `<span class="plus">${SUCCESS_ICON} Верно</span>`;
  else if (q.done && q.answer) result.innerHTML = `<span class="minus">${uiIcon("error")} Неверно</span>`;
  else if (q.done) result.innerHTML = `<span class="minus">${uiIcon("clock")} Время вышло</span>`;
  if (q.answer) result.append(` · ваш ответ: «${q.answer}»`);
  if (q.answers) {
    const right = document.createElement("div");
    right.className = "muted small";
    right.textContent = `Правильный ответ: ${q.answers.join(" / ")}`;
    result.appendChild(right);
  }
  if (result.childNodes.length) box.appendChild(result);
  if (!live) return box;

  if (!q.opened) {
    const note = document.createElement("div");
    note.className = "muted small";
    const s = quiz.settings;
    note.textContent = [
      s.time_limit ? `После открытия будет ${s.time_limit} сек на ответ.` : "Время на ответ не ограничено.",
      s.attempts > 1 ? `Попыток: ${s.attempts}.` : "Одна попытка.",
    ].join(" ");
    const btn = document.createElement("button");
    btn.className = "btn wide";
    btn.textContent = "Открыть вопрос";
    btn.onclick = () => openQuizQuestion(q.id, btn);
    box.append(note, btn);
  } else if (!q.done) {
    const input = document.createElement("input");
    input.className = "input";
    input.id = `quiz-answer-${q.id}`;
    input.maxLength = 200;
    input.placeholder = "Ваш ответ";
    input.autocomplete = "off";
    const btn = document.createElement("button");
    btn.className = "btn wide";
    btn.textContent = "Ответить";
    const msg = document.createElement("div");
    msg.className = "msg hidden";
    const send = () => answerQuizQuestion(q.id, input, btn, msg);
    btn.onclick = send;
    input.addEventListener("keydown", (e) => e.key === "Enter" && send());
    if (q.deadline) {
      head.lastChild.className = "q-timer";
      head.lastChild.dataset.deadline = q.deadline;
    }
    if (q.attempts_left > 1 || quiz.settings.attempts > 1) {
      const a = document.createElement("div");
      a.className = "muted small";
      a.textContent = `Осталось попыток: ${q.attempts_left}`;
      box.appendChild(a);
    }
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = "Ваш ответ";
    box.append(label, input, btn, msg);
  }
  if(q.voided){box.querySelectorAll('input,button').forEach(el=>el.remove());const note=document.createElement('p');note.textContent='Вопрос отменён. Начисление скорректировано.';box.append(note);}
  if(q.opened||q.done){const report=document.createElement('button');report.className='btn ghost';report.textContent='Сообщить об ошибке';report.onclick=()=>openReport('quiz_error',q.id);box.append(report);}
  return box;
}

function renderQuiz() {
  renderQualify();
  const box = $("quiz-current");
  box.innerHTML = "";
  const z = quiz.current;
  const card = document.createElement("div");
  card.className = "card";
  if (!z) {
    card.className = "card soon";
    card.innerHTML = '<h2>Сегодня игры нет</h2><p class="muted">Новая викторина появится здесь в 00:00 по Москве.</p>';
  } else {
    const head = document.createElement("div");
    head.className = "quiz-head";
    head.innerHTML = "<h2></h2><div class='muted'></div>";
    head.firstChild.textContent = z.title;
    const right = z.questions.filter((q) => q.correct).length;
    head.lastChild.textContent =
      `${z.reward > 0 ? `${fmt(z.reward)} BIST за правильный ответ · ` : ""}верно ${right} из ${z.questions.length} · ` +
      `сменится через ${left(z.ends_at)}`;
    card.appendChild(head);
    z.questions.forEach((q, i) => card.appendChild(questionEl(q, i, true)));
  }
  box.appendChild(card);

  const past = $("quiz-past");
  past.innerHTML = "";
  for (const p of quiz.past) {
    const li = document.createElement("li");
    li.className = "past";
    li.innerHTML = "<span></span><b></b>";
    li.firstChild.textContent = p.title;
    li.lastChild.textContent = `${p.right} / ${p.total}`;
    li.onclick = () => openPastQuiz(p.id);
    past.appendChild(li);
  }
  $("quiz-past-card").classList.toggle("hidden", !quiz.past.length);

  clearInterval(quizTimer);
  quizTimer = setInterval(tickQuiz, 1000);
  tickQuiz();
}

// Таймеры открытых вопросов; когда время вышло или викторина сменилась — обновляем экран
function tickQuiz() {
  if ($("tab-quizzes").classList.contains("hidden")) return;
  let expired = false;
  document.querySelectorAll("#quiz-current .q-timer").forEach((el) => {
    const s = Math.ceil(Number(el.dataset.deadline) - serverNow());
    iconText(el, `${Math.max(0,s)} сек`, "clock");
    if (s <= -5) expired = true;
  });
  if (expired || (quiz?.current && quiz.current.ends_at <= serverNow())) {
    clearInterval(quizTimer);
    loadQuiz();
  }
}

async function loadQuiz() {
  $("quiz-current").innerHTML = '<div class="card muted" role="status">Загружаем викторину…</div>';
  try {
    quiz = await api("/api/quiz");
    renderQuiz();
  } catch (e) {
    showRetry($("quiz-current"), e.message, loadQuiz);
  }
}

function replaceQuestion(q) {
  const list = quiz.current?.questions || [];
  const i = list.findIndex((x) => x.id === q.id);
  if (i >= 0) list[i] = q;
}

async function openQuizQuestion(id, btn) {
  btn.disabled = true;
  try {
    const res = await api(`/api/quiz/questions/${id}/open`, { method: "POST" });
    replaceQuestion(res.question);
    renderQuiz();
    const input = [...document.querySelectorAll("#quiz-current .question input")].pop();
    input?.focus();
  } catch (e) {
    btn.disabled = false;
    loadQuiz();
  }
}

async function answerQuizQuestion(id, input, btn, msg) {
  if (!input.value.trim()) return;
  btn.disabled = true;
  try {
    const res = await api(`/api/quiz/questions/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: input.value }) });
    replaceQuestion(res.question);
    if (res.correct) {
      me.balance = res.balance;
      renderProfile();
      resetHistory();
      tg?.HapticFeedback?.notificationOccurred("success");
    } else {
      tg?.HapticFeedback?.notificationOccurred("error");
    }
    renderQuiz();
  } catch (e) {
    showMsg(msg, e.message, false);
    btn.disabled = false;
  }
}

async function openPastQuiz(id) {
  $("qd-title").textContent = "";
  $("qd-sub").textContent = "Загрузка…";
  $("qd-questions").innerHTML = "";
  $("quiz-dialog").classList.remove("hidden");
  try {
    const z = await api(`/api/quizzes/${id}`);
    $("qd-title").textContent = z.title;
    const right = z.questions.filter((q) => q.correct).length;
    $("qd-sub").textContent = z.ended ? `Вы ответили верно на ${right} из ${z.questions.length}` : "Викторина ещё идёт, ответы появятся после смены";
    z.questions.forEach((q, i) => $("qd-questions").appendChild(questionEl(q, i, false)));
  } catch (e) {
    $("qd-sub").textContent = e.message;
  }
}

// --- админка викторин ---

function fmtWhen(ts) {
  return new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
}

async function loadQuizAdmin(data) {
  try {
    quizAdmin = data || (await api("/api/admin/quizzes"));
  } catch (e) {
    showMsg($("qa-msg"), e.message, false);
    return;
  }
  const s = quizAdmin.settings;
  $("qs-every").value = s.every_days;
  $("qs-time").value = s.time_limit;
  $("qs-attempts").value = s.attempts;
  const list = $("qa-queue");
  list.innerHTML = "";
  const live = quizAdmin.quizzes.filter((z) => z.status !== "ended");
  if (!live.length) list.innerHTML = '<li class="muted">Очередь пуста. Добавьте викторину ниже.</li>';
  live.forEach((z) => {
    const li = document.createElement("li");
    li.className = "qa-item";
    const info = document.createElement("span");
    info.className = "qa-info";
    info.textContent = `${z.title} · ${z.questions.length} вопр.`;
    if (z.status === "current") info.insertAdjacentHTML("beforeend", '<span class="badge">сейчас</span>');
    const when = document.createElement("span");
    when.className = "qa-when";
    when.textContent = `${z.status === "current" ? `до ${fmtWhen(z.ends_at)}` : `${fmtWhen(z.starts_at)} — ${fmtWhen(z.ends_at)}`} МСК` +
      (z.status === "current" ? ` · играли ${z.players}` : "");
    info.appendChild(when);
    const actions = document.createElement("span");
    actions.className = "qa-actions";
    const btn = (label, title, fn) => {
      const b = document.createElement("button");
      b.className = "icon-btn";
      b.innerHTML = uiIcon(label);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onclick = fn;
      actions.appendChild(b);
    };
    if (z.status === "queued") {
      btn("up", "Раньше", () => quizAdminCall(`/api/admin/quizzes/${z.id}/move`, "POST", { dir: "up" }));
      btn("down", "Позже", () => quizAdminCall(`/api/admin/quizzes/${z.id}/move`, "POST", { dir: "down" }));
    }
    btn("link", "Скопировать ссылку для поста", () => copyQuizLink(z.id));
    btn("edit", "Изменить", () => editQuiz(z));
    btn("trash", z.status === "current" ? "Снять (следующая начнётся сразу)" : "Удалить", () => {
      const q = z.status === "current"
        ? `Снять «${z.title}»? Следующая викторина начнётся сразу.`
        : `Удалить «${z.title}» из очереди?`;
      if (confirm(q)) quizAdminCall(`/api/admin/quizzes/${z.id}`, "DELETE");
    });
    li.append(info, actions);
    list.appendChild(li);
  });
}

function copyQuizLink(id) {
  const link = `${BOT_APP}?startapp=quiz_${id}`;
  navigator.clipboard?.writeText(link).then(
    () => showMsg($("qa-msg"), `Ссылка скопирована: ${link}`, true),
    () => showMsg($("qa-msg"), link, true),
  );
  if (!navigator.clipboard) showMsg($("qa-msg"), link, true);
}

async function quizAdminCall(path, method, body) {
  try {
    const data = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    await loadQuizAdmin(data);
    loadQuiz();
    return data;
  } catch (e) {
    showMsg($("qa-msg"), e.message, false);
    throw e;
  }
}

function questionForm(q = {}) {
  const box = document.createElement("div");
  box.className = "qa-q";
  box.dataset.id = q.id || "";
  box.dataset.media = q.media_id || "";
  box.innerHTML = `
    <div class="qa-q-head"><span class="qa-n"></span><button class="icon-btn qa-del" title="Убрать вопрос">✕</button></div>
    <label>Текст вопроса<textarea class="input qa-text" maxlength="2000"></textarea></label>
    <div class="qa-file"><label>Медиафайл<input type="file" accept="image/*,audio/*,video/*,*/*"></label><span class="qa-file-name muted"></span><button class="icon-btn qa-file-del hidden" title="Убрать файл">✕</button></div>
    <label>Источник задания<input class="input qa-source" maxlength="1000"></label>
    <label>Правильные ответы<textarea class="input qa-answers" placeholder="Каждый вариант с новой строки"></textarea></label>`;
  if(q.id&&!q.voided_at){const remove=document.createElement('button');remove.className='btn ghost wide';remove.type='button';remove.textContent='Отменить ошибочный вопрос со сторно';remove.onclick=async()=>{const reason=prompt('Причина отмены вопроса и сторнирования наград');if(!reason?.trim())return;const url='/api/admin/questions/'+q.id+'/void';try{await api(url,{method:'POST',body:JSON.stringify({reason})});await loadQuizAdmin();loadQuiz();}catch(e){if(e.message.includes('После фиксации')){const decision=prompt('Отбор уже зафиксирован. Укажите отдельную причину сохранить опубликованные допуски. Для изменения допуска требуется отдельное решение администратора.');if(decision?.trim()){try{await api(url,{method:'POST',body:JSON.stringify({reason,retain_frozen_admissions:true,post_freeze_reason:decision})});await loadQuizAdmin();loadQuiz();}catch(e){showMsg($('qa-msg'),e.message,false);}}}else showMsg($('qa-msg'),e.message,false);}};box.append(remove);}
  box.querySelector(".qa-source").value = q.source || "";
  box.querySelector(".qa-text").value = q.text || "";
  box.querySelector(".qa-answers").value = (q.answers || []).join("\n");
  const name = box.querySelector(".qa-file-name");
  const del = box.querySelector(".qa-file-del");
  const setFile = (label) => {
    if (label) iconText(name, label, "file"); else name.replaceChildren();
    del.classList.toggle("hidden", !box.dataset.media);
  };
  setFile(q.media ? `${q.media.name || q.media.kind}` : "");
  box.querySelector(".qa-del").onclick = () => { box.remove(); numberQuestions(); };
  del.onclick = () => { box.dataset.media = ""; box.querySelector("input[type=file]").value = ""; setFile(""); };
  box.querySelector("input[type=file]").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setFile("Файл больше 20 МБ"); return; }
    setFile("Загрузка…");
    $("qa-save").disabled = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/media", { method: "POST", body: form, headers: { "X-Telegram-Init-Data": tg?.initData || "" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось загрузить файл");
      box.dataset.media = data.id;
      setFile(`${file.name}`);
    } catch (err) {
      box.dataset.media = "";
      setFile(err.message);
    } finally {
      $("qa-save").disabled = false;
    }
  };
  return box;
}

function numberQuestions() {
  document.querySelectorAll("#qa-questions .qa-n").forEach((el, i) => (el.textContent = `Вопрос ${i + 1}`));
}

function resetQuizForm() {
  editingQuiz = null;
  $("qa-form-title").textContent = "Новая викторина";
  $("qa-save").textContent = "Добавить в очередь";
  $("qa-cancel").classList.add("hidden");
  $("qa-title").value = "";
  $("qa-reward").value = 1;
  $("qa-questions").innerHTML = "";
  $("qa-questions").appendChild(questionForm());
  numberQuestions();
}

function editQuiz(z) {
  editingQuiz = z.id;
  $("qa-form-title").textContent = `Правка: ${z.title}`;
  $("qa-save").textContent = "Сохранить изменения";
  $("qa-cancel").classList.remove("hidden");
  $("qa-title").value = z.title;
  $("qa-reward").value = z.reward;
  $("qa-questions").innerHTML = "";
  z.questions.filter(q=>!q.voided_at).forEach((q) => $("qa-questions").appendChild(questionForm(q)));
  numberQuestions();
  $("qa-msg").classList.add("hidden");
  $("qa-form-title").scrollIntoView({ behavior: "smooth" });
}

async function saveQuiz() {
  const body = {
    title: $("qa-title").value,
    reward: Number($("qa-reward").value),
    questions: [...document.querySelectorAll("#qa-questions .qa-q")].map((b) => ({
      id: Number(b.dataset.id) || null,
      source: b.querySelector(".qa-source").value,
      text: b.querySelector(".qa-text").value,
      media_id: Number(b.dataset.media) || null,
      answers: b.querySelector(".qa-answers").value,
    })),
  };
  const btn = $("qa-save");
  btn.disabled = true;
  try {
    const editing = editingQuiz;
    await quizAdminCall(editing ? `/api/admin/quizzes/${editing}` : "/api/admin/quizzes", editing ? "PUT" : "POST", body);
    resetQuizForm();
    showMsg($("qa-msg"), editing ? "Изменения сохранены" : "Викторина добавлена в очередь", true);
  } catch {} finally {
    btn.disabled = false;
  }
}

function initQuizzes() {
  $("qd-close").onclick = () => $("quiz-dialog").classList.add("hidden");
  $("quiz-dialog").addEventListener("click", (e) => e.target === e.currentTarget && e.target.classList.add("hidden"));
  if (!me.is_admin) return;
  $("quiz-admin").classList.remove("hidden");
  $("qs-save").onclick = async () => {
    try {
      await quizAdminCall("/api/admin/quiz-settings", "POST", {
        every_days: Number($("qs-every").value), time_limit: Number($("qs-time").value), attempts: Number($("qs-attempts").value),
      });
      showMsg($("qs-msg"), "Настройки сохранены, очередь пересчитана", true);
    } catch (e) {
      showMsg($("qs-msg"), e.message, false);
    }
  };
  $("qa-add").onclick = () => { $("qa-questions").appendChild(questionForm()); numberQuestions(); };
  $("qa-save").onclick = saveQuiz;
  $("qa-cancel").onclick = resetQuizForm;
  resetQuizForm();
}

// --- запуск ---

function startTab() {
  // Ссылки вида t.me/<бот>/<app>?startapp=quiz_<id> открывают нужный раздел
  const param = tg?.initDataUnsafe?.start_param || "";
  const link = /^quiz_(\d+)$/.exec(param);
  if (link) {
    // Прошедшая викторина открывается с ответами, текущая — просто на вкладке
    api("/api/quiz").then((s) => s.current?.id !== Number(link[1]) && openPastQuiz(Number(link[1]))).catch(() => {});
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
    if(e.data?.requires_processing_consent){renderProcessingConsent(e.data.policy);return;}
    showError(e.message);
    return;
  }
  renderProfile();
  if (me.is_new) {
    iconText($("welcome"), `Добро пожаловать! Вам начислено ${fmt(me.balance)} BIST.`, "spark");
    $("welcome").classList.remove("hidden");
    tg.HapticFeedback?.notificationOccurred("success");
  }
  $("user-close").onclick = () => $("user-dialog").classList.add("hidden");
  $("user-dialog").addEventListener("click", (e) => e.target === e.currentTarget && e.target.classList.add("hidden"));
  if (me.is_admin) {
    $("admin").classList.remove("hidden");
    $("dash").classList.remove("hidden");
    document.querySelectorAll("#dash-period button").forEach((b) => (b.onclick = () => {
      dashPeriod = b.dataset.period;
      document.querySelectorAll("#dash-period button").forEach((x) => x.classList.toggle("active", x === b));
      if (dashData) renderDashboard();
    }));
    loadDashboard();
    $("admin-search").onclick = adminSearch;
    $("admin-q").addEventListener("keydown", (e) => e.key === "Enter" && adminSearch());
    $("admin-apply").onclick = adminApply;
    $("u-apply").onclick = userAdjust;
    $("u-more").onclick = loadUserHistory;
    loadAudit();
  }
  initComplianceUI();
  initPredictions();
  initQuizzes();
  // Подгрузка истории при прокрутке до конца списка
  new IntersectionObserver(([e]) => e.isIntersecting && loadHistory()).observe($("history-more"));
  loadHistory();
  document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  $("loading").classList.add("hidden");
  $("nav").classList.remove("hidden");
  $("balance-chip").classList.remove("hidden");
  openTab(startTab());
}

function renderProcessingConsent(policy) {
  for (const t of TABS) $("tab-" + t).classList.add("hidden");
  $("nav").classList.add("hidden");
  $("loading").classList.add("hidden");
  const card = $("error");
  card.className = "card";
  card.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = "Обработка данных";
  const text = document.createElement("p");
  text.style.whiteSpace = "pre-wrap";
  text.textContent =
    policy.processing_consent +
    "\n" +
    policy.operator +
    "\n" +
    policy.operator_address +
    "\n" +
    policy.contacts +
    "\n" +
    policy.policy_text +
    "\n" +
    policy.personal_data +
    "\n" +
    policy.purposes +
    "\n" +
    policy.retention +
    "\n" +
    policy.rights +
    "\n" +
    JSON.stringify(policy.services);
  const accept = document.createElement("button");
  accept.className = "btn wide";
  accept.textContent = "Даю согласие на обработку данных";
  accept.onclick = async () => {
    accept.disabled = true;
    try {
      await api("/api/consents", {
        method: "POST",
        body: JSON.stringify({ granted: true, policy_version: policy.version, confirm_consent: true }),
      });
      location.reload();
    } catch (e) {
      showError(e.message);
    }
  };
  const reject = document.createElement("p");
  reject.textContent =
    "Можно отказаться: не нажимайте кнопку и закройте приложение. Публикация профиля, аватара и реклама включаются отдельно.";
  card.append(title, text, accept, reject);
}
let seasonInfo = null,
  boardSeason = null,
  privacyPolicy = null;
function openReport(kind, id) {
  if (bet) $("bet-dialog").classList.add("hidden");
  openTab("profile");
  $("request-kind").value = kind;
  $("request-target").value = id || "";
  $("request-panel").open = true;
  $("request-message").focus();
}
async function loadSeasonInfo() {
  try {
    seasonInfo = await api("/api/season");
    renderQualify();
    const select = $("board-season");
    select.replaceChildren(new Option(seasonInfo.season.label || seasonInfo.season.name, ""));
    for (const s of seasonInfo.seasons)
      if (s.id !== seasonInfo.season.id) select.add(new Option(s.label || s.id, s.id));
    select.value = boardSeason || "";
    if (seasonInfo.rules) {
      const r = seasonInfo.rules,
        labels = {
          organizer: "Организатор",
          contacts: "Контакты",
          eligibility: "Условия участия",
          season_id: "Сезон",
          threshold: "Порог BIST",
          pending_predictions: "Нерассчитанные прогнозы",
          tasks: "Задания",
          assessment: "Критерии оценки",
          attempts: "Попыток для каждого участника",
          tie_knowledge_task: "При равенстве",
          prizes: "Призы",
          prize_funding: "Финансирование",
          appeals: "Обращения",
          corrections: "Исправления",
          disputes: "Спорные результаты",
        };
      const lines = Object.entries(labels).map(([key, label]) => label + ": " + r[key]);
      for (const [key, label] of Object.entries({
        cutoff: "Окончание отбора",
        final_start: "Начало финала",
        final_end: "Окончание финала",
        results_at: "Объявление результатов",
        prizes_due: "Выдача призов",
        appeals_until: "Приём обращений до",
      }))
        lines.push(
          label +
            ": " +
            new Date(r[key] * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }) +
            " (Минск)",
        );
      $("final-rules").textContent = lines.join("\n\n");
    }
    const finals = await api("/api/finals");
    const root = $("my-finals");
    root.replaceChildren();
    for (const f of finals.items) {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("h2");
      title.textContent = "Финал " + f.season_id;
      const btn = document.createElement("button");
      btn.className = "btn wide";
      btn.textContent = "Открыть финальную викторину";
      btn.onclick = () => openFinal(f.season_id, card);
      const history = document.createElement("button");
      history.className = "btn ghost wide";
      history.textContent = "Мои ответы финала";
      history.onclick = async () => {
        try {
          const data = await api("/api/finals/" + f.season_id + "/history");
          const p = document.createElement("p");
          p.style.whiteSpace = "pre-wrap";
          p.textContent = data.items.length
            ? data.items
                .map(
                  (x) =>
                    "Попытка " +
                    x.round +
                    " · " +
                    new Date(x.submitted_at * 1000).toLocaleString("ru-RU") +
                    "\n" +
                    Object.entries(JSON.parse(x.answers))
                      .map(([q, a]) => q + ": " + a)
                      .join("\n") +
                    "\nОценка: " +
                    (x.score ?? "ожидает проверки"),
                )
                .join("\n\n")
            : "Ответов пока нет";
          card.append(p);
        } catch (e) {
          showError(e.message);
        }
      };
      card.append(title, btn, history);
      if (f.tiebreak) {
        const tie = document.createElement("button");
        tie.className = "btn ghost wide";
        tie.textContent = "Дополнительное задание на знания";
        tie.onclick = () => openKnowledgeTiebreak(f.season_id, card);
        card.append(tie);
      }
      root.append(card);
    }
  } catch (e) {
    $("final-rules").textContent = e.message;
  }
}
async function openFinal(id, card) {
  try {
    const f = await api("/api/finals/" + id + "/enter", { method: "POST" });
    const form = document.createElement("form");
    form.className = "final-task";
    const note = document.createElement("p");
    note.textContent =
      "Попыток для каждого участника: " + f.attempts + ". BIST не списываются и не влияют на результат.";
    form.append(note);
    for (const q of f.questions) {
      const label = document.createElement("label");
      label.textContent = q.text;
      const input = document.createElement("textarea");
      input.className = "input";
      input.name = q.id;
      input.required = true;
      input.maxLength = 5000;
      label.append(input);
      form.append(label);
    }
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "btn wide";
    send.textContent = "Отправить ответы";
    const msg = document.createElement("p");
    form.append(send, msg);
    form.onsubmit = async (e) => {
      e.preventDefault();
      send.disabled = true;
      try {
        await api("/api/finals/" + id + "/submit", {
          method: "POST",
          body: JSON.stringify({ answers: Object.fromEntries(new FormData(form)) }),
        });
        msg.textContent = "Ответы сохранены. Их проверит организатор по опубликованным критериям.";
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        send.disabled = false;
      }
    };
    card.replaceChildren(form);
  } catch (e) {
    const p = document.createElement("p");
    p.textContent = e.message;
    card.append(p);
  }
}
async function openKnowledgeTiebreak(id, card) {
  try {
    const q = await api("/api/finals/" + id + "/tiebreak");
    const form = document.createElement("form"),
      label = document.createElement("label"),
      input = document.createElement("textarea"),
      note = document.createElement("p"),
      send = document.createElement("button"),
      message = document.createElement("p");
    form.className = "final-task";
    label.textContent = q.text;
    input.className = "input";
    input.required = true;
    input.maxLength = 10000;
    label.append(input);
    note.textContent =
      "Источник: " + q.source + ". Оценка: " + q.rubric + ". Одна попытка для каждого участника.";
    send.className = "btn wide";
    send.textContent = "Отправить ответ";
    form.append(label, note, send, message);
    form.onsubmit = async (e) => {
      e.preventDefault();
      send.disabled = true;
      try {
        await api("/api/finals/" + id + "/tiebreak", {
          method: "POST",
          body: JSON.stringify({ answer: input.value }),
        });
        message.textContent = "Ответ сохранён для проверки организатором.";
      } catch (e) {
        message.textContent = e.message;
      } finally {
        send.disabled = false;
      }
    };
    card.replaceChildren(form);
  } catch (e) {
    const p = document.createElement("p");
    p.textContent = e.message;
    card.append(p);
  }
}
async function loadPrivacy() {
  try {
    const data = await api("/api/policy");
    privacyPolicy = data.policy;
    const prefs = await api("/api/preferences");
    $("processing-withdraw").classList.toggle("hidden", privacyPolicy?.processing_basis !== "consent");
    $("pref-profile").checked = Boolean(prefs.public_profile);
    $("pref-avatar").checked = Boolean(prefs.public_avatar);
    $("pref-marketing").checked = Boolean(prefs.marketing_opt_out);
    $("policy-content").textContent = privacyPolicy
      ? `${privacyPolicy.operator}\n${privacyPolicy.contacts}\n${privacyPolicy.policy_text}\nЦели: ${privacyPolicy.purposes}\nОснования: ${privacyPolicy.legal_bases}\nХранение: ${privacyPolicy.retention}\nСервисы и страны: ${privacyPolicy.services.map((s) => s.name + " — " + s.purpose + " (" + s.countries.join(", ") + ")").join("; ")}\nОбращения: ${privacyPolicy.rights}`
      : "Оператор и политика данных ещё не утверждены. До публикации политики включение публичности и рекламы недоступно; отключить их можно в любой момент.";
    $("consent-text").textContent = privacyPolicy
      ? `${privacyPolicy.publication_consent}\n${privacyPolicy.avatar_consent}\n${privacyPolicy.marketing_consent}\nСнятие отметки «Не получать рекламные уведомления» само по себе не означает согласия на рекламу. Согласия добровольные и отдельные; сохраняется версия ${privacyPolicy.version}.`
      : "Снятая отметка не означает согласия на рекламу. Рекламные сообщения без отдельного согласия не отправляются.";
  } catch (e) {
    $("policy-content").textContent = e.message;
  }
}
async function loadRequests() {
  try {
    const { items } = await api("/api/requests");
    $("my-requests").replaceChildren();
    for (const r of items) {
      const li = document.createElement("li");
      li.textContent =
        `№${r.id} · ${{ open: "Принято", in_review: "Рассматривается", resolved: "Решено", rejected: "Отклонено" }[r.status] || r.status} · ${r.message}` +
        (r.resolution ? " · " + r.resolution : "");
      $("my-requests").append(li);
    }
  } catch (e) {
    $("my-requests").textContent = e.message;
  }
}
function initComplianceUI() {
  // Browser-level deterrents only; Mini Apps cannot prevent OS screenshots or external cameras.
  const isTask = (target) => target instanceof Element && Boolean(target.closest(".question, .final-task"));
  const selectedTask = () => {
    const selection = window.getSelection();
    return (
      selection &&
      !selection.isCollapsed &&
      [...document.querySelectorAll(".question,.final-task")].some((node) =>
        selection.containsNode(node, true),
      )
    );
  };
  for (const event of ["copy", "cut", "contextmenu", "dragstart"])
    document.addEventListener(event, (e) => {
      if (
        (isTask(e.target) || (["copy", "cut"].includes(e.type) && selectedTask())) &&
        !e.target.closest("input,textarea")
      )
        e.preventDefault();
    });
  const conceal = (hidden) => document.documentElement.classList.toggle("tasks-obscured", hidden);
  document.addEventListener("visibilitychange", () => conceal(document.hidden));
  window.addEventListener("blur", () => conceal(true));
  window.addEventListener("focus", () => conceal(document.hidden));
  tg?.onEvent?.("deactivated", () => conceal(true));
  tg?.onEvent?.("activated", () => conceal(document.hidden));

  $("board-season").onchange = () => {
    boardSeason = $("board-season").value || null;
    loadBoard();
  };
  $("bet-report").onclick = () => openReport("prediction_error", bet?.match.id);
  $("processing-withdraw").onclick = async () => {
    try {
      await api("/api/consents", { method: "POST", body: JSON.stringify({ granted: false }) });
      renderProcessingConsent(privacyPolicy);
    } catch (e) {
      showMsg($("preferences-msg"), e.message, false);
    }
  };
  $("preferences-save").onclick = async () => {
    try {
      const values = {
        public_profile: $("pref-profile").checked,
        public_avatar: $("pref-avatar").checked,
        marketing_opt_out: $("pref-marketing").checked,
        policy_version: privacyPolicy?.version,
        confirm_consent: true,
      };
      await api("/api/preferences", { method: "PUT", body: JSON.stringify(values) });
      showMsg($("preferences-msg"), "Выбор сохранён", true);
      await loadPrivacy();
    } catch (e) {
      showMsg($("preferences-msg"), e.message, false);
    }
  };
  $("request-send").onclick = async () => {
    const btn = $("request-send");
    btn.disabled = true;
    try {
      const r = await api("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          kind: $("request-kind").value,
          target_id: Number($("request-target").value) || null,
          message: $("request-message").value,
        }),
      });
      showMsg($("request-msg"), "Обращение №" + r.id + " сохранено", true);
      $("request-message").value = "";
      await loadRequests();
    } catch (e) {
      showMsg($("request-msg"), e.message, false);
    } finally {
      btn.disabled = false;
    }
  };
  loadSeasonInfo();
  loadPrivacy();
  loadRequests();
}

// Keep keyboard focus inside an open sheet and return it to its opener.
let focusedBeforeSheet = null;
let activeSheet = null;
const focusableIn = (el) => [...el.querySelectorAll("button, input, textarea, select, a[href], summary, [tabindex]")]
  .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
new MutationObserver(() => {
  const next = [...document.querySelectorAll(".overlay")].find(el => !el.classList.contains("hidden"));
  if (next && next !== activeSheet) {
    focusedBeforeSheet = document.activeElement;
    activeSheet = next;
    document.body.classList.add("dialog-open");
    focusableIn(next)[0]?.focus();
  } else if (!next && activeSheet) {
    activeSheet = null;
    document.body.classList.remove("dialog-open");
    if (focusedBeforeSheet?.isConnected) focusedBeforeSheet.focus();
  } else if (next && !next.contains(document.activeElement)) {
    focusableIn(next)[0]?.focus();
  }
}).observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
document.addEventListener("keydown", (event) => {
  if (!activeSheet) return;
  if (event.key === "Escape") {
    event.preventDefault();
    activeSheet.querySelector(".sheet-head .icon-btn")?.click();
  } else if (event.key === "Tab") {
    const controls = focusableIn(activeSheet);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

init();

// Keep kickoff controls and LIVE labels current even when a screen stays open.
setInterval(() => {
  if (document.hidden) return;
  document.querySelectorAll("#match-list .match, #mine-list .pred-item").forEach(node => node.updateTiming?.());
  if (bet && !bet.loading) {
    const open = matchAcceptsPrediction(bet.match);
    $("bet-form").classList.toggle("hidden", !open || !bet.outcome);
    $("bet-cancel").classList.toggle("hidden", !open || !activeOf(bet.match));
    document.querySelectorAll("#bet-outcomes .odd").forEach(button => { button.disabled = !open; });
    if (!open) { $("bet-state").textContent = closedNote(bet.match); $("bet-state").classList.remove("hidden"); }
    updatePayout();
  }
}, 1000);
