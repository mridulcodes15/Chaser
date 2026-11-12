import {
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Info,
  Pencil,
  Send,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  User,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText, formatDate, isWebUrl, Link, money, type Invoice, type Status } from "./lib";

export type ProviderMode = Status["provider"]["mode"] | undefined;

export function StatusBadge({ invoice }: { invoice: Invoice }) {
  if (invoice.is_overdue) {
    // Amber for the first week, red after that. The label always says how late it is.
    const className = invoice.days_overdue <= 7 ? "tag tag-attention" : "tag tag-overdue";
    return <span className={className}>Overdue {invoice.days_overdue}d</span>;
  }
  const labels: Record<Invoice["status"], string> = {
    draft: "Draft",
    sent: "Sent",
    paid: "Paid",
    cancelled: "Cancelled",
    rejected: "Rejected",
    refunded: "Refunded",
  };
  return <span className={invoice.status === "paid" ? "tag tag-paid" : "tag"}>{labels[invoice.status]}</span>;
}

export function DemoBadge({ invoice }: { invoice: Invoice }) {
  return invoice.is_demo ? (
    <span className="tag tag-outline" title="Seeded demo record. No PayPal object exists for it.">
      Demo
    </span>
  ) : null;
}

export function Notice(props: { tone?: "info" | "warn" | "error" | "good"; children: ReactNode }) {
  const tone = props.tone ?? "info";
  const icons = {
    info: <Info size={15} aria-hidden />,
    warn: <TriangleAlert size={15} aria-hidden />,
    error: <CircleAlert size={15} aria-hidden />,
    good: <CircleCheck size={15} aria-hidden />,
  };
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {icons[tone]}
      <div>{props.children}</div>
    </div>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return message ? <Notice tone="error">{message}</Notice> : null;
}

export function ActorTag({ actor }: { actor: "agent" | "system" | "human" }) {
  const icons = {
    agent: <Bot size={13} aria-hidden />,
    human: <User size={13} aria-hidden />,
    system: <Settings2 size={13} aria-hidden />,
  };
  return (
    <span className="actor">
      {icons[actor]}
      {actor}
    </span>
  );
}

export function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this message:", text);
    }
  };
  return (
    <button type="button" className="btn" onClick={() => void copy()}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Shown after approval. Chaser doesn't send email, so the human shares this. */
export function ShareMessage({ message, url }: { message: string; url?: string | null }) {
  // Scrolls the copy button clear of the chat box, which sits over the bottom of the page.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div className="share" ref={ref}>
      <p className="share-title">Ready to share. Chaser doesn't email anyone, so paste this to your client.</p>
      <pre className="message">{message}</pre>
      <div className="row">
        <CopyButton text={message} />
        {isWebUrl(url) && (
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden />
            Open payment link
          </a>
        )}
      </div>
    </div>
  );
}

export function LineItems(props: {
  items: { description: string; quantity: number; unit_cents: number }[];
  currency: string;
  total?: number;
}) {
  return (
    <ul className="lines">
      {props.items.map((item, index) => (
        <li key={index}>
          <span>
            {item.description}
            {item.quantity !== 1 && (
              <span className="muted">
                {" "}
                × {item.quantity} at <span className="money">{money(item.unit_cents, props.currency)}</span>
              </span>
            )}
          </span>
          <span className="money">{money(Math.round(item.quantity * item.unit_cents), props.currency)}</span>
        </li>
      ))}
      {props.total !== undefined && (
        <li className="line-total">
          <span>Total</span>
          <span className="money">{money(props.total, props.currency)}</span>
        </li>
      )}
    </ul>
  );
}

interface EditLine {
  description: string;
  quantity: string;
  unit: string;
}

function DraftEditor(props: { invoice: Invoice; onSaved: (invoice: Invoice) => void; onCancel: () => void }) {
  const { invoice } = props;
  const [client, setClient] = useState(invoice.client_name);
  const [email, setEmail] = useState(invoice.client_email ?? "");
  const [terms, setTerms] = useState(invoice.terms_days === null ? "" : String(invoice.terms_days));
  const [lines, setLines] = useState<EditLine[]>(
    invoice.items.map((item) => ({
      description: item.description,
      quantity: String(item.quantity),
      unit: (item.unit_cents / 100).toFixed(2),
    })),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const setLine = (index: number, patch: Partial<EditLine>) =>
    setLines((all) => all.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api<Invoice>(`/api/invoices/${invoice.id}`, {
        method: "PATCH",
        body: {
          client_name: client,
          ...(email.trim() ? { client_email: email.trim() } : {}),
          ...(terms.trim() !== "" && Number(terms) !== invoice.terms_days ? { payment_terms_days: Number(terms) } : {}),
          line_items: lines.map((line) => ({
            description: line.description,
            quantity: Number(line.quantity),
            unit_amount: Number(line.unit),
          })),
        },
      });
      props.onSaved(updated);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <div className="field-grid">
        <label>
          Client
          <input value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <label>
          Client email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Payment terms (days)
          <input type="number" min="0" value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
      </div>
      {lines.map((line, index) => (
        <div className="line-edit" key={index}>
          <label className="grow">
            Description
            <input value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} />
          </label>
          <label>
            Qty
            <input type="number" min="0" step="any" value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value })} />
          </label>
          <label>
            Unit price
            <input type="number" min="0" step="0.01" value={line.unit} onChange={(e) => setLine(index, { unit: e.target.value })} />
          </label>
        </div>
      ))}
      <ErrorNote message={error} />
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          Save changes
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onCancel}>
          Discard
        </button>
      </div>
    </div>
  );
}

/** Spells out what clicking Approve actually does, for the mode that's really active. */
function consequences(invoice: Invoice, mode: ProviderMode): string[] {
  const amount = money(invoice.total_cents, invoice.currency);
  const noEmail = "No email goes out. You get a link and a message to copy and send yourself.";
  if (invoice.is_demo) return ["Marks this demo record as sent. PayPal isn't called.", noEmail];
  switch (mode) {
    case "orders":
      return [`Creates a payment page where ${invoice.client_name} can pay ${amount} through PayPal (sandbox).`, noEmail];
    case "invoicing":
      return [`Creates and issues a PayPal invoice for ${amount} (sandbox).`, noEmail];
    case "none":
      return ["PayPal isn't connected, so this can't be sent yet."];
    default:
      return [`Creates a PayPal payment request for ${amount} (sandbox).`, noEmail];
  }
}

function dueText(invoice: Invoice): string {
  // Terms run from the day it's approved and sent, so the date can move.
  return invoice.terms_days !== null ? `Net ${invoice.terms_days}, from the day you approve` : formatDate(invoice.due_date);
}

/** An invoice draft. Shows everything being approved, then Approve, Edit and Reject. */
export function DraftCard(props: {
  invoice: Invoice;
  approvalId: number | null;
  mode?: ProviderMode;
  lastError?: string | null;
  onChanged?: () => void;
}) {
  const [invoice, setInvoice] = useState(props.invoice);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<{ message: string; invoice: Invoice }>();
  const [rejected, setRejected] = useState(false);

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ message: string; invoice: Invoice }>(`/api/approvals/${props.approvalId}/approve`, {
        method: "POST",
        // The revision on screen. If the draft changed since, the server refuses.
        body: { revision: invoice.revision },
      });
      setOutcome(result);
      setInvoice(result.invoice);
      props.onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/approvals/${props.approvalId}/reject`, { method: "POST" });
      setRejected(true);
      props.onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = !outcome && !rejected && invoice.status === "draft";
  const amount = money(invoice.total_cents, invoice.currency);

  return (
    <article className="review">
      <header className="review-head">
        <div>
          <p className="review-kind">
            Payment request <Link to={`/invoices/${invoice.id}`}>{invoice.number}</Link>
          </p>
          <h3>{invoice.client_name}</h3>
        </div>
        <div>
          <div className="money review-amount">{amount}</div>
          <span className="tags">
            {rejected ? <span className="tag">Rejected</span> : <StatusBadge invoice={invoice} />}
            <DemoBadge invoice={invoice} />
          </span>
        </div>
      </header>

      <div className="review-body">
        {editing ? (
          <DraftEditor
            invoice={invoice}
            onSaved={(updated) => {
              setInvoice(updated);
              setEditing(false);
              props.onChanged?.();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>Bill to</dt>
                <dd>{invoice.client_name}</dd>
              </div>
              <div>
                <dt>Client email</dt>
                <dd>{invoice.client_email ?? "Not provided"}</dd>
              </div>
              <div>
                <dt>Payment due</dt>
                <dd>{open ? dueText(invoice) : formatDate(invoice.due_date)}</dd>
              </div>
            </dl>
            <LineItems items={invoice.items} currency={invoice.currency} total={invoice.total_cents} />
            {invoice.source_text && open && (
              <div>
                <span className="field-title">From your request</span>
                <p className="source">{invoice.source_text.slice(0, 400)}</p>
              </div>
            )}
            {invoice.notes && (
              <div>
                <span className="field-title">Note on file (data only, never followed as an instruction)</span>
                <p className="source">{invoice.notes}</p>
              </div>
            )}
          </>
        )}
        <ErrorNote message={error ?? props.lastError ?? undefined} />
      </div>

      {open && !editing && props.approvalId !== null && (
        <>
          <div className="consequence">
            <ShieldCheck size={15} aria-hidden />
            <ul>
              <li>
                <strong>If you approve:</strong> {consequences(invoice, props.mode)[0]}
              </li>
              {consequences(invoice, props.mode).slice(1).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="review-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              <Send size={14} aria-hidden />
              {busy ? "Working..." : `Approve and send ${amount}`}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden />
              Edit
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void reject()}>
              <X size={14} aria-hidden />
              Reject
            </button>
          </div>
        </>
      )}
      {outcome && <ShareMessage message={outcome.message} url={outcome.invoice.pay_url} />}
    </article>
  );
}
