import type { InvoiceView } from "../store.js";

export type ProviderName = "invoicing" | "orders";

export interface SendResult {
  payUrl: string | null;
  paypalInvoiceId?: string;
  paypalStatus?: string;
  /** PayPal's due date, when it computed one from the payment terms. */
  dueDate?: string;
}

/** A provider's status, normalised so the rest of the app needn't know which one it is. */
export interface ProviderStatus {
  state: "open" | "approved" | "pending" | "paid" | "cancelled" | "refunded";
  raw: string;
  captureId?: string;
  paidCents?: number;
  paidCurrency?: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  /** Only ever called from an approved approval. See services/approvals.ts. */
  send(invoice: InvoiceView): Promise<SendResult>;
  fetchStatus(invoice: InvoiceView): Promise<ProviderStatus>;
  sendReminder(invoice: InvoiceView): Promise<void>;
  cancel(invoice: InvoiceView): Promise<void>;
}
