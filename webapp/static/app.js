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

const TX_LABELS = {
  signup_bonus: "Бонус за регистрацию",
  admin_adjustment: "Корректировка администратора",
  quiz_reward: "Награда за викторину",
  bet: "Прогноз",
  payout: "Выигрыш по прогнозу",
  refund: "Возврат",
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
  if (!res.ok) throw new Error(data.error || "Ошибка сервера");
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
  document.querySelectorAll(".segmented button").forEach((b) => (b.onclick = () => {
    boardPeriod = b.dataset.period;
    document.querySelectorAll(".segmented button").forEach((x) => x.classList.toggle("active", x === b));
    loadBoard();
  }));
  // Подгрузка истории при прокрутке до конца списка
  new IntersectionObserver(([e]) => e.isIntersecting && loadHistory()).observe($("history-more"));
  loadHistory();
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
  $("balance").textContent = me.balance;
  $("chip-balance").textContent = me.balance;
  $("tenure").textContent = `Стаж ${tenure(me.registered_at)}`;
  $("tenure").title = `В TOTS с ${formatDate(me.registered_at)}`;
  if (me.stats) {
    $("stat-earned").textContent = `+${me.stats.earned}`;
    $("stat-spent").textContent = `−${me.stats.spent}`;
  }
}

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
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
  score.textContent = boardPeriod === "all" ? r.score : signed(r.score);
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
  if (u.balance != null) $("u-balance").textContent = u.balance;
  if ("username" in u) {
    $("u-username").textContent = u.username ? "@" + u.username : "";
    $("u-username").href = u.username ? `https://t.me/${encodeURIComponent(u.username)}` : "";
  }
  if (u.registered_at) $("u-tenure").textContent = `Стаж ${tenure(u.registered_at)}`;
  if (u.stats) {
    $("u-earned").textContent = `+${u.stats.earned}`;
    $("u-spent").textContent = `−${u.stats.spent}`;
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
      bal.textContent = `${u.balance} BIST`;
      li.append(label, bal);
      li.onclick = () => {
        adminTarget = u;
        list.querySelectorAll("li").forEach((el) => el.classList.toggle("active", el === li));
        $("admin-target").textContent = `${u.name}: ${u.balance} BIST`;
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
    $("admin-target").textContent = `${res.user.name}: ${res.user.balance} BIST`;
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
      const sign = e.after.amount > 0 ? "+" : "";
      li.textContent =
        `${new Date(e.created_at * 1000).toLocaleString("ru-RU")} · ${e.target_name}: ${sign}${e.after.amount} BIST ` +
        `(${e.before.balance} → ${e.after.balance}) · «${e.reason}» · админ ${e.admin_id}`;
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = "";
  }
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
    $("welcome").textContent = `🎉 Добро пожаловать! Вам начислено ${me.balance} BIST.`;
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
  document.querySelectorAll(".segmented button").forEach((b) => (b.onclick = () => {
    boardPeriod = b.dataset.period;
    document.querySelectorAll(".segmented button").forEach((x) => x.classList.toggle("active", x === b));
    loadBoard();
  }));
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
