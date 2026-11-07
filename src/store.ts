import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { lineTotalCents } from "./money.js";
import { daysOverdue, tierForDays, todayIso, type ReminderTier } from "./overdue.js";

export type InvoiceStatus = "draft" | "sent" | "paid" | "cancelled" | "rejected" | "refunded";
export type Actor = "agent" | "system" | "human";

export interface ClientRow {
  id: number;
  name: string;
  email: string | null;
  has_dispute: number;
  notes: string | null;
  created_at: string;
}

export interface InvoiceRow {
  id: number;
  public_id: string;
  number: string;
  client_id: number;
  status: InvoiceStatus;
  currency: string;
  total_cents: number;
  issue_date: string;
  due_date: string;
  terms_days: number | null;
  notes: string | null;
  source_text: string | null;
  revision: number;
  provider: string | null;
  paypal_invoice_id: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_status: string | null;
  pay_url: string | null;
  share_message: string | null;
  is_demo: number;
  promised_pay_date: string | null;
  flagged_reason: string | null;
  flagged_at: string | null;
  flag_overridden: number;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LineItemRow {
  id: number;
  invoice_id: number;
  description: string;
  quantity: number;
  unit_cents: number;
}

export interface InvoiceView extends InvoiceRow {
  client_name: string;
  client_email: string | null;
  client_has_dispute: number;
  items: LineItemRow[];
  days_overdue: number;
  is_overdue: boolean;
  tier: ReminderTier | null;
}

export interface ReminderRow {
  id: number;
  invoice_id: number;
  tier: ReminderTier;
  days_overdue: number;
  subject: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  message: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ApprovalRow {
  id: number;
  type: "invoice_send" | "reminder_send";
  status: "pending" | "approved" | "rejected";
  invoice_id: number;
  reminder_id: number | null;
  payload: string;
  last_error: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface DecisionRow {
  id: number;
  invoice_id: number | null;
  actor: Actor;
  action: string;
  reasoning: string;
  data: string | null;
  created_at: string;
}

export interface NewLineItem {
  description: string;
  quantity: number;
  unit_cents: number;
}

// --- Clients ---

export function findOrCreateClient(name: string, email?: string | null): ClientRow {
  const trimmed = name.trim();
  const existing = db()
    .prepare("SELECT * FROM clients WHERE name = ? COLLATE NOCASE")
    .get(trimmed) as ClientRow | undefined;
  if (existing) {
    // Fill in a missing email, but never replace one a human already has on file.
    if (email && !existing.email) {
      db().prepare("UPDATE clients SET email = ? WHERE id = ?").run(email, existing.id);
      existing.email = email;
    }
    return existing;
  }
  const info = db()
    .prepare("INSERT INTO clients (name, email) VALUES (?, ?)")
    .run(trimmed, email ?? null);
  return getClient(Number(info.lastInsertRowid))!;
}

export function getClient(id: number): ClientRow | undefined {
  return db().prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
}

// --- Invoices ---

export function sumItems(items: NewLineItem[]): number {
  return items.reduce((sum, item) => sum + lineTotalCents(item.quantity, item.unit_cents), 0);
}

export interface NewInvoice {
  client_id: number;
  currency: string;
  items: NewLineItem[];
  issue_date: string;
  due_date: string;
  terms_days?: number | null;
  notes?: string | null;
  source_text?: string | null;
  status?: InvoiceStatus;
  is_demo?: boolean;
  promised_pay_date?: string | null;
}

export function createInvoice(input: NewInvoice): InvoiceRow {
  return db().transaction(() => {
    const info = db()
      .prepare(
        `INSERT INTO invoices (public_id, client_id, status, currency, total_cents, issue_date,
           due_date, terms_days, notes, source_text, is_demo, promised_pay_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.client_id,
        input.status ?? "draft",
        input.currency,
        sumItems(input.items),
        input.issue_date,
        input.due_date,
        input.terms_days ?? null,
        input.notes ?? null,
        input.source_text ?? null,
        input.is_demo ? 1 : 0,
        input.promised_pay_date ?? null,
      );
    const id = Number(info.lastInsertRowid);
    const number = `CH-${input.issue_date.slice(0, 4)}-${String(id).padStart(4, "0")}`;
    db().prepare("UPDATE invoices SET number = ? WHERE id = ?").run(number, id);
    insertItems(id, input.items);
    return getInvoice(id)!;
  })();
}

function insertItems(invoiceId: number, items: NewLineItem[]): void {
  const insert = db().prepare(
    "INSERT INTO line_items (invoice_id, description, quantity, unit_cents) VALUES (?, ?, ?, ?)",
  );
  for (const item of items) insert.run(invoiceId, item.description, item.quantity, item.unit_cents);
}

export function replaceItems(invoiceId: number, items: NewLineItem[]): void {
  db().transaction(() => {
    db().prepare("DELETE FROM line_items WHERE invoice_id = ?").run(invoiceId);
    insertItems(invoiceId, items);
    db()
      .prepare("UPDATE invoices SET total_cents = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sumItems(items), invoiceId);
  })();
}

export function getInvoice(id: number): InvoiceRow | undefined {
  return db().prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
}

export function getInvoiceByPublicId(publicId: string): InvoiceRow | undefined {
  return db().prepare("SELECT * FROM invoices WHERE public_id = ?").get(publicId) as
    | InvoiceRow
    | undefined;
}

export function getInvoiceByOrderId(orderId: string): InvoiceRow | undefined {
  return db().prepare("SELECT * FROM invoices WHERE paypal_order_id = ?").get(orderId) as
    | InvoiceRow
    | undefined;
}

export function getInvoiceByPayPalInvoiceId(paypalInvoiceId: string): InvoiceRow | undefined {
  return db().prepare("SELECT * FROM invoices WHERE paypal_invoice_id = ?").get(paypalInvoiceId) as
    | InvoiceRow
    | undefined;
}

type InvoicePatch = Partial<Omit<InvoiceRow, "id" | "public_id" | "created_at" | "updated_at">>;

export function updateInvoice(id: number, patch: InvoicePatch): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  // Keys come from the InvoicePatch type in our own code, never from a request.
  const sets = keys.map((key) => `${key} = @${key}`).join(", ");
  db()
    .prepare(`UPDATE invoices SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
}

export function getItems(invoiceId: number): LineItemRow[] {
  return db()
    .prepare("SELECT * FROM line_items WHERE invoice_id = ? ORDER BY id")
    .all(invoiceId) as LineItemRow[];
}

export function toView(invoice: InvoiceRow, today: string = todayIso()): InvoiceView {
  const client = getClient(invoice.client_id)!;
  // Only an unpaid sent invoice can be overdue. A draft isn't owed yet.
  const days = invoice.status === "sent" ? daysOverdue(invoice.due_date, today) : 0;
  return {
    ...invoice,
    client_name: client.name,
    client_email: client.email,
    client_has_dispute: client.has_dispute,
    items: getItems(invoice.id),
    days_overdue: Math.max(days, 0),
    is_overdue: days >= 1,
    tier: tierForDays(days),
  };
}

export function getInvoiceView(id: number, today?: string): InvoiceView | undefined {
  const invoice = getInvoice(id);
  return invoice ? toView(invoice, today) : undefined;
}

export type InvoiceFilter = "draft" | "sent" | "overdue" | "paid" | "all";

export function listInvoices(filter: InvoiceFilter = "all", today?: string): InvoiceView[] {
  const rows = db().prepare("SELECT * FROM invoices ORDER BY id DESC").all() as InvoiceRow[];
  const views = rows.map((row) => toView(row, today));
  switch (filter) {
    case "all":
      return views;
    case "overdue":
      return views.filter((view) => view.is_overdue);
    default:
      return views.filter((view) => view.status === filter);
  }
}

// --- Reminders ---

export function getReminder(id: number): ReminderRow | undefined {
  return db().prepare("SELECT * FROM reminders WHERE id = ?").get(id) as ReminderRow | undefined;
}

export function remindersForInvoice(invoiceId: number): ReminderRow[] {
  return db()
    .prepare("SELECT * FROM reminders WHERE invoice_id = ? ORDER BY id")
    .all(invoiceId) as ReminderRow[];
}

export function hasReminderForTier(invoiceId: number, tier: ReminderTier): boolean {
  return Boolean(
    db().prepare("SELECT 1 FROM reminders WHERE invoice_id = ? AND tier = ?").get(invoiceId, tier),
  );
}

// --- Approvals ---

export function createApproval(input: {
  type: ApprovalRow["type"];
  invoice_id: number;
  reminder_id?: number | null;
  payload: unknown;
}): ApprovalRow {
  const info = db()
    .prepare("INSERT INTO approvals (type, invoice_id, reminder_id, payload) VALUES (?, ?, ?, ?)")
    .run(input.type, input.invoice_id, input.reminder_id ?? null, JSON.stringify(input.payload));
  return getApproval(Number(info.lastInsertRowid))!;
}

export function getApproval(id: number): ApprovalRow | undefined {
  return db().prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
}

export function pendingApprovalForInvoice(invoiceId: number): ApprovalRow | undefined {
  return db()
    .prepare(
      "SELECT * FROM approvals WHERE invoice_id = ? AND type = 'invoice_send' AND status = 'pending'",
    )
    .get(invoiceId) as ApprovalRow | undefined;
}

export function listApprovals(status: ApprovalRow["status"] = "pending"): ApprovalRow[] {
  return db()
    .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY id DESC")
    .all(status) as ApprovalRow[];
}

// --- Decision log ---

export function logDecision(input: {
  invoice_id?: number | null;
  actor: Actor;
  action: string;
  reasoning: string;
  data?: unknown;
}): void {
  db()
    .prepare(
      "INSERT INTO decision_log (invoice_id, actor, action, reasoning, data) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.invoice_id ?? null,
      input.actor,
      input.action,
      input.reasoning,
      input.data === undefined ? null : JSON.stringify(input.data),
    );
}

export function listDecisions(limit = 200): (DecisionRow & { invoice_number: string | null })[] {
  return db()
    .prepare(
      `SELECT d.*, i.number AS invoice_number FROM decision_log d
       LEFT JOIN invoices i ON i.id = d.invoice_id ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit) as (DecisionRow & { invoice_number: string | null })[];
}

export function decisionsForInvoice(invoiceId: number): DecisionRow[] {
  return db()
    .prepare("SELECT * FROM decision_log WHERE invoice_id = ? ORDER BY id")
    .all(invoiceId) as DecisionRow[];
}

// --- Settings ---

export function getSetting(key: string): string | undefined {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}
