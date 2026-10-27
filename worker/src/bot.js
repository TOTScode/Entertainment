// Бот: Telegram присылает сообщения вебхуком на /telegram/webhook.

async function telegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Telegram ${method} failed: ${res.status} ${await res.text()}`);
}

export async function handleUpdate(update, botToken, appUrl) {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return;
  const command = text.split(/[\s@]/)[0];

  if (command === "/start") {
    await telegram(botToken, "sendMessage", {
      chat_id: message.chat.id,
      text: "Добро пожаловать в TOTS! Викторины, прогнозы на матчи и рейтинг сообщества. Открой приложение 👇",
      reply_markup: { inline_keyboard: [[{ text: "⚽️ Открыть TOTS", web_app: { url: appUrl } }]] },
    });
  } else if (command === "/id") {
    // Помогает узнать свой Telegram ID для ADMIN_IDS
    await telegram(botToken, "sendMessage", {
      chat_id: message.chat.id,
      text: `Ваш Telegram ID: ${message.from?.id}`,
    });
  }
}
