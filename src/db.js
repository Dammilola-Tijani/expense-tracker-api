import { DatabaseSync } from 'node:sqlite';

export function openDb(file = process.env.DB_FILE || 'expenses.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      UNIQUE (user_id, name)
    );

    -- Money is stored as integer cents: floats can't represent 0.10 exactly,
    -- and errors would accumulate in sums.
    CREATE TABLE IF NOT EXISTS expenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
      description   TEXT NOT NULL DEFAULT '',
      spent_on      TEXT NOT NULL,           -- YYYY-MM-DD
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Matches the list query's filter + sort: WHERE user_id = ? ORDER BY spent_on DESC, id DESC.
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses (user_id, spent_on DESC, id DESC);
  `);
  return db;
}
