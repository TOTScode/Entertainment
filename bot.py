from aiogram import Router
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from config import Config


def build_router(config: Config) -> Router:
    router = Router()

    @router.message(CommandStart())
    async def start(message: Message) -> None:
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="⚽️ Открыть TOTS", web_app=WebAppInfo(url=config.webapp_url))
        ]])
        await message.answer(
            "Добро пожаловать в TOTS! Открой приложение, чтобы увидеть свой баланс бистов.\n"
            f"Ссылка, которой можно поделиться: {config.app_link}",
            reply_markup=kb,
        )

    return router
