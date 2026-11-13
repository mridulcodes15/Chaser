import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { runAgent } from "./agent/index.js";
import { getConfig } from "./config.js";
import { LlmError } from "./llm/index.js";
import { getProviderState, refreshProviderState } from "./payments/manager.js";
import { PayPalApiError, PayPalNotConfiguredError } from "./paypal/client.js";
import {
  ApprovalError,
  approveInvoiceSend,
  approveReminder,
  cancelInvoice,
  clearFlag,
  editReminder,
  rejectApproval,
} from "./services/approvals.js";
import {
  CheckoutError,
  handleCancel,
  handleReturn,
  publicInvoice,
  startCheckout,
} from "./services/checkout.js";
import { runCollections } from "./services/collections.js";
import { DraftError, draftFieldsSchema, updateDraft } from "./services/drafts.js";
import { pendingApprovalCount, summarizeReceivables } from "./services/reports.js";
import { applyStatus, reconcileInvoice } from "./services/settlement.js";
import { handleWebhook } from "./services/webhooks.js";
import {
  decisionsForInvoice,
  getApproval,
  getInvoiceView,
  getReminder,
  listApprovals,
  listDecisions,
  listInvoices,
  remindersForInvoice,
  type ApprovalRow,
  type InvoiceFilter,
} from "./store.js";

/**
 * A plain cross-site form can't send JSON, so requiring it stops another website
 * from submitting an Approve on the user's behalf. Webhooks are verified separately.
 */
function requireJson(req: Request, res: Response, next: NextFunction): void {
  const safe = req.method === "GET" || req.method === "HEAD";
  if (safe || !req.path.startsWith("/api/") || req.path === "/api/webhooks/paypal") return next();
  if (!req.is("application/json")) {
    res.status(415).json({ error: "This endpoint only accepts application/json." });
    return;
  }
  next();
}

function intParam(req: Request, name: string): number {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) throw new ApprovalError("That ID isn't valid.", 400);
  return value;
}

function approvalView(approval: ApprovalRow) {
  return {
    ...approval,
    payload: JSON.parse(approval.payload) as unknown,
    invoice: getInvoiceView(approval.invoice_id),
    reminder: approval.reminder_id ? getReminder(approval.reminder_id) : undefined,
  };
}

const chatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(40),
});

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // No login for the hackathon demo. ADMIN_PASSWORD is read by config but not enforced.

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // This must come before express.json: signature checks need the exact raw bytes.
  app.post("/api/webhooks/paypal", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const result = await handleWebhook(req.headers, raw);
    res.status(result.status).json(result.body);
  });

  app.use(requireJson);
  app.use(express.json({ limit: "200kb" }));

  // --- Status and dashboard ---

  app.get("/api/status", async (_req, res) => {
    const config = getConfig();
    res.json({
      provider: await getProviderState(),
      llm_configured: Boolean(config.LLM_PROVIDER === "groq" && config.GROQ_API_KEY && config.GROQ_MODEL),
      webhook_configured: Boolean(config.PAYPAL_WEBHOOK_ID),
      dev_tools: config.devToolsEnabled,
      pending_approvals: pendingApprovalCount(),
    });
  });

  app.post("/api/provider/recheck", async (_req, res) => {
    res.json(await refreshProviderState());
  });

  app.get("/api/dashboard", (_req, res) => {
    res.json({
      totals: summarizeReceivables(),
      pending_approvals: pendingApprovalCount(),
      activity: listDecisions(12),
    });
  });

  // --- Agent ---

  app.post("/api/agent/chat", async (req, res) => {
    const { messages } = chatBody.parse(req.body);
    res.json(await runAgent(messages));
  });

  // --- Approvals: the only routes that can make anything leave the system ---

  app.get("/api/approvals", (_req, res) => {
    res.json({
      pending: listApprovals("pending").map(approvalView),
      flagged: listInvoices("all").filter((invoice) => invoice.flagged_reason && invoice.status === "sent"),
    });
  });

  app.post("/api/approvals/:id/approve", async (req, res) => {
    const id = intParam(req, "id");
    const approval = getApproval(id);
    if (!approval) throw new ApprovalError("That approval doesn't exist.", 404);
    if (approval.type === "invoice_send") {
      const { revision } = z.object({ revision: z.number().int() }).parse(req.body);
      res.json(await approveInvoiceSend(id, revision));
    } else {
      res.json(await approveReminder(id));
    }
  });

  app.post("/api/approvals/:id/reject", (req, res) => {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    res.json(rejectApproval(intParam(req, "id"), reason));
  });

  app.patch("/api/approvals/:id", (req, res) => {
    const { subject, body } = z
      .object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(4000) })
      .parse(req.body);
    const id = intParam(req, "id");
    editReminder(id, subject, body);
    res.json(approvalView(getApproval(id)!));
  });

  // --- Invoices ---

  app.get("/api/invoices", (req, res) => {
    const filter = z
      .enum(["draft", "sent", "overdue", "paid", "all"])
      .catch("all")
      .parse(req.query.filter) as InvoiceFilter;
    res.json({ invoices: listInvoices(filter) });
  });

  app.get("/api/invoices/:id", (req, res) => {
    const id = intParam(req, "id");
    const invoice = getInvoiceView(id);
    if (!invoice) throw new ApprovalError("That invoice doesn't exist.", 404);
    const pending = listApprovals("pending").filter((approval) => approval.invoice_id === id);
    res.json({
      invoice,
      reminders: remindersForInvoice(id),
      timeline: decisionsForInvoice(id),
      pending_approvals: pending.map(approvalView),
    });
  });

  // A human edit, so the amount-must-be-in-the-source rule doesn't apply. The limits do.
  app.patch("/api/invoices/:id", (req, res) => {
    // updateDraft re-checks the merged result against the full rules, including the total limit.
    const changes = draftFieldsSchema().partial().parse(req.body);
    res.json(
      updateDraft(intParam(req, "id"), changes, { actor: "human", reasoning: "A human edited this draft." }),
    );
  });

  app.post("/api/invoices/:id/cancel", async (req, res) => {
    res.json(await cancelInvoice(intParam(req, "id")));
  });

  app.post("/api/invoices/:id/clear-flag", (req, res) => {
    res.json(clearFlag(intParam(req, "id")));
  });

  app.post("/api/invoices/:id/refresh", async (req, res) => {
    const id = intParam(req, "id");
    await reconcileInvoice(id, "reconciler");
    res.json(getInvoiceView(id));
  });

  // --- Collections and decision log ---

  app.post("/api/collections/run", async (_req, res) => {
    res.json(await runCollections("manual"));
  });

  app.get("/api/decisions", (_req, res) => {
    res.json({ decisions: listDecisions(300) });
  });

  // --- Public payment flow, reached by buyers with no password ---

  app.get("/api/pay/:publicId", (req, res) => {
    res.json(publicInvoice(req.params.publicId));
  });

  app.post("/api/pay/:publicId/checkout", async (req, res) => {
    res.json(await startCheckout(req.params.publicId));
  });

  app.get("/api/pay/:publicId/return", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    res.redirect(303, await handleReturn(req.params.publicId, token));
  });

  app.get("/api/pay/:publicId/cancel", (req, res) => {
    res.redirect(303, handleCancel(req.params.publicId));
  });

  // --- Dev tool: does not exist unless NODE_ENV != production AND DEV_TOOLS=true ---

  app.post("/api/dev/simulate-paid/:id", (req, res) => {
    if (!getConfig().devToolsEnabled) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const id = intParam(req, "id");
    const invoice = getInvoiceView(id);
    if (!invoice) throw new ApprovalError("That invoice doesn't exist.", 404);
    applyStatus(
      id,
      { state: "paid", raw: "DEV_SIMULATED", paidCents: invoice.total_cents, paidCurrency: invoice.currency },
      "dev_tool",
    );
    res.json(getInvoiceView(id));
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // --- The built frontend. One service serves everything. ---

  const webDir = resolve("dist/web");
  if (existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(resolve(webDir, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: z.prettifyError(error) });
    } else if (error instanceof ApprovalError || error instanceof CheckoutError) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof DraftError) {
      res.status(422).json({ error: error.message });
    } else if (error instanceof LlmError) {
      res.status(error.kind === "rate_limited" ? 429 : 503).json({ error: error.message, kind: error.kind });
    } else if (error instanceof PayPalNotConfiguredError) {
      res.status(503).json({ error: error.message });
    } else if (error instanceof PayPalApiError) {
      res.status(502).json({
        error: error.message,
        paypal: { name: error.errorName, issue: error.issue, debug_id: error.debugId },
      });
    } else {
      console.error("Unhandled error:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Something went wrong." });
    }
  });

  return app;
}
