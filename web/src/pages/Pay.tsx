// The public page a client opens. It never calls admin APIs, so it works with no password.
import { Lock } from "lucide-react";
import { useState } from "react";
import { ErrorNote, LineItems, Notice } from "../components";
import { api, errorText, formatDate, MERCHANT_NAME, money, useApi } from "../lib";

interface PublicInvoice {
  number: string;
  client_name: string;
  status: string;
  currency: string;
  total_cents: number;
  issue_date: string;
  due_date: string;
  is_overdue: boolean;
  is_demo: boolean;
  items: { description: string; quantity: number; unit_cents: number }[];
}

const ERROR_TEXT: Record<string, string> = {
  declined: "PayPal couldn't complete the payment with that funding method. You haven't been charged. Please try again.",
  mismatch: "That return link doesn't match this invoice, so no payment was taken.",
  review: "PayPal reported a payment that doesn't match this invoice. The sender has been told and will be in touch.",
  capture_failed: "We couldn't confirm your payment with PayPal. Please try again in a moment.",
  not_completed: "PayPal didn't complete the payment. Please try again.",
};

export function Pay({ publicId, outcome }: { publicId: string; outcome?: string }) {
  const { data, error } = useApi<PublicInvoice>(`/api/pay/${publicId}`);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string>();
  const params = new URLSearchParams(window.location.search);

  const pay = async () => {
    setBusy(true);
    setPayError(undefined);
    try {
      const { redirect } = await api<{ redirect: string }>(`/api/pay/${publicId}/checkout`, { method: "POST" });
      window.location.assign(redirect);
    } catch (e) {
      setPayError(errorText(e));
      setBusy(false);
    }
  };

  const pending = outcome === "success" && params.get("pending") === "1";
  const paid = data?.status === "paid";
  const payable = data?.status === "sent" && !data.is_demo && !pending;
  const amount = data ? money(data.total_cents, data.currency) : "";

  return (
    <main className="pay-page">
      <div className="pay-card">
        <header className="pay-merchant">
          <span>Payment to</span>
          <strong>{MERCHANT_NAME}</strong>
        </header>

        {error && (
          <div className="pay-section">
            <ErrorNote message={error} />
          </div>
        )}
        {!error && !data && <div className="pay-section muted">Loading...</div>}

        {data && (
          <>
            {data.is_demo && (
              <div className="pay-section">
                <Notice tone="warn">Demo invoice. This can't be paid.</Notice>
              </div>
            )}
            {outcome === "success" && paid && (
              <div className="pay-section">
                <Notice tone="good">Payment received. Thank you!</Notice>
              </div>
            )}
            {pending && (
              <div className="pay-section">
                <Notice>PayPal is still processing your payment. This page will show it as paid once it clears.</Notice>
              </div>
            )}
            {outcome === "cancelled" && !paid && (
              <div className="pay-section">
                <Notice>You cancelled at PayPal, and no payment was taken. You can pay whenever you're ready.</Notice>
              </div>
            )}
            {outcome === "error" && (
              <div className="pay-section">
                <Notice tone="error">{ERROR_TEXT[params.get("reason") ?? ""] ?? "Something went wrong with the payment."}</Notice>
              </div>
            )}

            <section className="pay-section">
              <div className="pay-label">{paid ? "Amount paid" : "Amount due"}</div>
              <div className="money pay-figure">{amount}</div>
              {paid ? (
                <span className="tag tag-paid">Paid</span>
              ) : data.is_overdue ? (
                <span className="tag tag-overdue">Overdue, was due {formatDate(data.due_date)}</span>
              ) : data.status === "sent" ? (
                <span className="tag">Due {formatDate(data.due_date)}</span>
              ) : (
                <span className="tag">This invoice is {data.status}</span>
              )}
            </section>

            <section className="pay-section">
              <dl className="facts">
                <div>
                  <dt>Billed to</dt>
                  <dd>{data.client_name}</dd>
                </div>
                <div>
                  <dt>Invoice</dt>
                  <dd>{data.number}</dd>
                </div>
              </dl>
            </section>

            <section className="pay-section">
              <LineItems items={data.items} currency={data.currency} total={data.total_cents} />
            </section>

            {(payable || payError) && (
              <section className="pay-section">
                <ErrorNote message={payError} />
                {payable && (
                  <button type="button" className="btn btn-primary btn-pay" disabled={busy} onClick={() => void pay()}>
                    {busy ? "Opening PayPal..." : `Pay ${amount} with PayPal`}
                  </button>
                )}
                <p className="pay-foot">
                  <Lock size={13} aria-hidden />
                  You'll complete payment on PayPal. Sandbox test mode: no real money moves.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
