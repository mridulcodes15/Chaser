import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db } from "../src/db.js";
import { reconcileAll } from "../src/jobs.js";
import { refreshProviderState } from "../src/payments/manager.js";
import { proposeDraft } from "../src/services/drafts.js";
import {
  createInvoice,
  findOrCreateClient,
  getApproval,
  getInvoice,
  listApprovals,
  listDecisions,
  updateInvoice,
} from "../src/store.js";
import { mockFetch, NOT_AUTHORIZED, type MockCall } from "./helpers.js";

const app = () => createApp();
const json = (req: request.Test, body: object = {}) => req.set("Content-Type", "application/json").send(body);

function draft(options: { demo?: boolean } = {}) {
  const { invoice, approvalId } = proposeDraft(
    {
      client_name: "Acme",
      client_email: "ap@acme.test",
      currency: "USD",
      line_items: [{ description: "Work", quantity: 1, unit_amount: 2400 }],
      payment_terms_days: 15,
    },
    { actor: "agent", reasoning: "test" },
  );
  if (options.demo) updateInvoice(invoice.id, { is_demo: 1 });
  return { invoice, approvalId };
}

const orderRoutes = { "POST /v2/invoicing/invoices": NOT_AUTHORIZED };

const capture = (value = "2400.00", status = "COMPLETED") => ({
  status: 201,
  json: {
    id: "ORDER1",
    status: "COMPLETED",
    purchase_units: [
      { payments: { captures: [{ id: "CAP1", status, amount: { currency_code: "USD", value } }] } },
    ],
  },
});

const completedOrder = (value = "2400.00") => ({
  json: {
    status: "COMPLETED",
    purchase_units: [
      { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value } }] } },
    ],
  },
});

const newOrder = {
  status: 201,
  json: {
    id: "ORDER1",
    status: "PAYER_ACTION_REQUIRED",
    links: [{ rel: "payer-action", href: "https://pp.test/approve" }],
  },
};

async function sentOrdersInvoice(routes: Parameters<typeof mockFetch>[0] = {}) {
  const calls = mockFetch({ ...orderRoutes, ...routes });
  const { invoice, approvalId } = draft();
  const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
    revision: invoice.revision,
  });
  expect(res.status).toBe(200);
  return { calls, invoice: getInvoice(invoice.id)!, approvalId, response: res.body };
}

const paypalCalls = (calls: MockCall[]) => calls.filter((call) => call.url.includes("paypal.com"));

describe("approval gating", () => {
  it("creating a draft moves no money and calls no provider", () => {
    const calls = mockFetch({});
    const { invoice } = draft();
    expect(getInvoice(invoice.id)!.status).toBe("draft");
    expect(calls).toHaveLength(0);
  });

  it("no route other than approve can send", async () => {
    const calls = mockFetch({});
    const { invoice } = draft();
    await request(app()).get(`/api/invoices/${invoice.id}`);
    await request(app()).get("/api/approvals");
    await json(request(app()).post(`/api/invoices/${invoice.id}/send`));
    expect(getInvoice(invoice.id)!.status).toBe("draft");
    expect(paypalCalls(calls)).toHaveLength(0);
  });

  it("a GET can't approve", async () => {
    mockFetch({});
    const { approvalId } = draft();
    await request(app()).get(`/api/approvals/${approvalId}/approve`);
    expect(getApproval(approvalId)!.status).toBe("pending");
  });

  it("sends after approval and gives a copyable message, without email", async () => {
    const { invoice, response } = await sentOrdersInvoice();
    expect(invoice.status).toBe("sent");
    expect(invoice.provider).toBe("orders");
    expect(invoice.pay_url).toBe(`http://chaser.test/pay/${invoice.public_id}`);
    expect(response.message).toContain("$2,400.00");
    expect(response.message).toContain(invoice.pay_url);
    expect(listDecisions().map((d) => d.action)).toEqual(expect.arrayContaining(["approved", "sent"]));
  });

  it("acts only once on a double click", async () => {
    const { approvalId, invoice } = await sentOrdersInvoice();
    const again = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(again.status).toBe(409);
  });

  it("refuses a stale approval if the draft changed", async () => {
    mockFetch(orderRoutes);
    const { invoice, approvalId } = draft();
    await json(request(app()).patch(`/api/invoices/${invoice.id}`), {
      line_items: [{ description: "Work", quantity: 1, unit_amount: 9000 }],
    });
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed after you opened it/);
    expect(getInvoice(invoice.id)!.status).toBe("draft");
  });

  it("requires the revision so a blind approve can't work", async () => {
    mockFetch(orderRoutes);
    const { approvalId } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`));
    expect(res.status).toBe(400);
    expect(getApproval(approvalId)!.status).toBe("pending");
  });

  it("human edits still respect the limits", async () => {
    mockFetch({});
    const { invoice } = draft();
    const res = await json(request(app()).patch(`/api/invoices/${invoice.id}`), {
      line_items: [{ description: "Work", quantity: 1, unit_amount: 999999 }],
    });
    expect(res.status).toBe(400);
    expect(getInvoice(invoice.id)!.total_cents).toBe(240000);
  });

  it("goes back to the queue with the error when PayPal fails", async () => {
    process.env.PAYMENT_PROVIDER = "invoicing";
    mockFetch({
      "POST /v2/invoicing/invoices": {
        status: 500,
        json: { name: "INTERNAL_SERVER_ERROR", debug_id: "d1", message: "boom" },
      },
    });
    const { invoice, approvalId } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(502);
    expect(res.body.paypal.debug_id).toBe("d1");
    expect(getInvoice(invoice.id)!.status).toBe("draft");
    expect(getApproval(approvalId)).toMatchObject({
      status: "pending",
      last_error: expect.stringContaining("HTTP 500"),
    });
  });

  it("refuses to send with no working provider and leaves it pending", async () => {
    process.env.PAYPAL_CLIENT_ID = "";
    mockFetch({});
    const { invoice, approvalId } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(503);
    expect(getApproval(approvalId)!.status).toBe("pending");
  });

  it("reject sends nothing and closes the draft", async () => {
    const calls = mockFetch({});
    const { invoice, approvalId } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/reject`), {
      reason: "wrong client",
    });
    expect(res.status).toBe(200);
    expect(getInvoice(invoice.id)!.status).toBe("rejected");
    expect(calls).toHaveLength(0);
    expect(listDecisions().some((d) => d.action === "draft_rejected" && d.reasoning === "wrong client")).toBe(true);
  });

  it("uses the invoicing provider when the check allows it", async () => {
    const calls = mockFetch({
      "POST /v2/invoicing/invoices": (call) => ({
        status: 201,
        json: { id: call.body.detail.note?.startsWith("Chaser capability") ? "INV2-PROBE" : "INV2-REAL" },
      }),
      "DELETE /v2/invoicing/invoices/INV2-PROBE": { status: 204 },
      "POST /v2/invoicing/invoices/INV2-REAL/send": { json: {} },
      "GET /v2/invoicing/invoices/INV2-REAL": {
        json: { status: "SENT", detail: { metadata: { recipient_view_url: "https://pp.test/view" } } },
      },
    });
    const { invoice, approvalId } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(200);
    expect(getInvoice(invoice.id)).toMatchObject({
      provider: "invoicing",
      paypal_invoice_id: "INV2-REAL",
      pay_url: "https://pp.test/view",
    });
    expect(calls.some((call) => call.path.endsWith("/INV2-REAL/send"))).toBe(true);
  });

  it("never calls PayPal for demo invoices", async () => {
    process.env.PAYMENT_PROVIDER = "invoicing";
    const calls = mockFetch({});
    const { invoice, approvalId } = draft({ demo: true });
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(200);
    expect(getInvoice(invoice.id)!.provider).toBe("demo");
    expect(calls).toHaveLength(0);
  });
});

describe("reminder approvals", () => {
  function reminder() {
    const client = findOrCreateClient("Acme");
    const invoice = createInvoice({
      client_id: client.id,
      currency: "USD",
      items: [{ description: "Work", quantity: 1, unit_cents: 50000 }],
      issue_date: "2026-01-01",
      due_date: "2026-01-15",
      status: "sent",
    });
    const reminderId = Number(
      db()
        .prepare(
          "INSERT INTO reminders (invoice_id, tier, days_overdue, subject, body) VALUES (?, 'firm', 10, 'Old subject', 'Old body')",
        )
        .run(invoice.id).lastInsertRowid,
    );
    const approvalId = Number(
      db()
        .prepare("INSERT INTO approvals (type, invoice_id, reminder_id, payload) VALUES ('reminder_send', ?, ?, '{}')")
        .run(invoice.id, reminderId).lastInsertRowid,
    );
    return { invoice, approvalId, reminderId };
  }

  it("edits, then approves using the edited text, and logs it", async () => {
    mockFetch({});
    const { approvalId, reminderId } = reminder();
    await json(request(app()).patch(`/api/approvals/${approvalId}`), { subject: "New subject", body: "New body" });
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`));
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("New subject");
    expect(res.body.message).toContain("New body");
    expect(res.body.message).not.toContain("Old body");
    const row = db().prepare("SELECT status FROM reminders WHERE id = ?").get(reminderId) as { status: string };
    expect(row.status).toBe("approved");
    expect(listDecisions().map((d) => d.action)).toContain("reminder_approved");
  });

  it("refuses a reminder for an invoice that has since been paid", async () => {
    mockFetch({});
    const { invoice, approvalId } = reminder();
    updateInvoice(invoice.id, { status: "paid" });
    expect((await json(request(app()).post(`/api/approvals/${approvalId}/approve`))).status).toBe(409);
  });

  it("still returns the message if PayPal can't record the reminder", async () => {
    mockFetch({ "POST /v2/invoicing/invoices/INV2-X/remind": { status: 500, json: { message: "boom" } } });
    const { invoice, approvalId } = reminder();
    updateInvoice(invoice.id, { provider: "invoicing", paypal_invoice_id: "INV2-X" });
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`));
    expect(res.status).toBe(200);
    expect(listDecisions().map((d) => d.action)).toContain("paypal_reminder_failed");
  });

  it("asks PayPal to record the reminder without emailing", async () => {
    const calls = mockFetch({ "POST /v2/invoicing/invoices/INV2-X/remind": { status: 204 } });
    const { invoice, approvalId } = reminder();
    updateInvoice(invoice.id, { provider: "invoicing", paypal_invoice_id: "INV2-X" });
    await json(request(app()).post(`/api/approvals/${approvalId}/approve`));
    expect(calls[0]!.body.send_to_recipient).toBe(false);
  });

  it("closes pending reminders when the invoice is paid", async () => {
    process.env.DEV_TOOLS = "true";
    mockFetch({});
    const { invoice, approvalId } = reminder();
    await json(request(app()).post(`/api/dev/simulate-paid/${invoice.id}`));
    expect(getApproval(approvalId)!.status).toBe("rejected");
  });
});

describe("public payment flow", () => {
  it("shows buyers the invoice without internal notes", async () => {
    const { invoice } = await sentOrdersInvoice();
    updateInvoice(invoice.id, { notes: "secret internal note" });
    const res = await request(app()).get(`/api/pay/${invoice.public_id}`);
    expect(res.status).toBe(200);
    expect(res.body.total_cents).toBe(240000);
    expect(JSON.stringify(res.body)).not.toContain("secret internal note");
    expect(res.body).not.toHaveProperty("source_text");
    expect(res.body).not.toHaveProperty("id");
  });

  it("returns 404 for an unknown link", async () => {
    mockFetch({});
    expect((await request(app()).get("/api/pay/nope")).status).toBe(404);
  });

  it("creates an order on click, captures on return and marks it paid", async () => {
    const { invoice, calls } = await sentOrdersInvoice({
      "POST /v2/checkout/orders": newOrder,
      "POST /v2/checkout/orders/ORDER1/capture": capture(),
    });
    const start = await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    expect(start.body.redirect).toBe("https://pp.test/approve");

    const back = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1&PayerID=X`);
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(`/pay/${invoice.public_id}/success`);
    expect(getInvoice(invoice.id)).toMatchObject({ status: "paid", paypal_capture_id: "CAP1" });
    expect(calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(1);
  });

  it("a repeat return doesn't capture again", async () => {
    const { invoice, calls } = await sentOrdersInvoice({
      "POST /v2/checkout/orders": newOrder,
      "POST /v2/checkout/orders/ORDER1/capture": capture(),
    });
    await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1`);
    const again = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1`);
    expect(again.headers.location).toBe(`/pay/${invoice.public_id}/success`);
    expect(calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(1);
  });

  it("refuses to capture when the returned order isn't this invoice's", async () => {
    const { invoice, calls } = await sentOrdersInvoice({ "POST /v2/checkout/orders": newOrder });
    await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    const back = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=SOMEONE_ELSES`);
    expect(back.headers.location).toContain("reason=mismatch");
    expect(calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(0);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
  });

  it("doesn't mark paid when the captured amount is wrong, and flags it", async () => {
    const { invoice } = await sentOrdersInvoice({
      "POST /v2/checkout/orders": newOrder,
      "POST /v2/checkout/orders/ORDER1/capture": capture("1.00"),
    });
    await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    const back = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1`);
    expect(back.headers.location).toContain("reason=review");
    const after = getInvoice(invoice.id)!;
    expect(after.status).toBe("sent");
    expect(after.flagged_reason).toMatch(/\$1\.00/);
  });

  it("treats a pending capture as not paid yet", async () => {
    const { invoice } = await sentOrdersInvoice({
      "POST /v2/checkout/orders": newOrder,
      "POST /v2/checkout/orders/ORDER1/capture": capture("2400.00", "PENDING"),
    });
    await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    const back = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1`);
    expect(back.headers.location).toContain("pending=1");
    expect(getInvoice(invoice.id)!.status).toBe("sent");
  });

  it("sends a declined buyer to an error page and keeps the invoice open", async () => {
    const { invoice } = await sentOrdersInvoice({
      "POST /v2/checkout/orders": newOrder,
      "POST /v2/checkout/orders/ORDER1/capture": {
        status: 422,
        json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED", description: "declined" }] },
      },
    });
    await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    const back = await request(app()).get(`/api/pay/${invoice.public_id}/return?token=ORDER1`);
    expect(back.headers.location).toContain("reason=declined");
    expect(getInvoice(invoice.id)!.status).toBe("sent");
  });

  it("handles the buyer cancelling", async () => {
    const { invoice } = await sentOrdersInvoice();
    const back = await request(app()).get(`/api/pay/${invoice.public_id}/cancel?token=ORDER1`);
    expect(back.headers.location).toBe(`/pay/${invoice.public_id}/cancelled`);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
    expect(listDecisions().map((d) => d.action)).toContain("buyer_cancelled");
  });

  it("won't take payment on a draft, a cancelled invoice, or demo data", async () => {
    mockFetch(orderRoutes);
    const { invoice } = draft();
    expect((await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`))).status).toBe(409);
    updateInvoice(invoice.id, { status: "cancelled" });
    expect((await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`))).status).toBe(409);
    updateInvoice(invoice.id, { status: "sent", is_demo: 1 });
    const demo = await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    expect(demo.status).toBe(409);
    expect(demo.body.error).toMatch(/demo/);
  });

  it("completes the payment if the order was already approved", async () => {
    const { invoice } = await sentOrdersInvoice({
      "POST /v2/checkout/orders/ORDER1/capture": capture(),
      "GET /v2/checkout/orders/ORDER1": { json: { id: "ORDER1", status: "APPROVED" } },
    });
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1" });
    const res = await json(request(app()).post(`/api/pay/${invoice.public_id}/checkout`));
    expect(res.body.redirect).toBe(`/pay/${invoice.public_id}/success`);
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });
});

describe("webhooks", () => {
  const HEADERS = {
    "PAYPAL-AUTH-ALGO": "SHA256withRSA",
    "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/cert",
    "PAYPAL-TRANSMISSION-ID": "tx-1",
    "PAYPAL-TRANSMISSION-SIG": "sig",
    "PAYPAL-TRANSMISSION-TIME": "2026-11-07T00:00:00Z",
  };
  const VERIFY = "POST /v1/notifications/verify-webhook-signature";
  const success = { json: { verification_status: "SUCCESS" } };

  const post = (raw: string, headers: Record<string, string> = HEADERS) =>
    request(app()).post("/api/webhooks/paypal").set("Content-Type", "application/json").set(headers).send(raw);

  const captureEvent = (id = "WH-1", value = "2400.00") =>
    JSON.stringify({
      id,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP9",
        status: "COMPLETED",
        amount: { currency_code: "USD", value },
        supplementary_data: { related_ids: { order_id: "ORDER1" } },
      },
    });

  async function invoiceWithOrder(routes: Parameters<typeof mockFetch>[0]) {
    const { invoice, calls } = await sentOrdersInvoice(routes);
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1" });
    return { invoice, calls };
  }

  it("sends the event back byte for byte, with all the header fields", async () => {
    const { calls } = await invoiceWithOrder({ [VERIFY]: success });
    // Unusual spacing and key order, which re-serialising would destroy.
    const raw = `{ "event_type":"OTHER.EVENT",   "id":"WH-RAW", "resource":{"z":1,"a":2.50} }`;
    await post(raw);
    const verify = calls.find((call) => call.path.endsWith("verify-webhook-signature"))!;
    expect(verify.rawBody).toContain(`"webhook_event":${raw}}`);
    expect(verify.body).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/cert",
      transmission_id: "tx-1",
      transmission_sig: "sig",
      transmission_time: "2026-11-07T00:00:00Z",
      webhook_id: "WH-TEST",
    });
  });

  it("marks the invoice paid from a verified capture event", async () => {
    const { invoice } = await invoiceWithOrder({ [VERIFY]: success });
    expect((await post(captureEvent())).status).toBe(200);
    expect(getInvoice(invoice.id)).toMatchObject({ status: "paid", paypal_capture_id: "CAP9" });
  });

  it("rejects an event that fails verification and changes nothing", async () => {
    const { invoice } = await invoiceWithOrder({ [VERIFY]: { json: { verification_status: "FAILURE" } } });
    expect((await post(captureEvent())).status).toBe(400);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
    expect(db().prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("rejects an event with no signature headers, without asking PayPal", async () => {
    const { invoice, calls } = await invoiceWithOrder({});
    expect((await post(captureEvent(), {})).status).toBe(400);
    expect(calls.some((call) => call.path.endsWith("verify-webhook-signature"))).toBe(false);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
  });

  it("won't process anything without a webhook ID", async () => {
    const { invoice } = await invoiceWithOrder({});
    process.env.PAYPAL_WEBHOOK_ID = "";
    expect((await post(captureEvent())).status).toBe(503);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
  });

  it("is idempotent: a repeated event does nothing the second time", async () => {
    const { invoice } = await invoiceWithOrder({ [VERIFY]: success });
    expect((await post(captureEvent())).body).toEqual({ ok: true });
    const decisions = listDecisions().length;
    const second = await post(captureEvent());
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(listDecisions()).toHaveLength(decisions);
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });

  it("returns an error so PayPal retries when processing fails, then succeeds", async () => {
    let fail = true;
    const { invoice } = await invoiceWithOrder({
      [VERIFY]: success,
      "POST /v2/checkout/orders/ORDER1/capture": () => {
        if (fail) {
          fail = false;
          return { status: 500, json: { message: "boom" } };
        }
        return capture();
      },
    });
    const event = JSON.stringify({ id: "WH-2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER1" } });
    // Any non-2xx makes PayPal retry the delivery.
    expect((await post(event)).status).toBe(502);
    expect(getInvoice(invoice.id)!.status).toBe("sent");
    expect((await post(event)).status).toBe(200);
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });

  it("doesn't mark paid from an event with the wrong amount", async () => {
    const { invoice } = await invoiceWithOrder({ [VERIFY]: success });
    await post(captureEvent("WH-3", "1.00"));
    const after = getInvoice(invoice.id)!;
    expect(after.status).toBe("sent");
    expect(after.flagged_reason).toBeTruthy();
  });

  it("re-reads invoice events from PayPal instead of trusting the payload", async () => {
    const { invoice } = await sentOrdersInvoice({
      [VERIFY]: success,
      "GET /v2/invoicing/invoices/INV2-Z": { json: { status: "PAID" } },
    });
    updateInvoice(invoice.id, { provider: "invoicing", paypal_invoice_id: "INV2-Z" });
    const event = JSON.stringify({ id: "WH-4", event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-Z" } });
    expect((await post(event)).status).toBe(200);
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });

  it("finds the invoice id nested under resource.invoice too", async () => {
    const { invoice } = await sentOrdersInvoice({
      [VERIFY]: success,
      "GET /v2/invoicing/invoices/INV2-Z": { json: { status: "CANCELLED" } },
    });
    updateInvoice(invoice.id, { provider: "invoicing", paypal_invoice_id: "INV2-Z" });
    await post(
      JSON.stringify({ id: "WH-5", event_type: "INVOICING.INVOICE.CANCELLED", resource: { invoice: { id: "INV2-Z" } } }),
    );
    expect(getInvoice(invoice.id)!.status).toBe("cancelled");
  });

  it.each(["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"])("leaves the invoice open on %s", async (type) => {
    const { invoice } = await invoiceWithOrder({ [VERIFY]: success });
    await post(
      JSON.stringify({
        id: `WH-${type}`,
        event_type: type,
        resource: { status: "DECLINED", supplementary_data: { related_ids: { order_id: "ORDER1" } } },
      }),
    );
    expect(getInvoice(invoice.id)!.status).toBe("sent");
    expect(listDecisions().map((d) => d.action)).toContain("payment_declined");
  });

  it("ignores events for things it doesn't know about", async () => {
    mockFetch({ [VERIFY]: success });
    const other = JSON.stringify({ id: "WH-6", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} });
    expect((await post(other)).status).toBe(200);
    expect((await post(captureEvent("WH-7"))).status).toBe(200);
  });
});

describe("reconciler", () => {
  it("marks an invoice paid from PayPal with no webhook", async () => {
    const { invoice } = await sentOrdersInvoice({ "GET /v2/checkout/orders/ORDER1": completedOrder() });
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1" });
    expect(await reconcileAll()).toEqual({ checked: 1, failed: 0 });
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });

  it("captures an order the buyer approved but never returned from", async () => {
    const { invoice } = await sentOrdersInvoice({
      "GET /v2/checkout/orders/ORDER1": { json: { status: "APPROVED" } },
      "POST /v2/checkout/orders/ORDER1/capture": capture(),
    });
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1" });
    await reconcileAll();
    expect(getInvoice(invoice.id)!.status).toBe("paid");
  });

  it("skips demo data and invoices with no PayPal object", async () => {
    const { invoice, calls } = await sentOrdersInvoice({});
    const before = calls.length;
    expect((await reconcileAll()).checked).toBe(0);
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1", is_demo: 1 });
    expect((await reconcileAll()).checked).toBe(0);
    expect(calls).toHaveLength(before);
  });

  it("keeps going when one invoice fails", async () => {
    const { invoice } = await sentOrdersInvoice({
      "GET /v2/checkout/orders/BAD": { status: 500, json: { message: "boom" } },
      "GET /v2/checkout/orders/GOOD": completedOrder(),
    });
    updateInvoice(invoice.id, { paypal_order_id: "BAD" });
    const second = draft();
    const res = await json(request(app()).post(`/api/approvals/${second.approvalId}/approve`), {
      revision: second.invoice.revision,
    });
    expect(res.status).toBe(200);
    updateInvoice(second.invoice.id, { paypal_order_id: "GOOD" });
    expect(await reconcileAll()).toEqual({ checked: 2, failed: 1 });
    expect(getInvoice(second.invoice.id)!.status).toBe("paid");
  });

  it("doesn't flag the same wrong amount every minute", async () => {
    const { invoice } = await sentOrdersInvoice({ "GET /v2/checkout/orders/ORDER1": completedOrder("1.00") });
    updateInvoice(invoice.id, { paypal_order_id: "ORDER1" });
    await reconcileAll();
    await reconcileAll();
    expect(listDecisions().filter((d) => d.action === "flagged_for_human")).toHaveLength(1);
  });
});

describe("dev tool", () => {
  it("doesn't exist by default", async () => {
    mockFetch({});
    const { invoice } = draft();
    expect((await json(request(app()).post(`/api/dev/simulate-paid/${invoice.id}`))).status).toBe(404);
  });

  it("is off in production even with DEV_TOOLS=true", async () => {
    process.env.DEV_TOOLS = "true";
    process.env.NODE_ENV = "production";
    try {
      mockFetch({});
      const { invoice } = draft();
      expect((await json(request(app()).post(`/api/dev/simulate-paid/${invoice.id}`))).status).toBe(404);
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("works only with both conditions met, and only on a sent invoice", async () => {
    process.env.DEV_TOOLS = "true";
    const { invoice } = await sentOrdersInvoice();
    const res = await json(request(app()).post(`/api/dev/simulate-paid/${invoice.id}`));
    expect(res.body.status).toBe("paid");
    const { invoice: other } = draft();
    await json(request(app()).post(`/api/dev/simulate-paid/${other.id}`));
    expect(getInvoice(other.id)!.status).toBe("draft");
  });
});

describe("access control", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "hunter2";
  });
  const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;

  it("blocks approvals without the password", async () => {
    mockFetch({});
    const { approvalId, invoice } = draft();
    const res = await json(request(app()).post(`/api/approvals/${approvalId}/approve`), {
      revision: invoice.revision,
    });
    expect(res.status).toBe(401);
    expect(getApproval(approvalId)!.status).toBe("pending");
    expect((await request(app()).get("/api/invoices").set("Authorization", basic("wrong"))).status).toBe(401);
  });

  it("allows the dashboard with the right password", async () => {
    mockFetch({});
    expect((await request(app()).get("/api/invoices").set("Authorization", basic("hunter2"))).status).toBe(200);
  });

  it("leaves buyer pages, health and webhooks reachable", async () => {
    mockFetch({});
    const { invoice } = draft();
    expect((await request(app()).get(`/api/pay/${invoice.public_id}`)).status).toBe(200);
    expect((await request(app()).get("/healthz")).status).toBe(200);
    expect((await request(app()).post("/api/webhooks/paypal").send("{}")).status).toBe(400);
  });
});

describe("cross-site protection", () => {
  it("refuses a form post to approve", async () => {
    mockFetch({});
    const { approvalId } = draft();
    const res = await request(app())
      .post(`/api/approvals/${approvalId}/approve`)
      .type("form")
      .send({ revision: "1" });
    expect(res.status).toBe(415);
    expect(getApproval(approvalId)!.status).toBe("pending");
  });
});

describe("cancelling", () => {
  it("cancels a sent PayPal invoice without emailing and closes its reminders", async () => {
    const calls = mockFetch({ "POST /v2/invoicing/invoices/INV2-C/cancel": { status: 204 } });
    const client = findOrCreateClient("Acme");
    const invoice = createInvoice({
      client_id: client.id,
      currency: "USD",
      items: [{ description: "Work", quantity: 1, unit_cents: 1000 }],
      issue_date: "2026-01-01",
      due_date: "2026-01-15",
      status: "sent",
    });
    updateInvoice(invoice.id, { provider: "invoicing", paypal_invoice_id: "INV2-C" });
    const res = await json(request(app()).post(`/api/invoices/${invoice.id}/cancel`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(calls[0]!.body.send_to_recipient).toBe(false);
    expect(listApprovals("pending")).toHaveLength(0);
  });

  it("refuses to cancel a draft", async () => {
    mockFetch({});
    const { invoice } = draft();
    expect((await json(request(app()).post(`/api/invoices/${invoice.id}/cancel`))).status).toBe(409);
  });
});

describe("status endpoint", () => {
  it("reports the active mode and why, without secrets", async () => {
    mockFetch(orderRoutes);
    await refreshProviderState();
    const res = await request(app()).get("/api/status");
    expect(res.body.provider.mode).toBe("orders");
    expect(res.body.provider.reason).toMatch(/403/);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("test-client-secret");
    expect(text).not.toContain("test-groq-key");
  });
});
