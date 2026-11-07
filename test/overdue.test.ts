import { describe, expect, it } from "vitest";
import { addDays, agingBucket, daysOverdue, tierForDays } from "../src/overdue.js";
import { createInvoice, findOrCreateClient, listInvoices, toView } from "../src/store.js";

describe("overdue calculation", () => {
  it("counts whole days from the due date", () => {
    expect(daysOverdue("2026-11-01", "2026-11-08")).toBe(7);
    expect(daysOverdue("2026-11-08", "2026-11-08")).toBe(0);
    expect(daysOverdue("2026-11-10", "2026-11-08")).toBe(-2);
  });

  it("handles month and year boundaries", () => {
    expect(daysOverdue("2026-12-31", "2027-01-01")).toBe(1);
    expect(addDays("2026-12-20", 15)).toBe("2027-01-04");
  });
});

describe("tier selection", () => {
  it.each([
    [-5, null],
    [0, null],
    [1, "friendly"],
    [7, "friendly"],
    [8, "firm"],
    [21, "firm"],
    [22, "final"],
    [200, "final"],
  ])("%i days overdue gives %s", (days, tier) => {
    expect(tierForDays(days)).toBe(tier);
  });
});

describe("aging buckets", () => {
  it.each([
    [0, "not_due"],
    [7, "d1_7"],
    [8, "d8_21"],
    [22, "d22_45"],
    [46, "d46_plus"],
  ])("%i days lands in %s", (days, bucket) => {
    expect(agingBucket(days)).toBe(bucket);
  });
});

describe("invoice overdue state", () => {
  const make = (status: "draft" | "sent" | "paid") =>
    createInvoice({
      client_id: findOrCreateClient("Acme").id,
      currency: "USD",
      items: [{ description: "Work", quantity: 1, unit_cents: 10000 }],
      issue_date: "2026-10-01",
      due_date: "2026-10-15",
      status,
    });

  it("is computed from the due date for sent invoices", () => {
    const view = toView(make("sent"), "2026-10-20");
    expect(view.is_overdue).toBe(true);
    expect(view.days_overdue).toBe(5);
    expect(view.tier).toBe("friendly");
  });

  it("never applies to drafts or paid invoices", () => {
    expect(toView(make("draft"), "2026-12-01").is_overdue).toBe(false);
    expect(toView(make("paid"), "2026-12-01").is_overdue).toBe(false);
  });

  it("drives the overdue filter", () => {
    make("sent");
    make("paid");
    expect(listInvoices("overdue", "2026-10-20")).toHaveLength(1);
    expect(listInvoices("overdue", "2026-10-01")).toHaveLength(0);
  });
});
