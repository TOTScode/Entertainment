// Минимальная замена Cloudflare D1 для тестов поверх встроенного node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
}

export function createDb({ upTo = Infinity, beforeLast } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => {
    if (i + 1 > upTo) return;
    if (beforeLast && i === files.length - 1) beforeLast(db);
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  });
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    applyRemaining(from) {
      files.slice(from).forEach((f) => db.exec(readFileSync(join(MIGRATIONS, f), "utf8")));
    },
  };
}
