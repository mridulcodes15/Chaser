import { Check, CircleAlert, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { DemoBadge, DraftCard, ErrorNote, ShareMessage, type ProviderMode } from "../components";
import { api, errorText, formatDate, Link, money, useApi, type Approval, type Invoice } from "../lib";

const TIER_LABELS = { friendly: "Friendly", firm: "Firm", final: "Final notice" };
const TIER_CLASSES = { friendly: "tag", firm: "tag tag-attention", final: "tag tag-overdue" };

function ReminderCard({ approval, onChanged }: { approval: Approval; onChanged: () => void }) {
  const { invoice, reminder } = approval;
  const [subject, setSubject] = useState(reminder!.subject);
  const [body, setBody] = useState(reminder!.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<{ message: string; invoice: Invoice }>();
  const [rejected, setRejected] = useState(false);
  const edited = subject !== reminder!.subject || body !== reminder!.body;
  const amount = money(invoice.total_cents, invoice.currency);

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // Save any edits first, so what gets approved is exactly what's on screen.
      if (edited) {
        await api(`/api/approvals/${approval.id}`, { method: "PATCH", body: { subject, body } });
      }
      setOutcome(await api(`/api/approvals/${approval.id}/approve`, { method: "POST" }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await api(`/api/approvals/${approval.id}/reject`, { method: "POST" });
      setRejected(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="review">
      <header className="review-head">
        <div>
          <p className="review-kind">
            Reminder for <Link to={`/invoices/${invoice.id}`}>{invoice.number}</Link>
          </p>
          <h3>{invoice.client_name}</h3>
        </div>
        <div>
          <div className="money review-amount">{amount}</div>
          <span className="tags">
            <span className={TIER_CLASSES[reminder!.tier]}>{TIER_LABELS[reminder!.tier]}</span>
            <DemoBadge invoice={invoice} />
          </span>
        </div>
      </header>

      {outcome ? (
        <ShareMessage message={outcome.message} url={outcome.invoice.pay_url} />
      ) : rejected ? (
        <div className="review-body muted">Rejected. Nothing was sent.</div>
      ) : (
        <>
          <div className="review-body">
            <dl className="facts">
              <div>
                <dt>Remind</dt>
                <dd>{invoice.client_name}</dd>
              </div>
              <div>
                <dt>Client email</dt>
                <dd>{invoice.client_email ?? "Not provided"}</dd>
              </div>
              <div>
                <dt>Was due</dt>
                <dd>{formatDate(invoice.due_date)}</dd>
              </div>
              <div>
                <dt>Days overdue</dt>
                <dd>{reminder!.days_overdue}</dd>
              </div>
            </dl>
            <label className="stack">
              Subject
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
            <label className="stack">
              Message
              <textarea className="message-input" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <ErrorNote message={error} />
          </div>
          <div className="consequence">
            <ShieldCheck size={15} aria-hidden />
            <ul>
              <li>
                <strong>If you approve:</strong> this message is logged, with the payment link for {amount} added at the end.
              </li>
              <li>No email goes out. You get the message to copy and send yourself.</li>
            </ul>
          </div>
          <div className="review-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              <Check size={14} aria-hidden />
              {edited ? "Save and approve reminder" : "Approve reminder"}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void reject()}>
              <X size={14} aria-hidden />
              Reject
            </button>
          </div>
        </>
      )}
      {(outcome || rejected) && (
        <div className="review-actions">
          <button type="button" className="btn" onClick={onChanged}>
            Done
          </button>
        </div>
      )}
    </article>
  );
}

function FlagCard({ invoice, onChanged }: { invoice: Invoice; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  const clear = async () => {
    try {
      await api(`/api/invoices/${invoice.id}/clear-flag`, { method: "POST" });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <article className="review">
      <header className="review-head">
        <div>
          <p className="review-kind">
            Needs you: <Link to={`/invoices/${invoice.id}`}>{invoice.number}</Link>
          </p>
          <h3>{invoice.client_name}</h3>
        </div>
        <div>
          <div className="money review-amount">{money(invoice.total_cents, invoice.currency)}</div>
          <span className="tags">
            <span className="tag tag-overdue">Overdue {invoice.days_overdue}d</span>
            <DemoBadge invoice={invoice} />
          </span>
        </div>
      </header>
      <div className="consequence">
        <CircleAlert size={15} aria-hidden />
        <ul>
          <li>
            <strong>Why it's flagged:</strong> {invoice.flagged_reason}
          </li>
          <li>Nothing was drafted. Allowing reminders only lets the next collections check draft one for your approval.</li>
        </ul>
      </div>
      {error && (
        <div className="review-body">
          <ErrorNote message={error} />
        </div>
      )}
      <div className="review-actions">
        <button type="button" className="btn" onClick={() => void clear()}>
          I've reviewed this, allow reminders
        </button>
      </div>
    </article>
  );
}

export function Approvals({ mode, onChanged }: { mode: ProviderMode; onChanged: () => void }) {
  const { data, error, refresh } = useApi<{ pending: Approval[]; flagged: Invoice[] }>("/api/approvals");
  const changed = () => {
    void refresh();
    onChanged();
  };
  const sends = data?.pending.filter((a) => a.type === "invoice_send") ?? [];
  const reminders = data?.pending.filter((a) => a.type === "reminder_send") ?? [];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Approval queue</h1>
          <p className="page-sub">Nothing leaves Chaser until you approve it here.</p>
        </div>
      </header>
      <ErrorNote message={error} />
      {data && data.pending.length === 0 && data.flagged.length === 0 && <p className="panel empty">Nothing is waiting for you.</p>}

      {sends.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Payment requests</h2>
            <span className="count">{sends.length}</span>
          </div>
          {sends.map((approval) => (
            <DraftCard
              key={approval.id}
              invoice={approval.invoice}
              approvalId={approval.id}
              mode={mode}
              lastError={approval.last_error}
              onChanged={onChanged}
            />
          ))}
        </section>
      )}

      {reminders.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Reminders</h2>
            <span className="count">{reminders.length}</span>
          </div>
          {reminders.map((approval) => (
            <ReminderCard key={approval.id} approval={approval} onChanged={changed} />
          ))}
        </section>
      )}

      {data && data.flagged.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Flagged for you</h2>
            <span className="count">{data.flagged.length}</span>
          </div>
          <p className="section-note" style={{ marginBottom: 8 }}>
            These looked risky, so the agent didn't draft a demand. Handle them personally.
          </p>
          {data.flagged.map((invoice) => (
            <FlagCard key={invoice.id} invoice={invoice} onChanged={changed} />
          ))}
        </section>
      )}
    </>
  );
}
