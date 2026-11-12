import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  has_dispute INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_name ON clients(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  number TEXT NOT NULL DEFAULT '',
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL CHECK (status IN ('draft','sent','paid','cancelled','rejected','refunded')),
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  terms_days INTEGER,
  notes TEXT,
  source_text TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  paypal_invoice_id TEXT,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_status TEXT,
  pay_url TEXT,
  share_message TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  promised_pay_date TEXT,
  flagged_reason TEXT,
  flagged_at TEXT,
  flag_overridden INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS invoices_order ON invoices(paypal_order_id);
CREATE INDEX IF NOT EXISTS invoices_ppinv ON invoices(paypal_invoice_id);

CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('friendly','firm','final')),
  days_overdue INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
-- The database itself refuses a second pending reminder for the same invoice and tier.
CREATE UNIQUE INDEX IF NOT EXISTS reminders_one_pending
  ON reminders(invoice_id, tier) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('invoice_send','reminder_send')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_log (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','system','human')),
  action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let instance: Database.Database | undefined;

export function initDb(path: string): Database.Database {
  instance?.close();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);
  instance = database;
  return database;
}

export function db(): Database.Database {
  if (!instance) throw new Error("Database not initialised. Call initDb first.");
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}
