const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (id) => document.getElementById(id);
const START_BALANCE = 10;
const BALANCE_KEY = "tots_balance";

function pluralBeast(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "бист";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "биста";
  return "бистов";
}

function showError(text) {
  $("loading").classList.add("hidden");
  $("error").textContent = text;
  $("error").classList.remove("hidden");
}

function renderAvatar(me) {
  const el = $("avatar");
  if (me.photo_url) {
    el.style.backgroundImage = `url("${encodeURI(me.photo_url)}")`;
  } else {
    el.textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  }
}

// Режим с бэкендом: сервер проверяет подпись initData, регистрирует и хранит баланс.
async function loadFromApi(baseUrl) {
  const res = await fetch(`${baseUrl}/api/me`, { headers: { "X-Telegram-Init-Data": tg.initData } });
  const me = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(me.error || "Ошибка сервера");
  return me;
}

function cloudGet(key) {
  return new Promise((resolve, reject) =>
    tg.CloudStorage.getItem(key, (err, value) => (err ? reject(new Error(err)) : resolve(value))));
}

function cloudSet(key, value) {
  return new Promise((resolve, reject) =>
    tg.CloudStorage.setItem(key, value, (err) => (err ? reject(new Error(err)) : resolve())));
}

// Режим без бэкенда (GitHub Pages): профиль из Telegram, баланс в Telegram CloudStorage пользователя.
async function loadFromTelegram() {
  const u = tg.initDataUnsafe?.user;
  if (!u) throw new Error("Telegram не передал данные профиля.");
  if (!tg.CloudStorage || !tg.isVersionAtLeast?.("6.9")) {
    throw new Error("Обновите Telegram, чтобы открыть TOTS.");
  }
  let stored = await cloudGet(BALANCE_KEY);
  const isNew = !stored;
  if (isNew) {
    stored = String(START_BALANCE);
    await cloudSet(BALANCE_KEY, stored);
  }
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? "@" + u.username : "Игрок");
  return { id: u.id, name, username: u.username, photo_url: u.photo_url, balance: Number(stored), is_new: isNew };
}

async function init() {
  if (!tg?.initData) {
    showError("Откройте TOTS из Telegram по ссылке на бота.");
    return;
  }
  try {
    const api = window.TOTS_API_URL;
    const me = api === null || api === undefined ? await loadFromTelegram() : await loadFromApi(api);

    $("name").textContent = me.name;
    $("username").textContent = me.username ? "@" + me.username : "";
    renderAvatar(me);
    $("balance").textContent = me.balance;
    $("coin-label").textContent = pluralBeast(me.balance);
    if (me.is_new) {
      $("welcome").textContent = `🎉 Добро пожаловать! Вам начислено ${me.balance} ${pluralBeast(me.balance)}.`;
      $("welcome").classList.remove("hidden");
      tg.HapticFeedback?.notificationOccurred("success");
    }
    $("loading").classList.add("hidden");
    $("profile").classList.remove("hidden");
    $("wallet").classList.remove("hidden");
  } catch (e) {
    showError(e.message);
  }
}

init();
