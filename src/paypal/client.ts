import { getConfig, PAYPAL_SANDBOX_BASE_URL } from "../config.js";

const TIMEOUT_MS = 20_000;

/** A failed PayPal call. Holds PayPal's error fields, never credentials or tokens. */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string | undefined,
    readonly debugId: string | undefined,
    readonly issue: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export class PayPalNotConfiguredError extends Error {
  constructor() {
    super("PayPal sandbox credentials are not configured.");
    this.name = "PayPalNotConfiguredError";
  }
}

let cachedToken: { value: string; expiresAt: number } | undefined;

export function resetPayPalTokenCache(): void {
  cachedToken = undefined;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = getConfig();
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new PayPalNotConfiguredError();

  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await toError(res, "OAuth token request");
  const data = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so a token can't expire in the middle of a request.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(data.expires_in - 60, 0) * 1000,
  };
  return cachedToken.value;
}

async function toError(res: Response, step: string): Promise<PayPalApiError> {
  const text = await res.text();
  let parsed: {
    name?: string;
    error?: string;
    debug_id?: string;
    message?: string;
    error_description?: string;
    details?: { issue?: string; description?: string }[];
  } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON. The status code is still reported below.
  }
  const detail = parsed.details?.[0];
  const reason =
    detail?.description ?? parsed.message ?? parsed.error_description ?? "no details returned";
  return new PayPalApiError(
    res.status,
    parsed.name ?? parsed.error,
    parsed.debug_id,
    detail?.issue,
    `${step} failed (HTTP ${res.status}): ${reason}`,
  );
}

export interface PayPalRequest {
  method: "GET" | "POST" | "DELETE";
  /** Always a path. A full URL is refused, so requests can only reach the sandbox host. */
  path: string;
  body?: unknown;
  /** Sent exactly as given. Webhook verification needs this to keep the raw event body. */
  rawBody?: string;
  headers?: Record<string, string>;
  step: string;
}

export async function paypalRequest<T = unknown>(request: PayPalRequest): Promise<T> {
  if (!request.path.startsWith("/")) {
    throw new Error("PayPal requests must use a path on the sandbox host.");
  }
  const send = async (): Promise<Response> =>
    fetch(`${PAYPAL_SANDBOX_BASE_URL}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        ...(request.body !== undefined || request.rawBody !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...request.headers,
      },
      body: request.rawBody ?? (request.body !== undefined ? JSON.stringify(request.body) : undefined),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let res = await send();
  if (res.status === 401) {
    // The cached token may have been invalidated early. Get a new one and retry once.
    resetPayPalTokenCache();
    res = await send();
  }
  if (!res.ok) throw await toError(res, request.step);

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}
