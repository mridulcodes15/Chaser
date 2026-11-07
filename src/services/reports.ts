import { db } from "../db.js";
import { AGING_BUCKETS, agingBucket, todayIso, type AgingBucket } from "../overdue.js";
import { listInvoices } from "../store.js";

export interface CurrencyTotals {
  currency: string;
  outstanding_cents: number;
  overdue_cents: number;
  paid_this_month_cents: number;
  open_count: number;
  overdue_count: number;
  paid_this_month_count: number;
  aging: { key: AgingBucket; label: string; cents: number; count: number }[];
}

/** Totals per currency. Amounts in different currencies are never added together. */
export function summarizeReceivables(today: string = todayIso()): CurrencyTotals[] {
  const month = today.slice(0, 7);
  const byCurrency = new Map<string, CurrencyTotals>();
  const totalsFor = (currency: string): CurrencyTotals => {
    let totals = byCurrency.get(currency);
    if (!totals) {
      totals = {
        currency,
        outstanding_cents: 0,
        overdue_cents: 0,
        paid_this_month_cents: 0,
        open_count: 0,
        overdue_count: 0,
        paid_this_month_count: 0,
        aging: AGING_BUCKETS.map((bucket) => ({ ...bucket, cents: 0, count: 0 })),
      };
      byCurrency.set(currency, totals);
    }
    return totals;
  };

  for (const invoice of listInvoices("all", today)) {
    if (invoice.status === "sent") {
      const totals = totalsFor(invoice.currency);
      totals.outstanding_cents += invoice.total_cents;
      totals.open_count++;
      if (invoice.is_overdue) {
        totals.overdue_cents += invoice.total_cents;
        totals.overdue_count++;
      }
      const bucket = totals.aging.find((b) => b.key === agingBucket(invoice.days_overdue))!;
      bucket.cents += invoice.total_cents;
      bucket.count++;
    } else if (invoice.status === "paid" && invoice.paid_at?.startsWith(month)) {
      const totals = totalsFor(invoice.currency);
      totals.paid_this_month_cents += invoice.total_cents;
      totals.paid_this_month_count++;
    }
  }
  return [...byCurrency.values()].sort((a, b) => b.outstanding_cents - a.outstanding_cents);
}

export function pendingApprovalCount(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as {
    n: number;
  };
  return row.n;
}
