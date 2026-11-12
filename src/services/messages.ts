// The copyable messages. Chaser doesn't send email or SMS: the user pastes these
// wherever they talk to the client. Amounts and links always come from our records.
import { formatMoney } from "../money.js";
import type { InvoiceView, ReminderRow } from "../store.js";

function payLine(invoice: InvoiceView): string {
  return invoice.pay_url
    ? `Pay securely with PayPal: ${invoice.pay_url}`
    : "The PayPal payment link is in your PayPal account.";
}

export function buildInvoiceMessage(invoice: InvoiceView): string {
  const lines = invoice.items.map((item) => `- ${item.description}`);
  return [
    `Hi ${invoice.client_name},`,
    "",
    `Here is payment request ${invoice.number} for ${formatMoney(invoice.total_cents, invoice.currency)}, due ${invoice.due_date}.`,
    "",
    ...lines,
    "",
    payLine(invoice),
    "",
    "Thank you!",
  ].join("\n");
}

export function buildReminderMessage(
  invoice: InvoiceView,
  reminder: Pick<ReminderRow, "subject" | "body">,
): string {
  return [`Subject: ${reminder.subject}`, "", reminder.body, "", payLine(invoice)].join("\n");
}
