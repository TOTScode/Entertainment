// Build a demo of the actual frontend. Fixtures are never included in webapp/dist.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
let html = readFileSync(new URL("webapp/index.html", root), "utf8");
html = html.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '<script src="preview-fixtures.js"></script>');
html = html.replaceAll('href="static/', 'href="../webapp/static/').replaceAll('src="static/', 'src="../webapp/static/');
html = html.replace("<title>TOTS</title>", "<title>TOTS · новый дизайн · демонстрация</title>");
html = html.replace("<body>", `<body>
<aside class="preview-tools" aria-label="Настройки демонстрации">
  <strong>Новый дизайн TOTS</strong><p>Рабочие компоненты · вымышленные данные · без настоящих операций</p>
  <div><label>Тема<select id="preview-theme"><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
  <label>Состояние<select id="preview-state"><option value="normal">Обычное</option><option value="sample">Пример таблицы</option><option value="empty">Нет данных</option><option value="error">Ошибка сети</option><option value="loading">Загрузка</option></select></label>
  <label>Роль<select id="preview-role"><option value="player">Игрок</option><option value="admin">Администратор</option></select></label></div>
</aside>
<style>.preview-tools{max-width:640px;margin:20px auto 0;border-bottom:1px solid var(--line);padding:0 0 20px}.preview-tools strong{font-size:14px}.preview-tools p{font-size:12px;color:var(--hint);margin:6px 0 12px}.preview-tools>div{display:flex;gap:12px;flex-wrap:wrap}.preview-tools label{font-size:12px;color:var(--hint);display:grid;gap:4px;flex:1;min-width:120px}.preview-tools select{width:100%;min-height:44px;background:var(--card);color:var(--text);border:1px solid var(--input-line);border-radius:8px;padding:8px;font:inherit}</style>`);
for (const path of ["docs/preview-fixtures.js", "webapp/static/style.css", "webapp/static/app.js"]) {
  const version = createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex").slice(0, 10);
  const asset = path.startsWith("docs/") ? path.slice(5) : "../" + path;
  html = html.replaceAll(asset + '"', asset + "?v=" + version + '"');
}
writeFileSync(new URL("docs/design-preview.html", root), html);
