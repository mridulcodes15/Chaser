// How payment news changes an invoice. The return page, webhooks, the reconciler and
// the dev tool all come through here, so the rules are the same and repeats are harmless.
import { db } from "../db.js";
import { formatMoney } from "../money.js";
import { captureOrder } from "../payments/orders.js";
import { providerByName } from "../payments/manager.js";
import type { ProviderStatus } from "../payments/types.js";
import { flagForHuman } from "./collections.js";
import { getInvoice, getInvoiceView, logDecision, updateInvoice } from "../store.js";

export type SettlementSource = "return_page" | "webhook" | "reconciler" | "dev_tool";

/** Rejects any reminders still waiting, so a paid client never gets chased. */
function closePendingReminders(invoiceId: number, why: string): void {
  db()
    .prepare(
      "UPDATE reminders SET status = 'rejected', decided_at = datetime('now') WHERE invoice_id = ? AND status = 'pending'",
    )
    .run(invoiceId);
  const closed = db()
    .prepare(
      "UPDATE approvals SET status = 'rejected', decided_at = datetime('now'), last_error = ? WHERE invoice_id = ? AND type = 'reminder_send' AND status = 'pending'",
    )
    .run(why, invoiceId);
  if (closed.changes > 0) {
    logDecision({
      invoice_id: invoiceId,
      actor: "system",
      action: "reminders_closed",
      reasoning: `${closed.changes} pending reminder(s) closed: ${why}.`,
    });
  }
}

/** Applies a provider status to an invoice. Returns the invoice's status afterwards. */
export function applyStatus(
  invoiceId: number,
  status: ProviderStatus,
  source: SettlementSource,
): string | undefined {
  const invoice = getInvoice(invoiceId);
  if (!invoice) return undefined;

  if (status.state === "paid") {
    // Never mark paid on a mismatch. A wrong amount goes to a human instead.
    const amountWrong = status.paidCents !== undefined && status.paidCents !== invoice.total_cents;
    const currencyWrong = status.paidCurrency !== undefined && status.paidCurrency !== invoice.currency;
    // Orders must prove the amount. Invoicing's status comes from the invoice itself.
    const amountMissing = invoice.provider === "orders" && status.paidCents === undefined;
    if (amountWrong || currencyWrong || amountMissing) {
      const received =
        status.paidCents !== undefined
          ? formatMoney(status.paidCents, status.paidCurrency ?? invoice.currency)
          : "an unknown amount";
      const reason = `PayPal reported ${received}, but the invoice is for ${formatMoney(invoice.total_cents, invoice.currency)}`;
      // The reconciler sees this every minute, so only flag and log it the first time.
      if (invoice.flagged_reason !== reason) {
        flagForHuman(invoice.id, reason, {
          actor: "system",
          reasoning: `Payment reported by ${source} doesn't match the invoice, so it wasn't marked paid.`,
        });
      }
      updateInvoice(invoice.id, { paypal_status: status.raw, paypal_capture_id: status.captureId ?? null });
      return invoice.status;
    }
    const changed = db()
      .prepare(
        `UPDATE invoices SET status = 'paid', paid_at = ?, paypal_status = ?,
           paypal_capture_id = COALESCE(?, paypal_capture_id), flagged_reason = NULL,
           updated_at = datetime('now') WHERE id = ? AND status = 'sent'`,
      )
      .run(new Date().toISOString(), status.raw, status.captureId ?? null, invoice.id);
    if (changed.changes > 0) {
      logDecision({
        invoice_id: invoice.id,
        actor: "system",
        action: "paid",
        reasoning: `Payment confirmed by ${source.replace("_", " ")}.`,
        data: { capture_id: status.captureId, paypal_status: status.raw },
      });
      closePendingReminders(invoice.id, "the invoice was paid");
    }
    return getInvoice(invoice.id)!.status;
  }

  if (status.state === "cancelled" || status.state === "refunded") {
    const from = status.state === "cancelled" ? "sent" : "paid";
    const changed = db()
      .prepare(
        "UPDATE invoices SET status = ?, paypal_status = ?, updated_at = datetime('now') WHERE id = ? AND status IN (?, 'sent')",
      )
      .run(status.state, status.raw, invoice.id, from);
    if (changed.changes > 0) {
      logDecision({
        invoice_id: invoice.id,
        actor: "system",
        action: status.state,
        reasoning: `PayPal reported this invoice as ${status.state} (via ${source.replace("_", " ")}).`,
      });
      closePendingReminders(invoice.id, `the invoice was ${status.state}`);
    }
    return getInvoice(invoice.id)!.status;
  }

  // open, approved or pending: no change of state, but keep the raw status visible.
  if (status.raw !== invoice.paypal_status) updateInvoice(invoice.id, { paypal_status: status.raw });
  return invoice.status;
}

/** Captures an approved order, if needed, and applies the result. */
export async function settleOrder(invoiceId: number, source: SettlementSource): Promise<ProviderStatus | undefined> {
  const invoice = getInvoice(invoiceId);
  if (!invoice?.paypal_order_id || invoice.status !== "sent") return undefined;
  const status = await captureOrder(invoice.paypal_order_id);
  applyStatus(invoice.id, status, source);
  return status;
}

/** Asks PayPal for an invoice's latest status. Used by the reconciler and webhooks. */
export async function reconcileInvoice(invoiceId: number, source: SettlementSource): Promise<void> {
  const view = getInvoiceView(invoiceId);
  if (!view || view.is_demo) return;
  const provider = providerByName(view.provider);
  if (!provider) return;
  const status = await provider.fetchStatus(view);
  // A buyer who approved but never came back shouldn't stay unpaid forever.
  if (status.state === "approved" && view.provider === "orders") {
    await settleOrder(view.id, source);
    return;
  }
  applyStatus(view.id, status, source);
}
