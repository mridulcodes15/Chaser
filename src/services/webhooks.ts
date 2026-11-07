// POST /api/webhooks/paypal. Nothing in an event is acted on until PayPal's
// verify-webhook-signature API confirms it, and repeated events are ignored.
import { getConfig } from "../config.js";
import { db } from "../db.js";
import { payPalToCents } from "../money.js";
import { paypalRequest } from "../paypal/client.js";
import {
  getInvoiceByOrderId,
  getInvoiceByPayPalInvoiceId,
  getInvoiceByPublicId,
  logDecision,
  type InvoiceRow,
} from "../store.js";
import { applyStatus, reconcileInvoice, settleOrder } from "./settlement.js";

type Headers = Record<string, string | string[] | undefined>;

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function verifySignature(headers: Headers, rawBody: string): Promise<boolean> {
  const { PAYPAL_WEBHOOK_ID } = getConfig();
  const fields = {
    auth_algo: header(headers, "paypal-auth-algo"),
    cert_url: header(headers, "paypal-cert-url"),
    transmission_id: header(headers, "paypal-transmission-id"),
    transmission_sig: header(headers, "paypal-transmission-sig"),
    transmission_time: header(headers, "paypal-transmission-time"),
  };
  if (!PAYPAL_WEBHOOK_ID || Object.values(fields).some((value) => !value)) return false;

  // PayPal says the event must go back exactly as received, because re-serialising it
  // can fail verification. So the raw text is spliced in, not parsed and re-encoded.
  const prefix = JSON.stringify({ ...fields, webhook_id: PAYPAL_WEBHOOK_ID }).slice(0, -1);
  const result = await paypalRequest<{ verification_status?: string }>({
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    rawBody: `${prefix},"webhook_event":${rawBody}}`,
    step: "Verify webhook signature",
  });
  return result?.verification_status === "SUCCESS";
}

interface WebhookEvent {
  id: string;
  event_type: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    invoice?: { id?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
}

function invoiceForCapture(event: WebhookEvent): InvoiceRow | undefined {
  const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  const byOrder = orderId ? getInvoiceByOrderId(orderId) : undefined;
  if (byOrder) return byOrder;
  const customId = event.resource?.custom_id;
  return customId ? getInvoiceByPublicId(customId) : undefined;
}

async function processEvent(event: WebhookEvent): Promise<void> {
  const type = event.event_type;

  if (type.startsWith("INVOICING.INVOICE.")) {
    // PayPal's docs don't show this payload, so both locations are checked. The state
    // itself is always re-read from PayPal rather than taken from the event.
    const paypalId = event.resource?.invoice?.id ?? event.resource?.id;
    const invoice = paypalId ? getInvoiceByPayPalInvoiceId(paypalId) : undefined;
    if (invoice) await reconcileInvoice(invoice.id, "webhook");
    return;
  }

  if (type === "CHECKOUT.ORDER.APPROVED") {
    const invoice = event.resource?.id ? getInvoiceByOrderId(event.resource.id) : undefined;
    if (invoice) await settleOrder(invoice.id, "webhook");
    return;
  }

  if (type.startsWith("PAYMENT.CAPTURE.")) {
    const invoice = invoiceForCapture(event);
    if (!invoice) return;
    const raw = `CAPTURE_${event.resource?.status ?? type.split(".").pop()}`;
    const amount = event.resource?.amount;
    switch (type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        applyStatus(
          invoice.id,
          {
            state: "paid",
            raw,
            captureId: event.resource?.id,
            paidCents: amount?.value ? payPalToCents(amount.value) : undefined,
            paidCurrency: amount?.currency_code,
          },
          "webhook",
        );
        return;
      case "PAYMENT.CAPTURE.PENDING":
        applyStatus(invoice.id, { state: "pending", raw }, "webhook");
        return;
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED":
        applyStatus(invoice.id, { state: "open", raw }, "webhook");
        logDecision({
          invoice_id: invoice.id,
          actor: "system",
          action: "payment_declined",
          reasoning: `PayPal reported ${type}. The invoice stays open.`,
        });
        return;
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED":
        applyStatus(invoice.id, { state: "refunded", raw }, "webhook");
        return;
    }
  }
}

export interface WebhookResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string };
}

export async function handleWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
  if (!getConfig().PAYPAL_WEBHOOK_ID) {
    // Never process an event we can't verify. PayPal will retry for up to 3 days.
    return { status: 503, body: { ok: false, error: "PAYPAL_WEBHOOK_ID isn't configured." } };
  }
  if (!(await verifySignature(headers, rawBody))) {
    return { status: 400, body: { ok: false, error: "Signature verification failed." } };
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return { status: 400, body: { ok: false, error: "The event isn't valid JSON." } };
  }
  if (!event.id || !event.event_type) {
    return { status: 400, body: { ok: false, error: "The event has no id or event_type." } };
  }

  db()
    .prepare("INSERT INTO events (event_id, event_type) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .run(event.id, event.event_type);
  const stored = db().prepare("SELECT processed_at FROM events WHERE event_id = ?").get(event.id) as {
    processed_at: string | null;
  };
  if (stored.processed_at) return { status: 200, body: { ok: true, duplicate: true } };

  // If this throws, processed_at stays empty and the non-2xx makes PayPal retry.
  await processEvent(event);
  db().prepare("UPDATE events SET processed_at = datetime('now') WHERE event_id = ?").run(event.id);
  return { status: 200, body: { ok: true } };
}
