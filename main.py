import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiohttp import web

from bot import build_router
from config import load_config
from db import Database
from web import create_app


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    config = load_config()
    if not config.bot_token:
        raise SystemExit("Заполните .env (см. .env.example)")
    db = Database(config.db_path, config.start_balance)

    runner = web.AppRunner(create_app(config, db))
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", config.port).start()
    logging.info("TOTS: веб-сервер слушает порт %s, ссылка на приложение %s", config.port, config.app_link)

    bot = Bot(config.bot_token)
    dp = Dispatcher()
    dp.include_router(build_router(config))
    try:
        await dp.start_polling(bot)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
