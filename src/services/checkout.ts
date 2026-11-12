// The public /pay/:id flow used by buyers in orders mode.
import { PayPalApiError } from "../paypal/client.js";
import { beginCheckout } from "../payments/orders.js";
import { getInvoiceByPublicId, logDecision, toView, type InvoiceView } from "../store.js";
import { reconcileInvoice, settleOrder } from "./settlement.js";

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

function payableInvoice(publicId: string): InvoiceView {
  const row = getInvoiceByPublicId(publicId);
  if (!row) throw new CheckoutError("This payment link isn't valid.", 404);
  return toView(row);
}

/** What a buyer may see. Internal notes and the source text are left out on purpose. */
export function publicInvoice(publicId: string) {
  const invoice = payableInvoice(publicId);
  return {
    public_id: invoice.public_id,
    number: invoice.number,
    client_name: invoice.client_name,
    status: invoice.status,
    currency: invoice.currency,
    total_cents: invoice.total_cents,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    is_overdue: invoice.is_overdue,
    is_demo: Boolean(invoice.is_demo),
    provider: invoice.provider,
    items: invoice.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit_cents: item.unit_cents,
    })),
  };
}

export type CheckoutStart = { redirect: string };

/** Starts paying. Returns where to send the buyer's browser. */
export async function startCheckout(publicId: string): Promise<CheckoutStart> {
  const invoice = payableInvoice(publicId);
  const page = `/pay/${invoice.public_id}`;
  if (invoice.is_demo) {
    throw new CheckoutError("This is a demo invoice, so it can't be paid. Create one through the agent to try the real flow.");
  }
  if (invoice.status === "paid") return { redirect: `${page}/success` };
  if (invoice.status !== "sent") throw new CheckoutError(`This invoice is ${invoice.status} and can't be paid.`);
  if (invoice.provider === "invoicing") {
    if (!invoice.pay_url) throw new CheckoutError("PayPal didn't provide a payment link for this invoice.");
    return { redirect: invoice.pay_url };
  }

  const result = await beginCheckout(invoice);
  switch (result.kind) {
    case "redirect":
      return { redirect: result.url };
    case "already_approved": {
      const status = await settleOrder(invoice.id, "return_page");
      return { redirect: status?.state === "paid" ? `${page}/success` : `${page}/success?pending=1` };
    }
    case "already_paid":
      await reconcileInvoice(invoice.id, "return_page");
      return { redirect: `${page}/success` };
  }
}

/**
 * The buyer came back from PayPal. The order in the URL must be the one this invoice
 * issued, so a link can't be pointed at some other order. Returns a page to redirect to.
 */
export async function handleReturn(publicId: string, token: string | undefined): Promise<string> {
  const invoice = payableInvoice(publicId);
  const page = `/pay/${invoice.public_id}`;
  if (invoice.status === "paid") return `${page}/success`;
  if (!token || token !== invoice.paypal_order_id) {
    logDecision({
      invoice_id: invoice.id,
      actor: "system",
      action: "return_rejected",
      reasoning: "A buyer return link didn't match this invoice's order, so nothing was captured.",
    });
    return `${page}/error?reason=mismatch`;
  }
  try {
    const status = await settleOrder(invoice.id, "return_page");
    if (status?.state === "paid") {
      // A mismatched amount is captured but flagged, so check how the invoice ended up.
      const after = getInvoiceByPublicId(publicId);
      return after?.status === "paid" ? `${page}/success` : `${page}/error?reason=review`;
    }
    if (status?.state === "pending") return `${page}/success?pending=1`;
    return `${page}/error?reason=not_completed`;
  } catch (error) {
    logDecision({
      invoice_id: invoice.id,
      actor: "system",
      action: "capture_failed",
      reasoning: `Capture failed: ${error instanceof Error ? error.message : "unknown error"}`,
    });
    const declined =
      error instanceof PayPalApiError &&
      ["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "ORDER_NOT_APPROVED"].includes(error.issue ?? "");
    return `${page}/error?reason=${declined ? "declined" : "capture_failed"}`;
  }
}

/** The buyer pressed cancel on PayPal. The invoice stays open and they can try again. */
export function handleCancel(publicId: string): string {
  const invoice = payableInvoice(publicId);
  logDecision({
    invoice_id: invoice.id,
    actor: "system",
    action: "buyer_cancelled",
    reasoning: "The buyer cancelled on PayPal. The invoice is still open.",
  });
  return `/pay/${invoice.public_id}/cancelled`;
}
