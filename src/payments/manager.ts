import { getConfig } from "../config.js";
import { PayPalApiError } from "../paypal/client.js";
import { setSetting } from "../store.js";
import { createDraftInvoice, deleteDraftInvoice, invoicingProvider } from "./invoicing.js";
import { ordersProvider } from "./orders.js";
import type { PaymentProvider, ProviderName } from "./types.js";

export interface ProviderState {
  mode: ProviderName | "none";
  requested: "auto" | "invoicing" | "orders";
  reason: string;
  probed_at: string;
}

const PROBE_BODY = {
  detail: { currency_code: "USD", note: "Chaser capability check. Safe to delete." },
  items: [
    {
      name: "Chaser capability check",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "1.00" },
    },
  ],
};

async function probe(): Promise<Pick<ProviderState, "mode" | "reason">> {
  const { PAYMENT_PROVIDER, paypalConfigured } = getConfig();
  if (!paypalConfigured) {
    return {
      mode: "none",
      reason: "PayPal sandbox credentials aren't set, so payment requests can't be sent.",
    };
  }
  if (PAYMENT_PROVIDER !== "auto") {
    return { mode: PAYMENT_PROVIDER, reason: `Set by PAYMENT_PROVIDER=${PAYMENT_PROVIDER}.` };
  }

  try {
    const draft = await createDraftInvoice(PROBE_BODY);
    let cleanup = "";
    try {
      await deleteDraftInvoice(draft.id);
    } catch {
      cleanup = ` The test draft ${draft.id} couldn't be deleted and can be ignored.`;
    }
    return {
      mode: "invoicing",
      reason: `Using PayPal Invoicing: this app is allowed to create invoices.${cleanup}`,
    };
  } catch (error) {
    if (error instanceof PayPalApiError && error.status === 403) {
      return {
        mode: "orders",
        reason:
          "Using PayPal Orders with a Chaser payment page: this sandbox app doesn't have Invoicing permission (403 NOT_AUTHORIZED).",
      };
    }
    if (error instanceof PayPalApiError && error.status === 401) {
      return {
        mode: "none",
        reason: "PayPal rejected the sandbox credentials (401). Check the client ID and secret.",
      };
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      mode: "orders",
      reason: `Using PayPal Orders because the Invoicing check couldn't finish: ${detail}`,
    };
  }
}

let current: Promise<ProviderState> | undefined;

/** Runs the capability check again. Sends wait for the result instead of guessing. */
export function refreshProviderState(): Promise<ProviderState> {
  current = probe().then((result) => {
    const state: ProviderState = {
      ...result,
      requested: getConfig().PAYMENT_PROVIDER,
      probed_at: new Date().toISOString(),
    };
    setSetting("provider_state", JSON.stringify(state));
    return state;
  });
  return current;
}

export function getProviderState(): Promise<ProviderState> {
  return current ?? refreshProviderState();
}

export function resetProviderState(): void {
  current = undefined;
}

export function providerByName(name: string | null): PaymentProvider | undefined {
  if (name === "invoicing") return invoicingProvider;
  if (name === "orders") return ordersProvider;
  return undefined;
}
