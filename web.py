from pathlib import Path

from aiohttp import web

from auth import validate_init_data
from config import Config
from db import Database

WEBAPP_DIR = Path(__file__).with_name("webapp")


def display_name(user: dict) -> str:
    name = " ".join(p for p in (user.get("first_name"), user.get("last_name")) if p)
    return name or (user.get("username") and "@" + user["username"]) or "Игрок"


def create_app(config: Config, db: Database) -> web.Application:
    @web.middleware
    async def cors_middleware(request: web.Request, handler):
        # Фронтенд может жить на другом домене (например, GitHub Pages)
        if request.method == "OPTIONS" and request.path.startswith("/api/"):
            response = web.Response()
        else:
            response = await handler(request)
        if request.path.startswith("/api/"):
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Headers"] = "X-Telegram-Init-Data, Content-Type"
        return response

    @web.middleware
    async def auth_middleware(request: web.Request, handler):
        if request.path.startswith("/api/") and request.method != "OPTIONS":
            tg_user = validate_init_data(request.headers.get("X-Telegram-Init-Data", ""), config.bot_token)
            if not tg_user:
                return web.json_response({"error": "Откройте приложение из Telegram"}, status=401)
            request["user"], request["is_new"] = db.register_or_update(tg_user)
        return await handler(request)

    async def index(_: web.Request) -> web.FileResponse:
        return web.FileResponse(WEBAPP_DIR / "index.html")

    async def frontend_config(_: web.Request) -> web.Response:
        # Страница отдана этим сервером, значит API на том же домене
        return web.Response(text='window.TOTS_API_URL = "";\n', content_type="application/javascript")

    async def me(request: web.Request) -> web.Response:
        user = request["user"]
        return web.json_response({
            "id": user["id"],
            "name": display_name(user),
            "username": user["username"],
            "photo_url": user["photo_url"],
            "balance": user["balance"],
            "is_new": request["is_new"],
        })

    app = web.Application(middlewares=[cors_middleware, auth_middleware])
    app.router.add_get("/", index)
    app.router.add_get("/static/config.js", frontend_config)
    app.router.add_get("/api/me", me)
    app.router.add_static("/static/", WEBAPP_DIR / "static")
    return app
