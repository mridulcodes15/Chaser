import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { paypalRequest } from "../src/paypal/client.js";
import { getProviderState, refreshProviderState } from "../src/payments/manager.js";
import {
  buildInvoiceBody,
  invoicingProvider,
  mapInvoiceStatus,
} from "../src/payments/invoicing.js";
import {
  beginCheckout,
  buildOrderBody,
  captureOrder,
  ordersProvider,
  statusFromOrder,
} from "../src/payments/orders.js";
import { createInvoice, findOrCreateClient, getInvoice, toView } from "../src/store.js";
import { mockFetch, NOT_AUTHORIZED } from "./helpers.js";

function makeInvoice(overrides: { quantity?: number; terms?: number | null } = {}) {
  const client = findOrCreateClient("Acme", "ap@acme.test");
  return toView(
    createInvoice({
      client_id: client.id,
      currency: "USD",
      items: [{ description: "Brand work", quantity: overrides.quantity ?? 1, unit_cents: 240000 }],
      issue_date: "2026-11-01",
      due_date: "2026-11-16",
      terms_days: overrides.terms === undefined ? 15 : overrides.terms,
      status: "sent",
    }),
  );
}

describe("sandbox lock", () => {
  it("refuses to start with any other PayPal URL", () => {
    process.env.PAYPAL_BASE_URL = "https://api-m.paypal.com";
    expect(() => getConfig()).toThrow(/sandbox only/);
  });

  it("refuses a full URL so requests can't leave the sandbox host", async () => {
    await expect(
      paypalRequest({ method: "GET", path: "https://api-m.paypal.com/x", step: "x" }),
    ).rejects.toThrow(/sandbox host/);
  });

  it("sends every request to the sandbox host", async () => {
    const calls = mockFetch({ "GET /v2/checkout/orders/ABC": { json: { id: "ABC" } } });
    await paypalRequest({ method: "GET", path: "/v2/checkout/orders/ABC", step: "x" });
    expect(new URL(calls[0]!.url).host).toBe("api-m.sandbox.paypal.com");
  });
});

describe("capability check", () => {
  it("uses invoicing when a draft can be created, then deletes the draft", async () => {
    const calls = mockFetch({
      "POST /v2/invoicing/invoices": { status: 201, json: { id: "INV2-PROBE" } },
      "DELETE /v2/invoicing/invoices/INV2-PROBE": { status: 204 },
    });
    const state = await refreshProviderState();
    expect(state.mode).toBe("invoicing");
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  });

  it("falls back to orders on 403 and explains why", async () => {
    mockFetch({ "POST /v2/invoicing/invoices": NOT_AUTHORIZED });
    const state = await refreshProviderState();
    expect(state.mode).toBe("orders");
    expect(state.reason).toMatch(/403 NOT_AUTHORIZED/);
  });

  it("reports bad credentials instead of pretending orders will work", async () => {
    mockFetch({ "POST /v2/invoicing/invoices": { status: 401, json: { name: "AUTHENTICATION_FAILURE" } } });
    expect((await refreshProviderState()).mode).toBe("none");
  });

  it("makes no PayPal call when a mode is forced", async () => {
    process.env.PAYMENT_PROVIDER = "orders";
    const calls = mockFetch({});
    expect((await refreshProviderState()).mode).toBe("orders");
    expect(calls).toHaveLength(0);
  });

  it("reports missing credentials", async () => {
    process.env.PAYPAL_CLIENT_ID = "";
    mockFetch({});
    expect((await getProviderState()).mode).toBe("none");
  });
});

describe("invoicing provider", () => {
  it("builds a NET term body with cents as decimal strings", () => {
    const body = buildInvoiceBody(makeInvoice()) as any;
    expect(body.detail.payment_term).toEqual({ term_type: "NET_15" });
    expect(body.items[0].unit_amount).toEqual({ currency_code: "USD", value: "2400.00" });
    expect(body.primary_recipients[0].billing_info.email_address).toBe("ap@acme.test");
  });

  it("uses a specific due date when terms aren't a PayPal NET value", () => {
    const body = buildInvoiceBody(makeInvoice({ terms: 7 })) as any;
    expect(body.detail.payment_term).toEqual({
      term_type: "DUE_ON_DATE_SPECIFIED",
      due_date: "2026-11-16",
    });
  });

  it("creates then sends without asking PayPal to email anyone", async () => {
    const invoice = makeInvoice();
    const calls = mockFetch({
      "POST /v2/invoicing/invoices": { status: 201, json: { id: "INV2-AAAA", status: "DRAFT" } },
      "POST /v2/invoicing/invoices/INV2-AAAA/send": { json: { href: "https://pp.test/fallback" } },
      "GET /v2/invoicing/invoices/INV2-AAAA": {
        json: {
          status: "SENT",
          detail: {
            metadata: { recipient_view_url: "https://pp.test/view" },
            payment_term: { due_date: "2026-11-22" },
          },
        },
      },
    });
    const result = await invoicingProvider.send(invoice);
    expect(calls[1]!.body).toEqual({ send_to_recipient: false, send_to_invoicer: false });
    expect(result).toMatchObject({
      payUrl: "https://pp.test/view",
      paypalInvoiceId: "INV2-AAAA",
      paypalStatus: "SENT",
      dueDate: "2026-11-22",
    });
  });

  it("doesn't create a second PayPal invoice when a send is retried", async () => {
    const invoice = makeInvoice();
    let sends = 0;
    const calls = mockFetch({
      "POST /v2/invoicing/invoices": { status: 201, json: { id: "INV2-RETRY" } },
      "POST /v2/invoicing/invoices/INV2-RETRY/send": () =>
        ++sends === 1 ? { status: 500, json: { name: "INTERNAL_SERVER_ERROR" } } : { json: {} },
      "GET /v2/invoicing/invoices/INV2-RETRY": { json: { status: "SENT" } },
    });
    await expect(invoicingProvider.send(invoice)).rejects.toThrow(/HTTP 500/);
    await invoicingProvider.send(toView(getInvoice(invoice.id)!));
    expect(calls.filter((call) => call.path === "/v2/invoicing/invoices")).toHaveLength(1);
  });

  it("never treats an unknown status as paid", () => {
    expect(mapInvoiceStatus("PAID")).toBe("paid");
    expect(mapInvoiceStatus("SOMETHING_NEW")).toBe("open");
    expect(mapInvoiceStatus(undefined)).toBe("open");
  });
});

describe("orders provider", () => {
  it("gives a Chaser pay link and creates nothing at PayPal on send", async () => {
    const calls = mockFetch({});
    const invoice = makeInvoice();
    const result = await ordersProvider.send(invoice);
    expect(result.payUrl).toBe(`http://chaser.test/pay/${invoice.public_id}`);
    expect(calls).toHaveLength(0);
  });

  it("builds an order whose breakdown matches the total", () => {
    const invoice = makeInvoice();
    const unit = (buildOrderBody(invoice) as any).purchase_units[0];
    expect(unit.amount.value).toBe("2400.00");
    expect(unit.amount.breakdown.item_total.value).toBe("2400.00");
    expect(unit.custom_id).toBe(invoice.public_id);
  });

  it("turns a fractional quantity into one line with the same total", () => {
    const body = buildOrderBody(makeInvoice({ quantity: 2.5 })) as any;
    const item = body.purchase_units[0].items[0];
    expect(item.quantity).toBe("1");
    expect(item.unit_amount.value).toBe("6000.00");
    expect(body.purchase_units[0].amount.value).toBe("6000.00");
  });

  it("sets return and cancel URLs and a request ID, and stores the order", async () => {
    const invoice = makeInvoice();
    const calls = mockFetch({
      "POST /v2/checkout/orders": {
        status: 201,
        json: {
          id: "ORDER1",
          status: "PAYER_ACTION_REQUIRED",
          links: [{ rel: "payer-action", href: "https://pp.test/approve" }],
        },
      },
    });
    const result = await beginCheckout(invoice);
    expect(result).toEqual({ kind: "redirect", url: "https://pp.test/approve" });
    const context = calls[0]!.body.payment_source.paypal.experience_context;
    expect(context.return_url).toBe(`http://chaser.test/api/pay/${invoice.public_id}/return`);
    expect(context.cancel_url).toBe(`http://chaser.test/api/pay/${invoice.public_id}/cancel`);
    expect(calls[0]!.headers["PayPal-Request-Id"]).toBeTruthy();
    expect(getInvoice(invoice.id)!.paypal_order_id).toBe("ORDER1");
  });

  it("reuses the open order instead of creating a second one", async () => {
    const invoice = makeInvoice();
    const calls = mockFetch({
      "POST /v2/checkout/orders": {
        status: 201,
        json: { id: "ORDER1", links: [{ rel: "approve", href: "https://pp.test/a" }] },
      },
      "GET /v2/checkout/orders/ORDER1": {
        json: { id: "ORDER1", status: "CREATED", links: [{ rel: "approve", href: "https://pp.test/a" }] },
      },
    });
    await beginCheckout(invoice);
    await beginCheckout(toView(getInvoice(invoice.id)!));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("won't create a second order when the first can't be checked", async () => {
    const invoice = makeInvoice();
    const first = mockFetch({
      "POST /v2/checkout/orders": {
        status: 201,
        json: { id: "ORDER1", links: [{ rel: "approve", href: "https://pp.test/a" }] },
      },
    });
    await beginCheckout(invoice);
    expect(first).toHaveLength(1);
    const calls = mockFetch({
      "GET /v2/checkout/orders/ORDER1": { status: 500, json: { name: "INTERNAL_SERVER_ERROR" } },
    });
    await expect(beginCheckout(toView(getInvoice(invoice.id)!))).rejects.toThrow(/HTTP 500/);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("captures with a fixed request ID and reads the amount", async () => {
    const calls = mockFetch({
      "POST /v2/checkout/orders/ORDER1/capture": {
        status: 201,
        json: {
          id: "ORDER1",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "2400.00" } },
                ],
              },
            },
          ],
        },
      },
    });
    const status = await captureOrder("ORDER1");
    expect(status).toMatchObject({ state: "paid", captureId: "CAP1", paidCents: 240000, paidCurrency: "USD" });
    expect(calls[0]!.headers["PayPal-Request-Id"]).toBe("chaser-capture-ORDER1");
  });

  it("uses a new request ID after a refusal, but keeps it after an unclear failure", async () => {
    const replies = [
      { status: 500, json: { name: "INTERNAL_SERVER_ERROR" } },
      { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } },
      {
        status: 201,
        json: {
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: "C", status: "COMPLETED" }] } }],
        },
      },
    ];
    const calls = mockFetch({ "POST /v2/checkout/orders/RETRY/capture": () => replies.shift()! });
    await expect(captureOrder("RETRY")).rejects.toThrow(/HTTP 500/);
    await expect(captureOrder("RETRY")).rejects.toThrow(/HTTP 422/);
    await captureOrder("RETRY");
    expect(calls.map((call) => call.headers["PayPal-Request-Id"])).toEqual([
      "chaser-capture-RETRY",
      "chaser-capture-RETRY",
      "chaser-capture-RETRY-1",
    ]);
  });

  it("recovers when PayPal says the order was already captured", async () => {
    mockFetch({
      "POST /v2/checkout/orders/ORDER1/capture": {
        status: 422,
        json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
      },
      "GET /v2/checkout/orders/ORDER1": {
        json: {
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } }],
        },
      },
    });
    expect((await captureOrder("ORDER1")).state).toBe("paid");
  });

  it("doesn't call an order paid until the capture completes", () => {
    expect(statusFromOrder({ status: "APPROVED" }).state).toBe("approved");
    expect(statusFromOrder({ status: "COMPLETED" }).state).toBe("open");
    expect(
      statusFromOrder({
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "C", status: "DECLINED" }] } }],
      }).state,
    ).toBe("open");
    expect(
      statusFromOrder({
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "C", status: "PENDING" }] } }],
      }).state,
    ).toBe("pending");
  });
});
