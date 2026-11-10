'use strict';
// Camada de banco de dados. Produção: PostgreSQL (DATABASE_URL). Desenvolvimento/testes: SQLite embutido do Node (>=22.5).
// O SQL abaixo usa apenas o subconjunto comum aos dois (placeholders $1,$2..., ON CONFLICT, RETURNING).
const path = require('path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
     id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE,
     pass_hash TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS campaigns(
     id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
     join_code TEXT NOT NULL UNIQUE, allow_layers INTEGER NOT NULL DEFAULT 0,
     potions TEXT NOT NULL, rev BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members(
     campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK(role IN ('master','player')), joined_at BIGINT NOT NULL,
     PRIMARY KEY(campaign_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS sheets(
     id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
     owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL,
     rev BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sheets_campaign ON sheets(campaign_id)`,
  `CREATE INDEX IF NOT EXISTS members_user ON members(user_id)`,
];

let impl;
if (process.env.DATABASE_URL) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number
  const host = new URL(process.env.DATABASE_URL).hostname;
  const ssl = process.env.PGSSL ? process.env.PGSSL !== 'disable' : host.includes('.') && !/^(localhost|127\.)/.test(host);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: ssl ? { rejectUnauthorized: false } : false, max: 10 });
  impl = {
    kind: 'pg', fu: ' FOR UPDATE',
    query: async (sql, p = []) => (await pool.query(sql, p)).rows,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, p = []) => (await c.query(sql, p)).rows);
        await c.query('COMMIT');
        return out;
      } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
      finally { c.release(); }
    },
    async init() { for (const s of SCHEMA) await pool.query(s); },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_PATH || path.join(__dirname, 'data.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const conv = s => s.replace(/\$(\d+)/g, '?$1');
  const run = (sql, p) => {
    const st = db.prepare(conv(sql));
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return st.all(...p).map(r => ({ ...r }));
    st.run(...p); return [];
  };
  let chain = Promise.resolve(); // serializa tudo: uma única conexão
  const enqueue = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  impl = {
    kind: 'sqlite', fu: '',
    query: (sql, p = []) => enqueue(() => run(sql, p)),
    tx: fn => enqueue(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const out = await fn(async (sql, p = []) => run(sql, p)); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }),
    async init() { for (const s of SCHEMA) db.exec(s); },
  };
}
module.exports = impl;
