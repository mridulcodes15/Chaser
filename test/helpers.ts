import { vi } from "vitest";
import { resetPayPalTokenCache } from "../src/paypal/client.js";
import { resetProviderState } from "../src/payments/manager.js";

export interface MockCall {
  method: string;
  url: string;
  path: string;
  body: any;
  rawBody: string | undefined;
  headers: Record<string, string>;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = (call: MockCall) => Reply | Promise<Reply>;

/**
 * Replaces global fetch with a router. Keys look like "POST /v2/checkout/orders".
 * The PayPal OAuth call is answered automatically. An unrouted call fails the test.
 */
export function mockFetch(routes: Record<string, Handler | Reply>) {
  resetPayPalTokenCache();
  resetProviderState();
  const calls: MockCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const parsed = new URL(input);
    const method = init.method ?? "GET";
    const key = `${method} ${parsed.pathname}`;
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    let body: any;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const call: MockCall = {
      method,
      url: input,
      path: parsed.pathname,
      body,
      rawBody,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    if (key === "POST /v1/oauth2/token") {
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    calls.push(call);
    const route = routes[key];
    if (!route) throw new Error(`No mock route for ${key}`);
    const reply = typeof route === "function" ? await route(call) : route;
    const status = reply.status ?? 200;
    const payload = reply.json === undefined || status === 204 ? null : JSON.stringify(reply.json);
    return new Response(payload, { status, headers: reply.headers });
  });
  return calls;
}

export const NOT_AUTHORIZED: Reply = {
  status: 403,
  json: {
    name: "NOT_AUTHORIZED",
    debug_id: "dbg403",
    message: "Authorization failed due to insufficient permissions.",
    details: [{ issue: "NOT_AUTHORIZED", description: "Authorization failed due to insufficient permissions." }],
  },
};
