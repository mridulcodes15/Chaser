// The only way anything leaves Chaser. Every action here starts from a human click
// on an approval endpoint. The agent has no route into this module.
import { getConfig } from "../config.js";
import { db } from "../db.js";
import { addDays, todayIso } from "../overdue.js";
import { getProviderState, providerByName } from "../payments/manager.js";
import type { SendResult } from "../payments/types.js";
import {
  getApproval,
  getInvoiceView,
  getReminder,
  logDecision,
  updateInvoice,
  type ApprovalRow,
  type InvoiceView,
} from "../store.js";
import { buildInvoiceMessage, buildReminderMessage } from "./messages.js";

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

function requirePending(approvalId: number, type?: ApprovalRow["type"]): ApprovalRow {
  const approval = getApproval(approvalId);
  if (!approval) throw new ApprovalError("That approval doesn't exist.", 404);
  if (type && approval.type !== type) throw new ApprovalError("Wrong approval type.");
  if (approval.status !== "pending") {
    throw new ApprovalError(`This approval has already been ${approval.status}.`);
  }
  return approval;
}

/** Atomically takes a pending approval, so a double click can only act once. */
function claim(approvalId: number): void {
  const result = db()
    .prepare(
      "UPDATE approvals SET status = 'approved', decided_at = datetime('now'), last_error = NULL WHERE id = ? AND status = 'pending'",
    )
    .run(approvalId);
  if (result.changes === 0) throw new ApprovalError("This approval has already been handled.");
}

function release(approvalId: number, error: string): void {
  db()
    .prepare("UPDATE approvals SET status = 'pending', decided_at = NULL, last_error = ? WHERE id = ?")
    .run(error, approvalId);
}

export interface SendOutcome {
  invoice: InvoiceView;
  message: string;
}

/**
 * Sends an invoice after a human approves it. `revision` must match what the human
 * was looking at: if the draft has changed since then, the approval is refused.
 */
export async function approveInvoiceSend(approvalId: number, revision: number): Promise<SendOutcome> {
  const approval = requirePending(approvalId, "invoice_send");
  const invoice = getInvoiceView(approval.invoice_id);
  if (!invoice) throw new ApprovalError("That invoice no longer exists.", 404);
  if (invoice.status !== "draft") throw new ApprovalError(`This invoice is already ${invoice.status}.`);
  if (invoice.revision !== revision) {
    throw new ApprovalError("This draft changed after you opened it. Review the new version and approve again.");
  }

  const state = await getProviderState();
  const provider = providerByName(state.mode);
  if (!invoice.is_demo && !provider) throw new ApprovalError(state.reason, 503);

  claim(approvalId);
  logDecision({
    invoice_id: invoice.id,
    actor: "human",
    action: "approved",
    reasoning: "A human approved sending this payment request.",
    data: { approval_id: approvalId, revision },
  });

  let result: SendResult;
  try {
    // Seeded demo invoices are local records and never touch PayPal.
    result = invoice.is_demo
      ? { payUrl: `${getConfig().publicBaseUrl}/pay/${invoice.public_id}` }
      : await provider!.send(invoice);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    release(approvalId, message);
    logDecision({
      invoice_id: invoice.id,
      actor: "system",
      action: "send_failed",
      reasoning: `The send failed, so the approval went back to the queue. ${message}`,
    });
    throw error;
  }

  // Terms run from the day it's actually sent, not the day it was drafted.
  const today = todayIso();
  const dueDate =
    result.dueDate ?? (invoice.terms_days !== null ? addDays(today, invoice.terms_days) : invoice.due_date);
  updateInvoice(invoice.id, {
    status: "sent",
    provider: invoice.is_demo ? "demo" : provider!.name,
    paypal_invoice_id: result.paypalInvoiceId ?? invoice.paypal_invoice_id,
    paypal_status: result.paypalStatus ?? null,
    pay_url: result.payUrl,
    issue_date: today,
    due_date: dueDate,
    sent_at: new Date().toISOString(),
  });
  const sent = getInvoiceView(invoice.id)!;
  const message = buildInvoiceMessage(sent);
  updateInvoice(invoice.id, { share_message: message });
  logDecision({
    invoice_id: invoice.id,
    actor: "system",
    action: "sent",
    reasoning: invoice.is_demo
      ? "Marked as sent. This is demo data, so PayPal wasn't called."
      : `Marked as sent using PayPal ${provider!.name}. A copyable message and link were created. No email was sent.`,
    data: { paypal_invoice_id: result.paypalInvoiceId, pay_url: result.payUrl },
  });
  return { invoice: getInvoiceView(invoice.id)!, message };
}

/** Approves a reminder, using the edited text if the human changed it. */
export async function approveReminder(approvalId: number): Promise<SendOutcome> {
  const approval = requirePending(approvalId, "reminder_send");
  const reminder = getReminder(approval.reminder_id!);
  const invoice = getInvoiceView(approval.invoice_id);
  if (!reminder || !invoice) throw new ApprovalError("That reminder no longer exists.", 404);
  if (invoice.status !== "sent") {
    throw new ApprovalError(`This invoice is ${invoice.status}, so it no longer needs a reminder.`);
  }

  claim(approvalId);
  const message = buildReminderMessage(invoice, reminder);
  db()
    .prepare("UPDATE reminders SET status = 'approved', message = ?, decided_at = datetime('now') WHERE id = ?")
    .run(message, reminder.id);
  logDecision({
    invoice_id: invoice.id,
    actor: "human",
    action: "reminder_approved",
    reasoning: `A human approved the ${reminder.tier} reminder. A copyable message was created.`,
    data: { reminder_id: reminder.id, tier: reminder.tier },
  });

  // Tell PayPal too where that applies. send_to_recipient stays false, so no email goes
  // out. A failure here must not hide the message the human needs to copy.
  const provider = invoice.is_demo ? undefined : providerByName(invoice.provider);
  if (provider) {
    try {
      await provider.sendReminder(invoice);
    } catch (error) {
      logDecision({
        invoice_id: invoice.id,
        actor: "system",
        action: "paypal_reminder_failed",
        reasoning: `PayPal didn't record the reminder, but the message is ready to copy. ${error instanceof Error ? error.message : ""}`,
      });
    }
  }
  return { invoice: getInvoiceView(invoice.id)!, message };
}

export function rejectApproval(approvalId: number, reason?: string): ApprovalRow {
  const approval = requirePending(approvalId);
  return db().transaction(() => {
    const result = db()
      .prepare("UPDATE approvals SET status = 'rejected', decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(approvalId);
    if (result.changes === 0) throw new ApprovalError("This approval has already been handled.");
    if (approval.type === "invoice_send") {
      updateInvoice(approval.invoice_id, { status: "rejected" });
    } else if (approval.reminder_id) {
      db()
        .prepare("UPDATE reminders SET status = 'rejected', decided_at = datetime('now') WHERE id = ?")
        .run(approval.reminder_id);
    }
    logDecision({
      invoice_id: approval.invoice_id,
      actor: "human",
      action: approval.type === "invoice_send" ? "draft_rejected" : "reminder_rejected",
      reasoning: reason?.trim() || "A human rejected this proposal.",
    });
    return getApproval(approvalId)!;
  })();
}

/** Saves a human's edits to a pending reminder. It still needs approving afterwards. */
export function editReminder(approvalId: number, subject: string, body: string): void {
  const approval = requirePending(approvalId, "reminder_send");
  db()
    .prepare("UPDATE reminders SET subject = ?, body = ? WHERE id = ?")
    .run(subject.trim(), body.trim(), approval.reminder_id);
  logDecision({
    invoice_id: approval.invoice_id,
    actor: "human",
    action: "reminder_edited",
    reasoning: "A human edited the reminder text before approving.",
  });
}

/** A human cancels a sent invoice. Also closes any reminders waiting for it. */
export async function cancelInvoice(invoiceId: number): Promise<InvoiceView> {
  const invoice = getInvoiceView(invoiceId);
  if (!invoice) throw new ApprovalError("That invoice doesn't exist.", 404);
  if (invoice.status !== "sent") throw new ApprovalError("Only a sent invoice can be cancelled.");
  const provider = invoice.is_demo ? undefined : providerByName(invoice.provider);
  await provider?.cancel(invoice);
  db().transaction(() => {
    updateInvoice(invoice.id, { status: "cancelled" });
    db()
      .prepare("UPDATE reminders SET status = 'rejected', decided_at = datetime('now') WHERE invoice_id = ? AND status = 'pending'")
      .run(invoice.id);
    db()
      .prepare("UPDATE approvals SET status = 'rejected', decided_at = datetime('now') WHERE invoice_id = ? AND status = 'pending'")
      .run(invoice.id);
    logDecision({
      invoice_id: invoice.id,
      actor: "human",
      action: "cancelled",
      reasoning: "A human cancelled this invoice.",
    });
  })();
  return getInvoiceView(invoice.id)!;
}

/** The human has reviewed a flag. Collections may draft a reminder again next run. */
export function clearFlag(invoiceId: number): InvoiceView {
  const invoice = getInvoiceView(invoiceId);
  if (!invoice) throw new ApprovalError("That invoice doesn't exist.", 404);
  updateInvoice(invoiceId, { flagged_reason: null, flagged_at: null, flag_overridden: 1 });
  logDecision({
    invoice_id: invoiceId,
    actor: "human",
    action: "flag_cleared",
    reasoning: "A human reviewed the flag and allowed reminders for this invoice.",
  });
  return getInvoiceView(invoiceId)!;
}
