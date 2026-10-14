# TOTS — мини-приложение в Telegram

Сейчас умеет:
- открываться из Telegram по ссылке `https://t.me/<бот>/<приложение>`;
- автоматически регистрировать пользователя при первом входе (данные берутся из подписанного Telegram `initData`, подделать их нельзя);
- показывать имя, @username, аватар из профиля Telegram и баланс;
- при регистрации начислять **10 бистов** (бист — внутренняя монета; сумма меняется в `START_BALANCE`).

Стек: Python 3.11+, aiogram 3 (бот), aiohttp (веб-сервер и API), SQLite.

## Хостинг на GitHub Pages (без сервера)

Папка `webapp/` автоматически публикуется на GitHub Pages при каждом пуше в `main`
(`.github/workflows/pages.yml`). Адрес: **https://greendend.github.io/TOTS/** — его и указывайте
в BotFather как Web App URL.

В этом режиме сервера нет: имя и фото берутся из Telegram, а баланс хранится в Telegram CloudStorage
самого пользователя (при первом входе туда записывается 10 бистов). Это годится для старта, но такой баланс
технически может изменить сам пользователь. Когда бисты начнут что-то стоить, поднимите бэкенд (ниже)
и пропишите его адрес в `webapp/static/config.js` (`window.TOTS_API_URL = "https://..."`): тогда баланс
будет храниться на сервере, а подпись Telegram проверяться на каждом запросе.

## 1. Бот и мини-приложение в @BotFather

1. `/newbot` → получите токен (`BOT_TOKEN`) и юзернейм бота (`BOT_USERNAME`).
2. `/newapp` → выберите бота, укажите название «TOTS», описание, картинку 640×360,
   **Web App URL** — ваш HTTPS-адрес сервера (см. п. 2), **short name** — например `tots` (`WEBAPP_SHORT_NAME`).
3. Ссылка на приложение: `https://t.me/<BOT_USERNAME>/tots`. Её можно публиковать в канале или отправлять кому угодно.

Альтернатива: BotFather → Bot Settings → Configure Mini App (главное приложение бота). Тогда оставьте
`WEBAPP_SHORT_NAME` пустым, ссылка будет `https://t.me/<BOT_USERNAME>?startapp`.

## 2. Хостинг

Telegram открывает мини-приложения только по **HTTPS**. Подойдёт любой VPS (с nginx/Caddy и сертификатом
Let's Encrypt) или PaaS с HTTPS из коробки: Railway, Render, Fly.io и т.п.

```bash
cp .env.example .env      # заполните значения
pip install -r requirements.txt
python main.py            # поднимает веб-сервер на PORT и запускает бота
```

Через Docker (база хранится в томе `/data`):

```bash
docker build -t tots .
docker run -d --env-file .env -p 8080:8080 -v tots-data:/data tots
```

Для локальной проверки можно пробросить порт через `ngrok http 8080` или `cloudflared tunnel`
и временно указать полученный HTTPS-адрес в BotFather.

## 3. Переменные `.env`

| Переменная | Что это |
|---|---|
| `BOT_TOKEN` | токен бота |
| `BOT_USERNAME` | юзернейм бота без @ |
| `WEBAPP_SHORT_NAME` | short name из `/newapp` (или пусто) |
| `WEBAPP_URL` | публичный HTTPS-адрес сервера |
| `PORT` | порт веб-сервера, по умолчанию 8080 |
| `START_BALANCE` | бисты при регистрации, по умолчанию 10 |
| `DB_PATH` | путь к SQLite-базе |

## Как устроено

- `web.py` — раздаёт страницу и API `GET /api/me`. Каждый запрос проверяет подпись `initData`;
  при первом запросе пользователь создаётся со стартовым балансом, дальше обновляются только имя и фото.
- `db.py` — таблица `users` (id Telegram, имя, username, фото, `balance` в бистах).
- `bot.py` — команда `/start` с кнопкой «Открыть TOTS» и ссылкой на приложение.
- `webapp/` — интерфейс; `webapp/static/config.js` переключает режим (с бэкендом или без) (подстраивается под светлую/тёмную тему Telegram).

Тесты: `python -m unittest discover -s tests`.
