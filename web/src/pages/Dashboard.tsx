import { CircleCheck, Clock, Play, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActorTag, ErrorNote, Notice } from "../components";
import { actionLabel, api, errorText, formatTime, Link, money, moneyShort, useApi, type Decision } from "../lib";

interface Totals {
  currency: string;
  outstanding_cents: number;
  overdue_cents: number;
  paid_this_month_cents: number;
  open_count: number;
  overdue_count: number;
  paid_this_month_count: number;
  aging: { key: string; label: string; cents: number; count: number }[];
}

interface DashboardData {
  totals: Totals[];
  pending_approvals: number;
  activity: Decision[];
}

interface CollectionsSummary {
  checked: number;
  drafted: number;
  flagged: number;
  skipped: number;
  failed: number;
  message?: string;
}

function Stat(props: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {props.icon}
        {props.label}
      </div>
      <div className="money stat-figure">{props.value}</div>
      <div className="stat-context">{props.detail}</div>
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function AgingChart({ totals }: { totals: Totals }) {
  const max = Math.max(...totals.aging.map((bucket) => bucket.cents), 1);
  return (
    <div>
      <div className="bars-head" aria-hidden>
        <span>Past due</span>
        <span />
        <span>Amount</span>
        <span>No.</span>
      </div>
      <ul aria-label={`Open invoices by age, in ${totals.currency}`}>
        {totals.aging.map((bucket) => (
          <li
            className="bar-row"
            key={bucket.key}
            title={`${bucket.label}: ${money(bucket.cents, totals.currency)} across ${plural(bucket.count, "invoice")}`}
          >
            <span className="bar-label">{bucket.label}</span>
            <span className="bar-track">
              {bucket.cents > 0 && <span className="bar-fill" style={{ width: `${(bucket.cents / max) * 100}%` }} />}
            </span>
            <span className="bar-value money">{moneyShort(bucket.cents, totals.currency)}</span>
            <span className="bar-count">{bucket.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Dashboard({ onChanged }: { onChanged: () => void }) {
  const { data, error, refresh } = useApi<DashboardData>("/api/dashboard");
  const [currency, setCurrency] = useState<string>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CollectionsSummary>();
  const [runError, setRunError] = useState<string>();

  const runCheck = async () => {
    setRunning(true);
    setRunError(undefined);
    setResult(undefined);
    try {
      setResult(await api<CollectionsSummary>("/api/collections/run", { method: "POST" }));
      await refresh();
      onChanged();
    } catch (e) {
      setRunError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const selected = data?.totals.find((t) => t.currency === currency) ?? data?.totals[0];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">What you're owed, and what needs you.</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void runCheck()}>
          <Play size={14} aria-hidden />
          {running ? "Checking..." : "Run collections check"}
        </button>
      </header>

      <ErrorNote message={error ?? runError} />
      {result && (
        <Notice tone={result.failed > 0 ? "warn" : "info"}>
          Checked {plural(result.checked, "overdue invoice")}: {plural(result.drafted, "reminder")} drafted, {result.flagged} flagged for you,{" "}
          {result.skipped} already handled{result.failed > 0 ? `, ${result.failed} failed` : ""}. {result.message ?? ""}{" "}
          {result.drafted + result.flagged > 0 && <Link to="/approvals">Review them</Link>}
        </Notice>
      )}

      {data && data.pending_approvals > 0 && (
        <Notice>
          {plural(data.pending_approvals, "item")} waiting for your approval. <Link to="/approvals">Open the queue</Link>
        </Notice>
      )}

      {data && data.totals.length > 1 && (
        <div className="segmented" role="group" aria-label="Currency">
          {data.totals.map((t) => (
            <button
              type="button"
              key={t.currency}
              className={t.currency === selected?.currency ? "active" : ""}
              aria-pressed={t.currency === selected?.currency}
              onClick={() => setCurrency(t.currency)}
            >
              {t.currency}
            </button>
          ))}
        </div>
      )}

      {data && !selected && <p className="panel empty">No open invoices yet. Start in the Agent tab.</p>}

      {selected && (
        <section className="stats" aria-label="Totals">
          <Stat
            icon={<Wallet size={14} aria-hidden />}
            label="Outstanding"
            value={money(selected.outstanding_cents, selected.currency)}
            detail={plural(selected.open_count, "open invoice")}
          />
          <Stat
            icon={<Clock size={14} aria-hidden />}
            label="Overdue"
            value={money(selected.overdue_cents, selected.currency)}
            detail={plural(selected.overdue_count, "invoice")}
          />
          <Stat
            icon={<CircleCheck size={14} aria-hidden />}
            label="Paid this month"
            value={money(selected.paid_this_month_cents, selected.currency)}
            detail={plural(selected.paid_this_month_count, "invoice")}
          />
        </section>
      )}

      <div className="dash-grid">
        {selected && (
          <section className="panel">
            <div className="panel-head">
              <h2>Aging of open invoices</h2>
            </div>
            <div className="panel-body">
              <AgingChart totals={selected} />
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <h2>Recent activity</h2>
            <Link to="/decisions">
              <span className="small">View all</span>
            </Link>
          </div>
          {data && data.activity.length === 0 && <p className="empty">Nothing yet.</p>}
          <ul className="feed">
            {data?.activity.map((entry) => (
              <li key={entry.id}>
                <ActorTag actor={entry.actor} />
                <span className="feed-text">
                  <strong>{actionLabel(entry.action)}</strong>
                  {entry.invoice_id && entry.invoice_number && (
                    <>
                      {" "}
                      <Link to={`/invoices/${entry.invoice_id}`}>{entry.invoice_number}</Link>
                    </>
                  )}
                  <span className="feed-why">{entry.reasoning}</span>
                </span>
                <time>{formatTime(entry.created_at)}</time>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
