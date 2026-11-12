import { CircleAlert, CreditCard, FileText, LayoutDashboard, ListChecks, MessageSquare, RefreshCw, ScrollText } from "lucide-react";
import { useState } from "react";
import { Notice } from "./components";
import { api, errorText, Link, usePath, useApi, type Status } from "./lib";
import { Agent, type ChatEntry } from "./pages/Agent";
import { Approvals } from "./pages/Approvals";
import { Dashboard } from "./pages/Dashboard";
import { Decisions } from "./pages/Decisions";
import { InvoiceDetail, Invoices } from "./pages/Invoices";
import { Landing } from "./pages/Landing";
import { Pay } from "./pages/Pay";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/agent", label: "Agent", icon: MessageSquare },
  { to: "/approvals", label: "Approvals", icon: ListChecks },
  { to: "/invoices", label: "Invoices", icon: FileText },
  { to: "/decisions", label: "Decision log", icon: ScrollText },
];

function ProviderBanner({ status, onRecheck }: { status: Status; onRecheck: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { mode, reason } = status.provider;
  const titles = {
    invoicing: "PayPal Invoicing mode",
    orders: "PayPal Orders mode",
    none: "PayPal isn't connected",
  };
  return (
    <div className={`strip strip-${mode}`} role="status">
      <div className="strip-main">
        {mode === "none" ? <CircleAlert size={15} aria-hidden /> : <CreditCard size={15} aria-hidden />}
        <div>
          <span className="strip-title">{titles[mode]}</span> <span className="tag tag-outline">Sandbox</span>
          <span className="block muted small">{reason}</span>
        </div>
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRecheck().finally(() => setBusy(false));
        }}
      >
        <RefreshCw size={14} aria-hidden />
        {busy ? "Checking..." : "Check again"}
      </button>
    </div>
  );
}

function AdminApp({ path }: { path: string }) {
  const { data: status, error, refresh } = useApi<Status>("/api/status");
  // Kept here so the conversation survives moving between pages.
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [recheckError, setRecheckError] = useState<string>();
  const onChanged = () => void refresh();
  const mode = status?.provider.mode;

  const recheck = async () => {
    try {
      await api("/api/provider/recheck", { method: "POST" });
      setRecheckError(undefined);
      await refresh();
    } catch (e) {
      setRecheckError(errorText(e));
    }
  };

  const invoiceMatch = path.match(/^\/invoices\/(\d+)$/);
  let page;
  if (path === "/dashboard") page = <Dashboard onChanged={onChanged} />;
  else if (path === "/agent") page = <Agent chat={chat} setChat={setChat} llmConfigured={status?.llm_configured} mode={mode} onChanged={onChanged} />;
  else if (path === "/approvals") page = <Approvals mode={mode} onChanged={onChanged} />;
  else if (path === "/invoices") page = <Invoices />;
  else if (invoiceMatch) page = <InvoiceDetail key={invoiceMatch[1]} id={Number(invoiceMatch[1])} mode={mode} devTools={Boolean(status?.dev_tools)} onChanged={onChanged} />;
  else if (path === "/decisions") page = <Decisions />;
  else page = <p className="panel empty">Page not found. <Link to="/dashboard">Go to the dashboard</Link></p>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/dashboard" className="brand">
          <span className="brand-mark" aria-hidden>C</span>
          Chaser
        </Link>
        <nav aria-label="Main">
          {NAV.map((item) => {
            const active = path.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link key={item.to} to={item.to} className={active ? "nav-item active" : "nav-item"}>
                <Icon size={15} aria-hidden />
                <span className="nav-label">{item.label}</span>
                {item.to === "/approvals" && Boolean(status?.pending_approvals) && (
                  <span className="count">
                    <span className="sr-only">Pending: </span>
                    {status?.pending_approvals}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <p className="sidebar-foot">PayPal sandbox</p>
      </aside>
      <main className="content">
        {status && path === "/dashboard" && <ProviderBanner status={status} onRecheck={recheck} />}
        {(error || recheckError) && <Notice tone="error">{error ?? recheckError}</Notice>}
        {page}
      </main>
    </div>
  );
}

export function App() {
  const path = usePath();
  // The marketing page sits in front of the app. Everything else is unchanged.
  if (path === "/") return <Landing />;
  const payMatch = path.match(/^\/pay\/([^/]+)(?:\/(success|cancelled|error))?$/);
  if (payMatch) return <Pay key={path} publicId={payMatch[1]!} outcome={payMatch[2]} />;
  return <AdminApp path={path} />;
}
