// Creating and editing invoice drafts. Everything here only produces proposals:
// a draft can't leave Chaser until a human approves it (services/approvals.ts).
import { z } from "zod";
import { ALLOWED_CURRENCIES, getConfig } from "../config.js";
import { db } from "../db.js";
import { hasAtMostTwoDecimals, lineTotalCents, toCents } from "../money.js";
import { addDays, todayIso } from "../overdue.js";
import {
  createApproval,
  createInvoice,
  findOrCreateClient,
  getInvoice,
  logDecision,
  pendingApprovalForInvoice,
  replaceItems,
  sumItems,
  toView,
  updateInvoice,
  type Actor,
  type InvoiceView,
  type NewLineItem,
} from "../store.js";

export class DraftError extends Error {}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.");

const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().positive().max(100_000),
  unit_amount: z
    .number()
    .positive()
    .refine(hasAtMostTwoDecimals, "Amounts can have at most two decimal places."),
});

const currencySchema = z.enum(ALLOWED_CURRENCIES, {
  error: `Currency must be one of ${ALLOWED_CURRENCIES.join(", ")}.`,
});

/** Field rules, kept separate so a human edit can send only the fields that changed. */
export function draftFieldsSchema() {
  const { MAX_LINE_ITEMS } = getConfig();
  return z.object({
    client_name: z.string().trim().min(1).max(120),
    client_email: z.email().nullish(),
    currency: currencySchema,
    line_items: z
      .array(lineItemSchema)
      .min(1, "At least one line item with an amount is required.")
      .max(MAX_LINE_ITEMS, `An invoice can have at most ${MAX_LINE_ITEMS} line items.`),
    payment_terms_days: z.number().int().min(0).max(365).nullish(),
    due_date: isoDate.nullish(),
    notes: z.string().max(1000).nullish(),
  });
}

/** Checks run on every draft, whoever wrote it. Limits come from config. */
export function draftSchema() {
  const { MAX_INVOICE_AMOUNT } = getConfig();
  return draftFieldsSchema().superRefine((draft, ctx) => {
    const total = sumItems(toLineItems(draft.line_items));
    if (total > toCents(MAX_INVOICE_AMOUNT)) {
      ctx.addIssue({ code: "custom", message: `The total can't be more than ${MAX_INVOICE_AMOUNT}.` });
    }
  });
}

export type DraftInput = z.infer<ReturnType<typeof draftSchema>>;

function toLineItems(items: DraftInput["line_items"]): NewLineItem[] {
  return items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unit_cents: toCents(item.unit_amount),
  }));
}

/** Every number written in the text, in cents. "$2,400", "2400.00" and "2.4k" all match. */
export function amountsInText(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?(\s?[kK]\b)?/g)) {
    const value = Number.parseFloat(match[0].replace(/[,\skK]/g, ""));
    if (!Number.isNaN(value)) found.add(toCents(match[1] ? value * 1000 : value));
  }
  return found;
}

/**
 * Stops the model inventing money. Each line's unit price or line total must appear
 * in what the user actually wrote. A miss goes back to the model, which has to ask.
 */
export function assertAmountsFromSource(items: DraftInput["line_items"], sourceText: string): void {
  const known = amountsInText(sourceText);
  for (const item of items) {
    const unit = toCents(item.unit_amount);
    if (!known.has(unit) && !known.has(lineTotalCents(item.quantity, unit))) {
      throw new DraftError(
        `The amount ${item.unit_amount} for "${item.description}" isn't in the user's text. Never invent amounts. Ask the user to confirm it.`,
      );
    }
  }
}

function resolveDates(
  draft: Pick<DraftInput, "payment_terms_days" | "due_date">,
  today: string,
): { due_date: string; terms_days: number | null; assumption?: string } {
  if (draft.payment_terms_days !== undefined && draft.payment_terms_days !== null) {
    return { due_date: addDays(today, draft.payment_terms_days), terms_days: draft.payment_terms_days };
  }
  if (draft.due_date) {
    if (draft.due_date < today) throw new DraftError(`The due date ${draft.due_date} is in the past.`);
    return { due_date: draft.due_date, terms_days: null };
  }
  return {
    due_date: addDays(today, 30),
    terms_days: 30,
    assumption: "No payment terms were given, so net 30 was used. Edit the draft if that's wrong.",
  };
}

function approvalPayload(invoice: InvoiceView) {
  return {
    number: invoice.number,
    client: invoice.client_name,
    total_cents: invoice.total_cents,
    currency: invoice.currency,
    due_date: invoice.due_date,
  };
}

/** Saves a draft and queues it for approval. Nothing is sent to PayPal here. */
export function proposeDraft(
  input: DraftInput,
  meta: { actor: Actor; reasoning: string; sourceText?: string; today?: string },
): { invoice: InvoiceView; approvalId: number; assumption?: string } {
  const today = meta.today ?? todayIso();
  const dates = resolveDates(input, today);
  return db().transaction(() => {
    const client = findOrCreateClient(input.client_name, input.client_email);
    const row = createInvoice({
      client_id: client.id,
      currency: input.currency,
      items: toLineItems(input.line_items),
      issue_date: today,
      due_date: dates.due_date,
      terms_days: dates.terms_days,
      notes: input.notes,
      source_text: meta.sourceText,
    });
    const invoice = toView(row, today);
    const approval = createApproval({
      type: "invoice_send",
      invoice_id: invoice.id,
      payload: approvalPayload(invoice),
    });
    logDecision({
      invoice_id: invoice.id,
      actor: meta.actor,
      action: "draft_created",
      reasoning: meta.reasoning,
      data: { total_cents: invoice.total_cents, currency: invoice.currency, assumption: dates.assumption },
    });
    return { invoice, approvalId: approval.id, assumption: dates.assumption };
  })();
}

/** Edits a draft waiting for approval and bumps its revision, so a stale Approve fails. */
export function updateDraft(
  invoiceId: number,
  changes: Partial<DraftInput>,
  meta: { actor: Actor; reasoning: string; today?: string },
): InvoiceView {
  const existing = getInvoice(invoiceId);
  if (!existing) throw new DraftError(`Invoice ${invoiceId} doesn't exist.`);
  if (existing.status !== "draft") {
    throw new DraftError(`Invoice ${existing.number} is ${existing.status}. Only drafts can be edited.`);
  }
  const today = meta.today ?? todayIso();
  const current = toView(existing, today);
  const merged = draftSchema().parse({
    client_name: changes.client_name ?? current.client_name,
    client_email: changes.client_email ?? current.client_email,
    currency: changes.currency ?? current.currency,
    line_items:
      changes.line_items ??
      current.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit_amount: item.unit_cents / 100,
      })),
    payment_terms_days: changes.payment_terms_days,
    due_date: changes.due_date,
    notes: changes.notes ?? current.notes,
  });

  return db().transaction(() => {
    const client = findOrCreateClient(merged.client_name, merged.client_email);
    const datesChanged = changes.payment_terms_days !== undefined || changes.due_date !== undefined;
    const dates = datesChanged ? resolveDates(merged, today) : current;
    updateInvoice(invoiceId, {
      client_id: client.id,
      currency: merged.currency,
      notes: merged.notes ?? null,
      due_date: dates.due_date,
      terms_days: datesChanged ? (dates as { terms_days: number | null }).terms_days : current.terms_days,
      revision: current.revision + 1,
    });
    replaceItems(invoiceId, toLineItems(merged.line_items));
    const updated = toView(getInvoice(invoiceId)!, today);
    const approval = pendingApprovalForInvoice(invoiceId);
    if (approval) {
      db()
        .prepare("UPDATE approvals SET payload = ? WHERE id = ?")
        .run(JSON.stringify(approvalPayload(updated)), approval.id);
    }
    logDecision({
      invoice_id: invoiceId,
      actor: meta.actor,
      action: "draft_updated",
      reasoning: meta.reasoning,
      data: { total_cents: updated.total_cents, revision: updated.revision },
    });
    return updated;
  })();
}
