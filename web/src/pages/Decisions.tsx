import { useState } from "react";
import { ActorTag, ErrorNote } from "../components";
import { actionLabel, formatTime, Link, useApi, type Decision } from "../lib";

const ACTORS = [
  { key: "all", label: "All" },
  { key: "agent", label: "Agent" },
  { key: "human", label: "Human" },
  { key: "system", label: "System" },
];

export function Decisions() {
  const { data, error } = useApi<{ decisions: Decision[] }>("/api/decisions");
  const [actor, setActor] = useState("all");
  const rows = data?.decisions.filter((entry) => actor === "all" || entry.actor === actor);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Decision log</h1>
          <p className="page-sub">What happened, who decided it, and why.</p>
        </div>
      </header>
      <div className="segmented" role="group" aria-label="Filter by who decided">
        {ACTORS.map((option) => (
          <button
            type="button"
            key={option.key}
            className={actor === option.key ? "active" : ""}
            aria-pressed={actor === option.key}
            onClick={() => setActor(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {rows && rows.length === 0 && <p className="panel empty">Nothing here yet.</p>}
      {rows && rows.length > 0 && (
        <div className="panel">
          <table className="table table-log">
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th>Decision</th>
                <th>Invoice</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Time" className="cell-date small">
                    {formatTime(entry.created_at)}
                  </td>
                  <td data-label="Who">
                    <ActorTag actor={entry.actor} />
                  </td>
                  <td data-label="Decision" className="cell-strong">
                    <span>{actionLabel(entry.action)}</span>
                  </td>
                  <td data-label="Invoice" className="nowrap">
                    {entry.invoice_id && entry.invoice_number ? (
                      <Link to={`/invoices/${entry.invoice_id}`}>{entry.invoice_number}</Link>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td data-label="Why" className="muted small">
                    <span>{entry.reasoning}</span>
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
