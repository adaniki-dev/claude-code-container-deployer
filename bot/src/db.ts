import Database, { type Database as DB } from "better-sqlite3";
import { config } from "./config.js";

export interface User {
  id: number;
  telegram_id: number;
  totp_secret: string | null;
  is_registered: number;
  created_at: string;
}

export interface Session {
  id: number;
  telegram_id: number;
  claude_session_id: string | null;
  deployment_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

let db: DB;

export function initDb(): void {
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      totp_secret TEXT,
      is_registered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      claude_session_id TEXT,
      deployment_name TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );
  `);
}

export function getUser(telegramId: number): User | undefined {
  return db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as User | undefined;
}

export function upsertUser(telegramId: number, totpSecret: string): void {
  db.prepare(
    `INSERT INTO users (telegram_id, totp_secret)
     VALUES (?, ?)
     ON CONFLICT (telegram_id) DO UPDATE SET totp_secret = excluded.totp_secret`,
  ).run(telegramId, totpSecret);
}

export function markRegistered(telegramId: number): void {
  db.prepare("UPDATE users SET is_registered = 1 WHERE telegram_id = ?").run(
    telegramId,
  );
}

export function getSession(telegramId: number): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE telegram_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(telegramId) as Session | undefined;
}

export function upsertSession(
  telegramId: number,
  deploymentName: string,
  claudeSessionId?: string,
): void {
  const existing = getSession(telegramId);
  if (existing) {
    db.prepare(
      `UPDATE sessions SET deployment_name = ?, claude_session_id = COALESCE(?, claude_session_id),
       status = 'running', updated_at = datetime('now') WHERE id = ?`,
    ).run(deploymentName, claudeSessionId ?? null, existing.id);
  } else {
    db.prepare(
      "INSERT INTO sessions (telegram_id, deployment_name, claude_session_id) VALUES (?, ?, ?)",
    ).run(telegramId, deploymentName, claudeSessionId ?? null);
  }
}

export function updateSessionStatus(
  telegramId: number,
  status: "running" | "stopped",
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, updated_at = datetime('now')
     WHERE telegram_id = ? AND id = (SELECT MAX(id) FROM sessions WHERE telegram_id = ?)`,
  ).run(status, telegramId, telegramId);
}

export function updateClaudeSessionId(
  telegramId: number,
  sessionId: string,
): void {
  db.prepare(
    `UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now')
     WHERE telegram_id = ? AND id = (SELECT MAX(id) FROM sessions WHERE telegram_id = ?)`,
  ).run(sessionId, telegramId, telegramId);
}
