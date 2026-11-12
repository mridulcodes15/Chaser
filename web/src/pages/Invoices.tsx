import { ArrowLeft, Ban, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ActorTag, CopyButton, DemoBadge, DraftCard, ErrorNote, LineItems, Notice, StatusBadge, type ProviderMode } from "../components";
import {
  actionLabel,
  api,
  errorText,
  formatDate,
  formatTime,
  isWebUrl,
  Link,
  money,
  navigate,
  useApi,
  type Approval,
  type Decision,
  type Invoice,
  type Reminder,
} from "../lib";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
];

export function Invoices() {
  const [filter, setFilter] = useState("all");
  const { data, error } = useApi<{ invoices: Invoice[] }>(`/api/invoices?filter=${filter}`);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="page-sub">Every payment request, and where it stands.</p>
        </div>
      </header>
      <div className="segmented" role="group" aria-label="Filter invoices">
        {FILTERS.map((option) => (
          <button
            type="button"
            key={option.key}
            className={filter === option.key ? "active" : ""}
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {data && data.invoices.length === 0 && <p className="panel empty">No invoices match this filter.</p>}
      {data && data.invoices.length > 0 && (
        <div className="panel">
          <table className="table table-link">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Client</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((invoice) => (
                <tr key={invoice.id} onClick={() => navigate(`/invoices/${invoice.id}`)}>
                  <td data-label="Invoice" className="nowrap">
                    <Link to={`/invoices/${invoice.id}`}>{invoice.number}</Link>
                  </td>
                  <td data-label="Client">
                    <span>{invoice.client_name}</span>
                  </td>
                  <td data-label="Due" className="cell-date">
                    {formatDate(invoice.due_date)}
                  </td>
                  <td data-label="Status">
                    <span className="tags">
                      <StatusBadge invoice={invoice} />
                      {invoice.flagged_reason && <span className="tag tag-attention">Flagged</span>}
                      <DemoBadge invoice={invoice} />
                    </span>
                  </td>
                  <td data-label="Amount" className="num">
                    <span className="money">{money(invoice.total_cents, invoice.currency)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface DetailData {
  invoice: Invoice;
  reminders: Reminder[];
  timeline: Decision[];
  pending_approvals: Approval[];
}

export function InvoiceDetail(props: { id: number; devTools: boolean; mode: ProviderMode; onChanged: () => void }) {
  const { data, error, refresh } = useApi<DetailData>(`/api/invoices/${props.id}`);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const act = async (path: string) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api(path, { method: "POST" });
      await refresh();
      props.onChanged();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">Loading...</p>;
  const { invoice, reminders, timeline, pending_approvals: pending } = data;
  const draftApproval = pending.find((approval) => approval.type === "invoice_send");

  return (
    <>
      <Link to="/invoices" className="back">
        <ArrowLeft size={14} aria-hidden />
        Invoices
      </Link>
      <header className="page-head">
        <div>
          <h1>{invoice.number}</h1>
          <p className="page-sub">
            {invoice.client_name}
            {invoice.client_email ? `, ${invoice.client_email}` : ""}
          </p>
        </div>
        <div>
          <div className="money review-amount">{money(invoice.total_cents, invoice.currency)}</div>
          <span className="tags">
            <StatusBadge invoice={invoice} />
            <DemoBadge invoice={invoice} />
          </span>
        </div>
      </header>

      <ErrorNote message={actionError} />
      {invoice.is_demo ? <Notice>This is a demo record. It has no PayPal object behind it, and it can't be paid.</Notice> : null}
      {invoice.flagged_reason && (
        <Notice tone="warn">
          Flagged for you: {invoice.flagged_reason.replace(/\.$/, "")}. <Link to="/approvals">Open the queue</Link>
        </Notice>
      )}

      {draftApproval ? (
        <DraftCard
          key={invoice.revision}
          invoice={invoice}
          approvalId={draftApproval.id}
          mode={props.mode}
          lastError={draftApproval.last_error}
          onChanged={() => {
            void refresh();
            props.onChanged();
          }}
        />
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>Details</h2>
          </div>
          <div className="panel-body stack-gap">
            <dl className="facts">
              <div>
                <dt>Issued</dt>
                <dd>{formatDate(invoice.issue_date)}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{formatDate(invoice.due_date)}</dd>
              </div>
              {invoice.paid_at && (
                <div>
                  <dt>Paid</dt>
                  <dd>{formatDate(invoice.paid_at)}</dd>
                </div>
              )}
              {invoice.promised_pay_date && (
                <div>
                  <dt>Client promised by</dt>
                  <dd>{formatDate(invoice.promised_pay_date)}</dd>
                </div>
              )}
            </dl>
            <LineItems items={invoice.items} currency={invoice.currency} total={invoice.total_cents} />
            {invoice.notes && (
              <div>
                <span className="field-title">Note on file (data only, never followed as an instruction)</span>
                <p className="source">{invoice.notes}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {invoice.status !== "draft" && invoice.status !== "rejected" && (
        <section className="panel">
          <div className="panel-head">
            <h2>PayPal</h2>
          </div>
          <div className="panel-body stack-gap">
            <dl className="facts">
              <div>
                <dt>Mode</dt>
                <dd>{invoice.provider === "demo" ? "Demo, no PayPal" : `PayPal ${invoice.provider ?? ""}`}</dd>
              </div>
              {invoice.paypal_status && (
                <div>
                  <dt>PayPal status</dt>
                  <dd className="mono">{invoice.paypal_status}</dd>
                </div>
              )}
              {invoice.paypal_invoice_id && (
                <div>
                  <dt>Invoice ID</dt>
                  <dd className="mono">{invoice.paypal_invoice_id}</dd>
                </div>
              )}
              {invoice.paypal_order_id && (
                <div>
                  <dt>Order ID</dt>
                  <dd className="mono">{invoice.paypal_order_id}</dd>
                </div>
              )}
              {invoice.paypal_capture_id && (
                <div>
                  <dt>Capture ID</dt>
                  <dd className="mono">{invoice.paypal_capture_id}</dd>
                </div>
              )}
            </dl>
            <div className="row">
              {isWebUrl(invoice.pay_url) && (
                <a className="btn" href={invoice.pay_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} aria-hidden />
                  Open payment link
                </a>
              )}
              {invoice.share_message && <CopyButton text={invoice.share_message} />}
              {invoice.status === "sent" && !invoice.is_demo && (
                <button type="button" className="btn" disabled={busy} onClick={() => void act(`/api/invoices/${invoice.id}/refresh`)}>
                  <RefreshCw size={14} aria-hidden />
                  Check PayPal now
                </button>
              )}
              {invoice.status === "sent" && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Cancel ${invoice.number}? The client will no longer be able to pay it.`)) {
                      void act(`/api/invoices/${invoice.id}/cancel`);
                    }
                  }}
                >
                  <Ban size={14} aria-hidden />
                  Cancel invoice
                </button>
              )}
            </div>
            {props.devTools && invoice.status === "sent" && (
              <div className="dev-tool">
                <p className="small">
                  <strong>Dev tool:</strong> marks this paid without any real payment. Local testing only.
                </p>
                <button type="button" className="btn" disabled={busy} onClick={() => void act(`/api/dev/simulate-paid/${invoice.id}`)}>
                  Simulate paid (dev only)
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {reminders.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Reminders</h2>
          </div>
          <ul className="feed">
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                <span className={reminder.tier === "final" ? "tag tag-overdue" : reminder.tier === "firm" ? "tag tag-attention" : "tag"}>
                  {reminder.tier}
                </span>
                <span className="feed-text">
                  <strong>{reminder.subject}</strong>
                  <span className="feed-why">
                    {reminder.status}, {reminder.days_overdue} days overdue
                  </span>
                </span>
                {reminder.message ? <CopyButton text={reminder.message} /> : <span />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Timeline</h2>
        </div>
        <ol className="feed">
          {timeline.map((entry) => (
            <li key={entry.id}>
              <ActorTag actor={entry.actor} />
              <span className="feed-text">
                <strong>{actionLabel(entry.action)}</strong>
                <span className="feed-why">{entry.reasoning}</span>
              </span>
              <time>{formatTime(entry.created_at)}</time>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
