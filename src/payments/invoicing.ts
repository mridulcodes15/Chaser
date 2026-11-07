// PayPal Invoicing API v2. Chaser never asks PayPal to email anyone:
// send_to_recipient is always false, and the user shares the link themselves.
import { centsToPayPal } from "../money.js";
import { paypalRequest } from "../paypal/client.js";
import { updateInvoice, type InvoiceView } from "../store.js";
import type { PaymentProvider, ProviderStatus, SendResult } from "./types.js";

const BASE = "/v2/invoicing/invoices";
const NET_TERMS = new Set([10, 15, 30, 45, 60, 90]);
const NO_NOTIFICATION = { send_to_recipient: false, send_to_invoicer: false };

interface PayPalInvoice {
  id?: string;
  href?: string;
  status?: string;
  detail?: {
    payment_term?: { due_date?: string };
    metadata?: { recipient_view_url?: string };
  };
}

export function buildInvoiceBody(invoice: InvoiceView): unknown {
  const paymentTerm =
    invoice.terms_days !== null && NET_TERMS.has(invoice.terms_days)
      ? { term_type: `NET_${invoice.terms_days}` }
      : { term_type: "DUE_ON_DATE_SPECIFIED", due_date: invoice.due_date };
  return {
    // invoice_date is left out so PayPal uses its own current date. A local date
    // can be ahead of PayPal's, and a future date would schedule the send.
    detail: {
      currency_code: invoice.currency,
      note: `Reference ${invoice.number}${invoice.notes ? `. ${invoice.notes}` : ""}`.slice(0, 4000),
      payment_term: paymentTerm,
    },
    ...(invoice.client_email
      ? { primary_recipients: [{ billing_info: { email_address: invoice.client_email } }] }
      : {}),
    items: invoice.items.map((item) => ({
      name: item.description.slice(0, 200),
      quantity: String(item.quantity),
      unit_amount: { currency_code: invoice.currency, value: centsToPayPal(item.unit_cents) },
    })),
  };
}

export async function createDraftInvoice(body: unknown): Promise<PayPalInvoice & { id: string }> {
  const data = await paypalRequest<PayPalInvoice>({
    method: "POST",
    path: BASE,
    body,
    headers: { Prefer: "return=representation" },
    step: "Create PayPal invoice",
  });
  // The docs only specify the body for return=representation, so also accept an href.
  const id = data?.id ?? data?.href?.split("/").pop();
  if (!id) throw new Error("PayPal created an invoice but returned no ID.");
  return { ...data, id };
}

export async function deleteDraftInvoice(id: string): Promise<void> {
  await paypalRequest({
    method: "DELETE",
    path: `${BASE}/${encodeURIComponent(id)}`,
    step: "Delete PayPal draft invoice",
  });
}

function getPayPalInvoice(id: string): Promise<PayPalInvoice> {
  return paypalRequest<PayPalInvoice>({
    method: "GET",
    path: `${BASE}/${encodeURIComponent(id)}`,
    step: "Get PayPal invoice",
  });
}

/**
 * PayPal's docs show status only by example, so this list can't be confirmed as
 * complete. Anything unrecognised stays "open": a status we don't know must never
 * mark money as received.
 */
export function mapInvoiceStatus(raw: string | undefined): ProviderStatus["state"] {
  switch (raw) {
    case "PAID":
    case "MARKED_AS_PAID":
      return "paid";
    case "PAYMENT_PENDING":
      return "pending";
    case "CANCELLED":
    case "AUTO_CANCELLED":
      return "cancelled";
    case "REFUNDED":
    case "MARKED_AS_REFUNDED":
      return "refunded";
    default:
      return "open";
  }
}

export const invoicingProvider: PaymentProvider = {
  name: "invoicing",

  async send(invoice): Promise<SendResult> {
    // The ID is saved straight after creating, so a retry can't create a duplicate.
    let id = invoice.paypal_invoice_id;
    if (!id) {
      const created = await createDraftInvoice(buildInvoiceBody(invoice));
      id = created.id;
      updateInvoice(invoice.id, { paypal_invoice_id: id, provider: "invoicing" });
    }
    const sendResponse = await paypalRequest<{ href?: string } | undefined>({
      method: "POST",
      path: `${BASE}/${encodeURIComponent(id)}/send`,
      body: NO_NOTIFICATION,
      step: "Send PayPal invoice",
    });
    const details = await getPayPalInvoice(id);
    return {
      payUrl: details.detail?.metadata?.recipient_view_url ?? sendResponse?.href ?? null,
      paypalInvoiceId: id,
      paypalStatus: details.status,
      dueDate: details.detail?.payment_term?.due_date,
    };
  },

  async fetchStatus(invoice): Promise<ProviderStatus> {
    if (!invoice.paypal_invoice_id) return { state: "open", raw: "NOT_CREATED" };
    const details = await getPayPalInvoice(invoice.paypal_invoice_id);
    return { state: mapInvoiceStatus(details.status), raw: details.status ?? "UNKNOWN" };
  },

  async sendReminder(invoice): Promise<void> {
    if (!invoice.paypal_invoice_id) return;
    await paypalRequest({
      method: "POST",
      path: `${BASE}/${encodeURIComponent(invoice.paypal_invoice_id)}/remind`,
      body: NO_NOTIFICATION,
      step: "Send PayPal reminder",
    });
  },

  async cancel(invoice): Promise<void> {
    if (!invoice.paypal_invoice_id) return;
    await paypalRequest({
      method: "POST",
      path: `${BASE}/${encodeURIComponent(invoice.paypal_invoice_id)}/cancel`,
      body: NO_NOTIFICATION,
      step: "Cancel PayPal invoice",
    });
  },
};
