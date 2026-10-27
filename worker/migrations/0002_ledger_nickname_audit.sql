-- Этап 1: журнал транзакций BIST, ник пользователя, журнал аудита.

-- Журнал транзакций — единственный источник правды о балансе.
-- Баланс пользователя = SUM(amount) по его транзакциям.
CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    amount      INTEGER NOT NULL,       -- со знаком: + начисление, − списание
    type        TEXT    NOT NULL,       -- signup_bonus, quiz_reward, bet, payout, refund, admin_adjustment
    ref         TEXT,                   -- источник: id викторины, ставки, записи аудита
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id);
-- Стартовый бонус начисляется ровно один раз
CREATE UNIQUE INDEX IF NOT EXISTS transactions_signup_once ON transactions(user_id) WHERE type = 'signup_bonus';

-- Перенос текущих балансов в журнал
INSERT INTO transactions (user_id, amount, type, ref, created_at)
SELECT id, balance, 'signup_bonus', 'migration_0002', created_at FROM users;

ALTER TABLE users DROP COLUMN balance;

-- Ник: NULL — показываем имя из Telegram. nickname_key — ник в нижнем регистре для уникальности.
ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN nickname_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_key ON users(nickname_key);

-- Журнал всех ручных действий администраторов
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id        INTEGER NOT NULL,
    action          TEXT    NOT NULL,
    target_user_id  INTEGER,
    reason          TEXT    NOT NULL,
    before_data     TEXT,               -- JSON
    after_data      TEXT,               -- JSON
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at);
