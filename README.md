# TOTS — мини-приложение в Telegram

Бот: `https://t.me/TOTS_official_bot/entertain`

Сейчас умеет:
- регистрировать пользователя при первом входе по подписанным данным Telegram (`initData`) и один раз начислять 10 BIST (`START_BALANCE`);
- вести журнал транзакций BIST: баланс — это сумма транзакций, уйти в минус нельзя;
- показывать профиль: аватар, ник (можно сменить, уникальный), дату регистрации и стаж в TOTS;
- нижнее меню: «Викторины», «Прогнозы», «Таблица» (пока заглушки) и «Профиль»;
- бот отвечает на `/start` кнопкой «Открыть TOTS», на `/id` — Telegram ID пользователя; у бота есть кнопка меню;
- ссылки `?startapp=quiz_<id>` открывают раздел викторин;
- админка (в профиле, только для `ADMIN_IDS`): поиск пользователя, ручное изменение баланса с обязательной причиной, журнал аудита.

Стек: Cloudflare Workers (JavaScript) + Cloudflare D1. План развития — `plan-v0.2.md` в файлах проекта, что уже сделано — [`docs/progress.md`](docs/progress.md).

## Хостинг на Cloudflare Workers

Сервер (`worker/src/`) и интерфейс (`webapp/`) работают на Cloudflare Workers, данные — в базе Cloudflare D1.
Деплой выполняется автоматически при пуше в `main` (`.github/workflows/cloudflare.yml`): тесты,
миграции базы, выкладка, сохранение токена бота, регистрация вебхука и кнопки меню.

Разовая настройка:
1. Зарегистрируйтесь на https://dash.cloudflare.com и откройте раздел **Workers & Pages**, чтобы
   у аккаунта появился поддомен `*.workers.dev`.
2. **Account ID** указан справа на странице Workers & Pages (или в адресной строке дашборда).
3. API-токен: My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers**,
   затем добавьте право **Account → D1 → Edit** → Create Token.
4. В GitHub: Settings → Secrets and variables → Actions → New repository secret. Создайте
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` и `BOT_TOKEN` (токен бота из BotFather).
5. Actions → Deploy to Cloudflare Workers → Run workflow. Адрес приложения будет
   `https://tots.<ваш-поддомен>.workers.dev`, его и указывайте в BotFather.
6. Администраторы: узнайте свой Telegram ID командой `/id` в боте, затем в GitHub откройте
   Settings → Secrets and variables → Actions → вкладка **Variables** → New repository variable,
   имя `ADMIN_IDS`, значение — ID через запятую. Запустите деплой ещё раз.

## Откат

- Код: `git revert` нужного коммита в `main`, деплой вернёт прежнюю версию.
- База: каждый деплой записывает точку восстановления (шаг «Save database restore point» в Actions).
  Вернуть базу к ней: `npx wrangler d1 time-travel restore tots --timestamp=<время>`.

Важно: в России Cloudflare местами замедляют, у части пользователей приложение может открываться плохо.

## Как устроено

- `worker/src/index.js` — маршруты: интерфейс, API `/api/*`, вебхук бота `/telegram/webhook`.
- `worker/src/auth.js` — проверка подписи `initData` и секрета вебхука.
- `worker/src/users.js` — пользователи, ники, журнал транзакций BIST.
- `worker/src/admin.js` — API админки и журнал аудита.
- `worker/src/bot.js` — ответы бота.
- `worker/migrations/` — миграции базы D1.
- `webapp/` — интерфейс (подстраивается под тему Telegram).
- `worker/test/` — тесты (`npm test`, Node 22+, база в тестах — встроенный `node:sqlite`).

## Старая Python-версия

`main.py`, `web.py`, `bot.py` и соседние файлы — первая версия сервера (aiogram + aiohttp + SQLite) для VPS.
Она не обновлялась под журнал транзакций и админку и оставлена для истории.
