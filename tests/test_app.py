import hashlib
import hmac
import json
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from auth import validate_init_data  # noqa: E402
from config import Config  # noqa: E402
from db import Database  # noqa: E402
from web import create_app  # noqa: E402

TOKEN = "123:TEST"


def make_init_data(user: dict, token: str = TOKEN) -> str:
    fields = {"auth_date": str(int(time.time())), "user": json.dumps(user, ensure_ascii=False)}
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


class InitDataTest(unittest.TestCase):
    def test_valid_and_forged(self):
        self.assertEqual(validate_init_data(make_init_data({"id": 42}), TOKEN)["id"], 42)
        self.assertIsNone(validate_init_data(make_init_data({"id": 42}, token="999:OTHER"), TOKEN))
        self.assertIsNone(validate_init_data("", TOKEN))


class ConfigTest(unittest.TestCase):
    def test_app_link(self):
        c = Config(TOKEN, "tots_bot", "tots", "https://x", 0, 10, ":memory:")
        self.assertEqual(c.app_link, "https://t.me/tots_bot/tots")
        c = Config(TOKEN, "tots_bot", "", "https://x", 0, 10, ":memory:")
        self.assertEqual(c.app_link, "https://t.me/tots_bot?startapp")


class ApiTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        config = Config(TOKEN, "tots_bot", "tots", "https://x", 0, 10, ":memory:")
        self.db = Database(":memory:", config.start_balance)
        self.client = TestClient(TestServer(create_app(config, self.db)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def me(self, user: dict):
        return await self.client.get("/api/me", headers={"X-Telegram-Init-Data": make_init_data(user)})

    async def test_requires_telegram_auth(self):
        self.assertEqual((await self.client.get("/api/me")).status, 401)
        r = await self.client.get("/api/me", headers={"X-Telegram-Init-Data": make_init_data({"id": 1}, "9:X")})
        self.assertEqual(r.status, 401)

    async def test_auto_registration(self):
        user = {"id": 7, "first_name": "Алексей", "last_name": "Смирнов", "username": "alexey"}
        r = await self.me(user)
        data = await r.json()
        self.assertEqual(data["name"], "Алексей Смирнов")
        self.assertEqual(data["balance"], 10)
        self.assertTrue(data["is_new"])

        # повторный вход: баланс не начисляется заново, имя подтягивается свежее
        self.db.conn.execute("UPDATE users SET balance = 3 WHERE id = 7")
        r = await self.me({**user, "first_name": "Лёша", "last_name": None})
        data = await r.json()
        self.assertEqual((data["name"], data["balance"], data["is_new"]), ("Лёша", 3, False))

    async def test_name_fallbacks(self):
        self.assertEqual((await (await self.me({"id": 8, "username": "nick"})).json())["name"], "@nick")
        self.assertEqual((await (await self.me({"id": 9})).json())["name"], "Игрок")

    async def test_index_served(self):
        self.assertEqual((await self.client.get("/")).status, 200)
        self.assertEqual((await self.client.get("/static/app.js")).status, 200)
        r = await self.client.get("/static/config.js")
        self.assertIn('TOTS_API_URL = ""', await r.text())

    async def test_cors_preflight(self):
        r = await self.client.options("/api/me")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")


if __name__ == "__main__":
    unittest.main()
