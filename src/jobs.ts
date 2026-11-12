// Background jobs. The reconciler means the demo works without a public webhook URL.
import { getConfig } from "./config.js";
import { db } from "./db.js";
import { runCollections } from "./services/collections.js";
import { reconcileInvoice } from "./services/settlement.js";

let reconciling = false;

/** Asks PayPal about every open real invoice. One failure doesn't stop the others. */
export async function reconcileAll(): Promise<{ checked: number; failed: number }> {
  const summary = { checked: 0, failed: 0 };
  if (reconciling || !getConfig().paypalConfigured) return summary;
  reconciling = true;
  try {
    const open = db()
      .prepare(
        `SELECT id FROM invoices WHERE status = 'sent' AND is_demo = 0
           AND (paypal_invoice_id IS NOT NULL OR paypal_order_id IS NOT NULL)`,
      )
      .all() as { id: number }[];
    for (const { id } of open) {
      summary.checked++;
      try {
        await reconcileInvoice(id, "reconciler");
      } catch (error) {
        summary.failed++;
        console.error(`Reconcile failed for invoice ${id}:`, error instanceof Error ? error.message : error);
      }
    }
    return summary;
  } finally {
    reconciling = false;
  }
}

export function startJobs(): () => void {
  const config = getConfig();
  const reconcileTimer = setInterval(() => void reconcileAll(), config.RECONCILE_INTERVAL_SECONDS * 1000);
  const collectionsTimer = setInterval(() => {
    // Without an AI key there's nothing to draft, and an error every hour is just noise.
    if (getConfig().GROQ_API_KEY && getConfig().GROQ_MODEL) void runCollections("scheduled");
  }, config.COLLECTIONS_INTERVAL_MINUTES * 60_000);
  reconcileTimer.unref();
  collectionsTimer.unref();
  return () => {
    clearInterval(reconcileTimer);
    clearInterval(collectionsTimer);
  };
}
