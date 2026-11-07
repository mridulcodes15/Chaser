import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { reconcileAll } from "../src/jobs.js";
import { runCollections } from "../src/services/collections.js";
import { summarizeReceivables } from "../src/services/reports.js";
import { seedDemoData, seedIfEmpty } from "../src/seed.js";
import { createInvoice, findOrCreateClient, listApprovals, listInvoices } from "../src/store.js";
import { mockFetch } from "./helpers.js";

const TODAY = "2026-11-07";
const ROUTE = "POST /openai/v1/chat/completions";

function llmReply(call: { body: any }) {
  const record = JSON.parse(call.body.messages[1].content);
  return {
    json: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "draft",
              reasoning: `Tier ${record.tier}.`,
              subject: `Invoice ${record.invoice_number}`,
              body: `Hello, ${record.total} is ${record.days_overdue} days overdue. Regards, the billing team`,
            }),
          },
        },
      ],
    },
  };
}

describe("seed data", () => {
  it("covers every state, and every record is marked as demo", () => {
    seedDemoData(TODAY);
    const invoices = listInvoices("all", TODAY);
    expect(invoices.length).toBeGreaterThanOrEqual(10);
    expect(invoices.every((invoice) => invoice.is_demo === 1)).toBe(true);
    expect(invoices.every((invoice) => !invoice.paypal_invoice_id && !invoice.paypal_order_id)).toBe(true);

    const days = invoices.filter((invoice) => invoice.is_overdue).map((invoice) => invoice.days_overdue);
    expect(days).toEqual(expect.arrayContaining([7, 21, 42]));
    expect(invoices.some((invoice) => invoice.status === "paid")).toBe(true);
    expect(invoices.some((invoice) => invoice.status === "sent" && !invoice.is_overdue)).toBe(true);
    expect(invoices.filter((invoice) => invoice.status === "draft")).toHaveLength(1);
    const clients = db().prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number };
    expect(clients.n).toBeGreaterThanOrEqual(6);
    expect(clients.n).toBeLessThanOrEqual(8);
  });

  it("shows the expected dashboard totals", () => {
    seedDemoData(TODAY);
    const usd = summarizeReceivables(TODAY).find((totals) => totals.currency === "USD")!;
    expect(usd.overdue_count).toBe(7);
    expect(usd.paid_this_month_count).toBe(1);
    expect(usd.outstanding_cents).toBeGreaterThan(usd.overdue_cents);
    expect(usd.aging.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(usd.open_count);
  });

  it("works with collections: drafts the plain cases and flags the risky ones", async () => {
    const calls = mockFetch({ [ROUTE]: llmReply });
    seedDemoData(TODAY);
    const summary = await runCollections("manual", TODAY);
    expect(summary.failed).toBe(0);
    expect(summary.checked).toBe(7);
    expect(summary.flagged).toBe(3); // large amount, previous dispute, promise to pay
    expect(summary.drafted).toBe(4);
    expect(calls.every((call) => call.url.includes("groq.com"))).toBe(true);

    const flagged = listInvoices("all", TODAY).filter((invoice) => invoice.flagged_reason);
    expect(flagged.map((invoice) => invoice.client_name).sort()).toEqual([
      "Harbor & Pine Studio",
      "Lumen Robotics",
      "Quill Publishing",
    ]);
    // 4 reminders plus the seeded draft.
    expect(listApprovals("pending")).toHaveLength(5);
  });

  it("gives the reconciler nothing to ask PayPal about", async () => {
    const calls = mockFetch({});
    seedDemoData(TODAY);
    expect((await reconcileAll()).checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("re-seeding replaces demo records but keeps real ones", () => {
    const real = createInvoice({
      client_id: findOrCreateClient("Real Client").id,
      currency: "USD",
      items: [{ description: "Real work", quantity: 1, unit_cents: 1000 }],
      issue_date: TODAY,
      due_date: TODAY,
      status: "sent",
    });
    seedDemoData(TODAY);
    const first = listInvoices("all", TODAY).length;
    seedDemoData(TODAY);
    const all = listInvoices("all", TODAY);
    expect(all).toHaveLength(first);
    expect(all.some((invoice) => invoice.id === real.id)).toBe(true);
    expect(listApprovals("pending")).toHaveLength(1);
  });

  it("seeds on boot only when the database is empty", () => {
    expect(seedIfEmpty()).toBe(true);
    expect(seedIfEmpty()).toBe(false);
  });
});
