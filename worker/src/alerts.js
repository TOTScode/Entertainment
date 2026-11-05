// Оповещения администраторам в Telegram. Запускаются после каждой синхронизации (раз в 30 минут),
// но по каждой причине пишут не чаще раза в сутки: время последнего оповещения хранится в api_state.

import { adminIds } from "./admin.js";
import { telegram } from "./bot.js";
import { toBist, UNIT } from "./money.js";
import { SYNC_STATUS } from "./sync.js";

export const ALERT_EVERY = 86400;
export const QUOTA_LOW = 40; // запросов OddsPapi
export const SYNC_FAILURES = 3; // сбоев синхронизации подряд
export const NO_RESULT_AFTER = 86400; // матч начался сутки назад, а результата нет
export const QUIZ_QUEUE_DAYS = 2;
export const SPIKE_BIST = 500; // чистый прирост BIST у одного игрока за сутки

const PREFIX = "alert:";

// Проверки по данным из базы. Возвращает [{ key, text }] — что сейчас не в порядке.
export function findProblems({ status, stale, queueEnd, spikes }, now) {
  const out = [];
  const q = status?.quota;
  if (q && q.left <= 0) out.push({ key: "quota", text: `Лимит OddsPapi закончился (${q.limit} в месяц). Коэффициенты не обновляются, результаты ЛЕ и ЛК не приходят.` });
  else if (q && q.left <= QUOTA_LOW) out.push({ key: "quota", text: `У OddsPapi осталось ${q.left} запросов из ${q.limit}. Часть резерва уходит на результаты.` });
  if ((status?.failures || 0) >= SYNC_FAILURES) {
    out.push({ key: "sync", text: `Синхронизация матчей падает ${status.failures} раз подряд. Последняя ошибка: ${status.last_error || "неизвестно"}` });
  }
  if (stale.length) {
    const list = stale.slice(0, 5).map((m) => `• ${m.home} — ${m.away}`).join("\n");
    const more = stale.length > 5 ? `\n…и ещё ${stale.length - 5}` : "";
    out.push({ key: "results", text: `Нет результата больше суток после начала (${stale.length}):\n${list}${more}\nПроверьте матч или рассчитайте вручную в админке.` });
  }
  if (!queueEnd || queueEnd <= now) out.push({ key: "quiz_queue", text: "Очередь викторин пуста: новых вопросов у игроков нет. Добавьте викторины в профиле → Викторины." });
  else if (queueEnd <= now + QUIZ_QUEUE_DAYS * 86400) {
    const hours = Math.round((queueEnd - now) / 3600);
    out.push({ key: "quiz_queue", text: `Викторин в очереди осталось примерно на ${hours} ч. Добавьте новые в профиле → Викторины.` });
  }
  for (const s of spikes) {
    out.push({ key: `spike:${s.user_id}`, text: `Резкий рост BIST: ${s.name} (ID ${s.user_id}) получил +${toBist(s.gain).toFixed(1)} BIST за сутки. Проверьте историю игрока.` });
  }
  return out;
}

export async function checkAlerts(env, now = Math.floor(Date.now() / 1000)) {
  const db = env.DB;
  const admins = [...adminIds(env)];
  const token = (env.BOT_TOKEN || "").trim();
  if (!admins.length || !token) return [];

  const [status, stale, queue, spikes, sent] = await db.batch([
    db.prepare("SELECT value FROM api_state WHERE key = ?").bind(SYNC_STATUS),
    db.prepare(
      "SELECT id, home, away FROM matches WHERE settled_at IS NULL AND status = 'scheduled' AND start_time < ? ORDER BY start_time",
    ).bind(now - NO_RESULT_AFTER),
    db.prepare("SELECT MAX(ends_at) AS end FROM quizzes"),
    db.prepare(
      "SELECT t.user_id, SUM(t.amount) AS gain, COALESCE(u.nickname, u.username, u.first_name, 'Игрок') AS name " +
      "FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.created_at > ? " +
      "GROUP BY t.user_id HAVING gain > ? ORDER BY gain DESC LIMIT 5",
    ).bind(now - 86400, SPIKE_BIST * UNIT),
    db.prepare("SELECT key, updated_at FROM api_state WHERE key LIKE ?").bind(`${PREFIX}%`),
  ]);
  const row = status.results[0];
  const problems = findProblems({
    status: row ? JSON.parse(row.value) : null,
    stale: stale.results,
    queueEnd: queue.results[0]?.end ?? null,
    spikes: spikes.results,
  }, now);

  const last = new Map(sent.results.map((r) => [r.key, r.updated_at]));
  const due = problems.filter((p) => !(now - (last.get(PREFIX + p.key) ?? -Infinity) < ALERT_EVERY));
  if (!due.length) return [];

  const text = `⚠️ TOTS\n\n${due.map((p) => p.text).join("\n\n")}`;
  await Promise.all(admins.map((id) => telegram(token, "sendMessage", { chat_id: id, text }).catch((e) => console.error(e))));
  await db.batch(due.map((p) =>
    db.prepare("INSERT INTO api_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
      .bind(PREFIX + p.key, JSON.stringify(p.text.slice(0, 200)), now),
  ));
  return due.map((p) => p.key);
}
