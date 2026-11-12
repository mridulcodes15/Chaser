import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";

/**
 * The name buyers see on the payment page. It matches the brand name Chaser sends to
 * PayPal at checkout. Set VITE_MERCHANT_NAME in the shell when building to change it.
 */
export const MERCHANT_NAME: string = import.meta.env.VITE_MERCHANT_NAME || "Chaser";

// --- API ---

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const res = await fetch(path, {
    method,
    // The server only accepts JSON on writes, which blocks cross-site form posts.
    headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    const debugId = data?.paypal?.debug_id as string | undefined;
    throw new ApiError(data?.error ?? `Request failed (HTTP ${res.status}).`, res.status, debugId);
  }
  return data as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.debugId ? `${error.message} (PayPal debug ID ${error.debugId})` : error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Fetches on mount and whenever refresh() is called. */
export function useApi<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, [path]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, refresh };
}

// --- Routing ---

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function Link(props: { to: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(props.to);
  };
  return (
    <a href={props.to} className={props.className} onClick={onClick}>
      {props.children}
    </a>
  );
}

// --- Formatting ---

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

export function money(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}

export function moneyShort(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** SQLite timestamps are UTC with no zone marker. */
export function formatTime(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Only web links are ever made clickable. */
export function isWebUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// --- Shared types ---

export interface LineItem {
  id: number;
  description: string;
  quantity: number;
  unit_cents: number;
}

export interface Invoice {
  id: number;
  public_id: string;
  number: string;
  status: "draft" | "sent" | "paid" | "cancelled" | "rejected" | "refunded";
  currency: string;
  total_cents: number;
  issue_date: string;
  due_date: string;
  terms_days: number | null;
  notes: string | null;
  source_text: string | null;
  revision: number;
  provider: string | null;
  paypal_invoice_id: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_status: string | null;
  pay_url: string | null;
  share_message: string | null;
  is_demo: number;
  flagged_reason: string | null;
  promised_pay_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  client_name: string;
  client_email: string | null;
  items: LineItem[];
  days_overdue: number;
  is_overdue: boolean;
  tier: "friendly" | "firm" | "final" | null;
}

export interface Reminder {
  id: number;
  tier: "friendly" | "firm" | "final";
  days_overdue: number;
  subject: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  message: string | null;
  created_at: string;
}

export interface Approval {
  id: number;
  type: "invoice_send" | "reminder_send";
  status: string;
  last_error: string | null;
  created_at: string;
  invoice: Invoice;
  reminder?: Reminder;
}

export interface Decision {
  id: number;
  invoice_id: number | null;
  invoice_number?: string | null;
  actor: "agent" | "system" | "human";
  action: string;
  reasoning: string;
  created_at: string;
}

export interface Status {
  provider: { mode: "invoicing" | "orders" | "none"; requested: string; reason: string };
  llm_configured: boolean;
  webhook_configured: boolean;
  dev_tools: boolean;
  pending_approvals: number;
}

export const ACTION_LABELS: Record<string, string> = {
  draft_created: "Draft created",
  draft_updated: "Draft updated",
  draft_rejected: "Draft rejected",
  approved: "Approved",
  sent: "Sent",
  send_failed: "Send failed",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
  reminder_drafted: "Reminder drafted",
  reminder_edited: "Reminder edited",
  reminder_approved: "Reminder approved",
  reminder_rejected: "Reminder rejected",
  reminders_closed: "Reminders closed",
  flagged_for_human: "Flagged for you",
  flag_cleared: "Flag cleared",
  collections_check: "Collections check",
  tool_refused: "Tool refused",
  capture_failed: "Capture failed",
  buyer_cancelled: "Buyer cancelled",
  payment_declined: "Payment declined",
  return_rejected: "Return link rejected",
  paypal_reminder_failed: "PayPal reminder failed",
  demo_seeded: "Demo data",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}
