import sqlite3
import time
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,    -- Telegram user id
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    photo_url   TEXT,
    balance     INTEGER NOT NULL,       -- в бистах
    created_at  INTEGER NOT NULL
);
"""


class Database:
    def __init__(self, path: str, start_balance: int = 10):
        self.start_balance = start_balance
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def register_or_update(self, tg_user: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Авторегистрация: при первом входе создаёт пользователя со стартовым балансом,
        дальше только обновляет имя/фото из Telegram. Возвращает (пользователь, создан_ли_сейчас)."""
        fields = (
            tg_user.get("username"),
            tg_user.get("first_name"),
            tg_user.get("last_name"),
            tg_user.get("photo_url"),
        )
        with self.conn:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO users (id, username, first_name, last_name, photo_url, balance, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tg_user["id"], *fields, self.start_balance, int(time.time())),
            )
            created = cur.rowcount > 0
            if not created:
                self.conn.execute(
                    "UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ? WHERE id = ?",
                    (*fields, tg_user["id"]),
                )
        return self.get_user(tg_user["id"]), created

    def get_user(self, user_id: int) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None
