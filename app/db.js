import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "./sqlite.js";

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(BASE_DIR, "data");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "kanban.db");

// Same DDL as the Python version (SQLModel/SQLAlchemy create_all), so a
// data/kanban.db can be swapped between the two implementations.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
	id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	path VARCHAR NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_project_path ON project (path);
CREATE TABLE IF NOT EXISTS ticket (
	id INTEGER NOT NULL,
	project_id INTEGER NOT NULL,
	title VARCHAR NOT NULL,
	status VARCHAR(11) NOT NULL,
	session_id VARCHAR,
	head_sha_at_start VARCHAR,
	commit_sha VARCHAR,
	commit_message VARCHAR,
	error_message VARCHAR,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX IF NOT EXISTS ix_ticket_project_id ON ticket (project_id);
CREATE INDEX IF NOT EXISTS ix_ticket_created_at ON ticket (created_at);
CREATE INDEX IF NOT EXISTS ix_ticket_status ON ticket (status);
CREATE TABLE IF NOT EXISTS ticketentry (
	id INTEGER NOT NULL,
	ticket_id INTEGER NOT NULL,
	kind VARCHAR(17) NOT NULL,
	author VARCHAR(5) NOT NULL,
	content VARCHAR NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(ticket_id) REFERENCES ticket (id)
);
CREATE INDEX IF NOT EXISTS ix_ticketentry_ticket_id ON ticketentry (ticket_id);
`;

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");

export function initDb() {
  db.exec(SCHEMA);
}

let lastNow = "";

/**
 * Naive UTC timestamp in SQLAlchemy's SQLite format ("YYYY-MM-DD HH:MM:SS.ffffff"),
 * the equivalent of Python's datetime.utcnow(). JS clocks only have millisecond
 * precision, so values are bumped by a microsecond when needed to stay strictly
 * increasing: entries are ordered by created_at.
 */
export function utcnow() {
  let value = new Date().toISOString().replace("T", " ").replace("Z", "") + "000";
  if (value <= lastNow) {
    const micros = Number(lastNow.slice(-6)) + 1;
    value = micros < 1_000_000 ? lastNow.slice(0, -6) + String(micros).padStart(6, "0") : value;
    if (value <= lastNow) value = lastNow;
  }
  lastNow = value;
  return value;
}

/** Runs fn inside a transaction, like a SQLAlchemy session commit. */
export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
