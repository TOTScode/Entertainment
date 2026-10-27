const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (id) => document.getElementById(id);
const TABS = ["quizzes", "predictions", "table", "profile"];
let me = null;
let adminTarget = null;

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
      me.balance = res.user.balance;
      renderProfile();
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
  if (me.is_admin) {
    $("admin").classList.remove("hidden");
    $("admin-search").onclick = adminSearch;
    $("admin-q").addEventListener("keydown", (e) => e.key === "Enter" && adminSearch());
    $("admin-apply").onclick = adminApply;
    loadAudit();
  }
  document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  $("loading").classList.add("hidden");
  $("nav").classList.remove("hidden");
  $("balance-chip").classList.remove("hidden");
  openTab(startTab());
}

init();
