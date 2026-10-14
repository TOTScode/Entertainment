CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,    -- Telegram user id
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    photo_url   TEXT,
    balance     INTEGER NOT NULL,       -- в бистах
    created_at  INTEGER NOT NULL
);
