// PayPal Orders API v2. Each invoice is our own record, paid through the public
// /pay/:id page. An invoice has at most one live order, so a buyer who clicks
// "Pay" twice can't end up paying twice.
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { centsToPayPal, lineTotalCents, payPalToCents } from "../money.js";
import { PayPalApiError, paypalRequest } from "../paypal/client.js";
import { updateInvoice, type InvoiceView } from "../store.js";
import type { PaymentProvider, ProviderStatus, SendResult } from "./types.js";

const BASE = "/v2/checkout/orders";

interface PayPalCapture {
  id?: string;
  status?: string;
  amount?: { currency_code?: string; value?: string };
}

interface PayPalOrder {
  id?: string;
  status?: string;
  links?: { href?: string; rel?: string }[];
  purchase_units?: { payments?: { captures?: PayPalCapture[] } }[];
}

export function buildOrderBody(invoice: InvoiceView): unknown {
  const { publicBaseUrl } = getConfig();
  const base = `${publicBaseUrl}/api/pay/${invoice.public_id}`;
  const money = (cents: number) => ({
    currency_code: invoice.currency,
    value: centsToPayPal(cents),
  });
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        // PayPal requires invoice_id to be unique per merchant by default, and the
        // SQLite file resets on some hosts, so numbers could repeat. custom_id has
        // no such rule.
        custom_id: invoice.public_id,
        description: `Invoice ${invoice.number}`.slice(0, 127),
        amount: {
          ...money(invoice.total_cents),
          breakdown: { item_total: money(invoice.total_cents) },
        },
        items: invoice.items.map((item) => {
          // Orders only allows whole quantities, so 2.5 hours becomes one line for the full amount.
          const whole = Number.isInteger(item.quantity);
          return {
            name: (whole ? item.description : `${item.description} (x${item.quantity})`).slice(0, 127),
            quantity: whole ? String(item.quantity) : "1",
            unit_amount: money(
              whole ? item.unit_cents : lineTotalCents(item.quantity, item.unit_cents),
            ),
          };
        }),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: `${base}/return`,
          cancel_url: `${base}/cancel`,
          brand_name: "Chaser",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };
}

function buyerLink(order: PayPalOrder): string | undefined {
  // Sending payment_source returns payer-action. The standard flow returns approve.
  return order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
}

export function statusFromOrder(order: PayPalOrder): ProviderStatus {
  const raw = order.status ?? "UNKNOWN";
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture) {
    const details = {
      captureId: capture.id,
      paidCents: capture.amount?.value ? payPalToCents(capture.amount.value) : undefined,
      paidCurrency: capture.amount?.currency_code,
    };
    if (capture.status === "COMPLETED") return { state: "paid", raw, ...details };
    if (capture.status === "PENDING") return { state: "pending", raw, ...details };
    if (capture.status === "REFUNDED" || capture.status === "PARTIALLY_REFUNDED") {
      return { state: "refunded", raw, ...details };
    }
    return { state: "open", raw: `${raw}/${capture.status}`, ...details };
  }
  if (raw === "APPROVED") return { state: "approved", raw };
  if (raw === "VOIDED") return { state: "cancelled", raw };
  return { state: "open", raw };
}

async function getOrder(orderId: string): Promise<PayPalOrder> {
  return paypalRequest<PayPalOrder>({
    method: "GET",
    path: `${BASE}/${encodeURIComponent(orderId)}`,
    step: "Get PayPal order",
  });
}

export type CheckoutResult =
  | { kind: "redirect"; url: string }
  | { kind: "already_approved"; orderId: string }
  | { kind: "already_paid" };

/** Reuses the invoice's open order when there is one, otherwise creates one. */
export async function beginCheckout(invoice: InvoiceView): Promise<CheckoutResult> {
  if (invoice.paypal_order_id) {
    try {
      const existing = await getOrder(invoice.paypal_order_id);
      const status = statusFromOrder(existing);
      if (status.state === "paid" || status.state === "pending") return { kind: "already_paid" };
      if (status.state === "approved") {
        return { kind: "already_approved", orderId: invoice.paypal_order_id };
      }
      const link = buyerLink(existing);
      if (link) return { kind: "redirect", url: link };
    } catch (error) {
      // A 404 means the order is gone, so make a new one. Anything else could mean a
      // live order exists, and creating a second risks a double payment.
      if (!(error instanceof PayPalApiError && error.status === 404)) throw error;
    }
  }

  const order = await paypalRequest<PayPalOrder>({
    method: "POST",
    path: BASE,
    body: buildOrderBody(invoice),
    headers: {
      // PayPal requires this when a request includes payment_source.
      "PayPal-Request-Id": `chaser-order-${randomUUID()}`,
      Prefer: "return=representation",
    },
    step: "Create PayPal order",
  });
  const link = order.id ? buyerLink(order) : undefined;
  if (!order.id || !link) throw new Error("PayPal created an order but returned no buyer link.");
  updateInvoice(invoice.id, {
    paypal_order_id: order.id,
    paypal_status: order.status ?? null,
    provider: "orders",
  });
  return { kind: "redirect", url: link };
}

// Orders whose last capture PayPal definitely refused, with how many times.
const refusedCaptures = new Map<string, number>();

/**
 * Captures an approved order. The fixed request ID makes PayPal treat repeats as the
 * same capture, so the return page, webhook and reconciler can't charge twice.
 *
 * A 4xx means nothing was captured, and the buyer may fix it and retry, so the next
 * attempt gets a new ID: reusing the old one could replay the old failure. A 5xx or
 * timeout could mean it worked, so those keep the same ID.
 */
export async function captureOrder(orderId: string): Promise<ProviderStatus> {
  const refused = refusedCaptures.get(orderId) ?? 0;
  try {
    const order = await paypalRequest<PayPalOrder>({
      method: "POST",
      path: `${BASE}/${encodeURIComponent(orderId)}/capture`,
      body: {},
      headers: {
        "PayPal-Request-Id": `chaser-capture-${orderId}${refused ? `-${refused}` : ""}`,
        Prefer: "return=representation",
      },
      step: "Capture PayPal order",
    });
    refusedCaptures.delete(orderId);
    const status = statusFromOrder(order);
    // Only trust a capture result that includes the capture itself.
    return status.captureId ? status : statusFromOrder(await getOrder(orderId));
  } catch (error) {
    if (error instanceof PayPalApiError && error.issue === "ORDER_ALREADY_CAPTURED") {
      return statusFromOrder(await getOrder(orderId));
    }
    if (error instanceof PayPalApiError && error.status >= 400 && error.status < 500) {
      refusedCaptures.set(orderId, refused + 1);
    }
    throw error;
  }
}

export const ordersProvider: PaymentProvider = {
  name: "orders",

  async send(invoice): Promise<SendResult> {
    // Nothing is created at PayPal until the buyer clicks Pay on the public page.
    return { payUrl: `${getConfig().publicBaseUrl}/pay/${invoice.public_id}` };
  },

  async fetchStatus(invoice): Promise<ProviderStatus> {
    if (!invoice.paypal_order_id) return { state: "open", raw: "NO_ORDER_YET" };
    return statusFromOrder(await getOrder(invoice.paypal_order_id));
  },

  // The Orders API has no reminder concept. The copyable message is the reminder.
  async sendReminder(): Promise<void> {},

  // Clearing the order means the old buyer link can no longer be matched to the invoice.
  async cancel(invoice): Promise<void> {
    updateInvoice(invoice.id, { paypal_order_id: null });
  },
};
