// Deterministic collections maths. Overdue status always comes from the due date
// and never from a webhook. The AI writes reminder text but doesn't pick the tier.

export type ReminderTier = "friendly" | "firm" | "final";

const DAY_MS = 86_400_000;

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return todayIso(new Date(date.getTime() + days * DAY_MS));
}

/** Days past due. Zero or negative means the invoice isn't overdue. */
export function daysOverdue(dueDate: string, today: string = todayIso()): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.round((now - due) / DAY_MS);
}

/** 1-7 days friendly, 8-21 firm, 22+ final notice. Not overdue returns null. */
export function tierForDays(days: number): ReminderTier | null {
  if (days < 1) return null;
  if (days <= 7) return "friendly";
  if (days <= 21) return "firm";
  return "final";
}

export type AgingBucket = "not_due" | "d1_7" | "d8_21" | "d22_45" | "d46_plus";

export const AGING_BUCKETS: { key: AgingBucket; label: string }[] = [
  { key: "not_due", label: "Not due" },
  { key: "d1_7", label: "1-7 days" },
  { key: "d8_21", label: "8-21 days" },
  { key: "d22_45", label: "22-45 days" },
  { key: "d46_plus", label: "46+ days" },
];

export function agingBucket(days: number): AgingBucket {
  if (days < 1) return "not_due";
  if (days <= 7) return "d1_7";
  if (days <= 21) return "d8_21";
  if (days <= 45) return "d22_45";
  return "d46_plus";
}
