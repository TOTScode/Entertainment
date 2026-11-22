// Бот: Telegram присылает сообщения вебхуком на /telegram/webhook.

export async function telegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Telegram ${method} failed: ${res.status} ${await res.text()}`);
}

export async function handleUpdate(update, botToken, appUrl, db = null) {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return;
  const command = text.split(/[\s@]/)[0];

  if ((command === "/stopads" || command === "/stop") && db && message.from?.id) {
    await db.batch([
      db.prepare("UPDATE users SET marketing_opt_in=0,marketing_opt_out=1 WHERE id=?").bind(message.from.id),
      db
        .prepare(
          "INSERT INTO privacy_events(user_id,purpose,granted,created_at) VALUES(?,'marketing_opt_in',0,?)",
        )
        .bind(message.from.id, Math.floor(Date.now() / 1000)),
    ]);
    await telegram(botToken, "sendMessage", {
      chat_id: message.chat.id,
      text: "Рекламные уведомления отключены.",
    });
  } else if (command === "/start") {
    await telegram(botToken, "sendMessage", {
      chat_id: message.chat.id,
      text: "TOTS — интеллектуальные викторины и спортивные прогнозы. BIST начисляются бесплатно: их нельзя купить, продать, передать или обменять на деньги, товары и сертификаты. Условия финала публикует организатор. Открой приложение 👇",
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

// All future promotional mailings must pass this guard, checked again before every delivery.
export async function sendMarketing(db, botToken, userId, text) {
  const user = await db
    .prepare("SELECT marketing_opt_in,marketing_opt_out FROM users WHERE id=?")
    .bind(userId)
    .first();
  if (!user?.marketing_opt_in || user.marketing_opt_out) return false;
  await telegram(botToken, "sendMessage", { chat_id: userId, text });
  return true;
}
