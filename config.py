import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Минимальный загрузчик .env, чтобы не тянуть лишнюю зависимость."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(__file__).with_name(".env"))


@dataclass(frozen=True)
class Config:
    bot_token: str
    bot_username: str
    webapp_short_name: str
    webapp_url: str
    port: int
    start_balance: int
    db_path: str

    @property
    def app_link(self) -> str:
        """Ссылка t.me, по которой мини-приложение открывается прямо из Telegram."""
        if self.webapp_short_name:
            return f"https://t.me/{self.bot_username}/{self.webapp_short_name}"
        return f"https://t.me/{self.bot_username}?startapp"


def load_config() -> Config:
    return Config(
        bot_token=os.environ.get("BOT_TOKEN", ""),
        bot_username=os.environ.get("BOT_USERNAME", "").lstrip("@"),
        webapp_short_name=os.environ.get("WEBAPP_SHORT_NAME", ""),
        webapp_url=os.environ.get("WEBAPP_URL", "").rstrip("/"),
        port=int(os.environ.get("PORT", "8080")),
        start_balance=int(os.environ.get("START_BALANCE", "10")),
        db_path=os.environ.get("DB_PATH", "tots.db"),
    )
