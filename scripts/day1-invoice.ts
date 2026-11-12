// Day 1: create one PayPal SANDBOX invoice, and send it only if a recipient is given.
//
//   npm run day1                      -> creates a DRAFT, sends nothing
//   npm run day1 -- --to buyer@x.com  -> creates the invoice and sends it to buyer@x.com
//
// Endpoints checked against developer.paypal.com/docs/api/invoicing/v2/

// Hard-coded on purpose: this script must never be able to reach live PayPal.
const BASE_URL = "https://api-m.sandbox.paypal.com";

class PayPalError extends Error {}

function loadCredentials(): { clientId: string; clientSecret: string } {
  try {
    process.loadEnvFile(".env");
  } catch {
    throw new PayPalError("Could not load .env from the current folder.");
  }
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const missing = [
    !clientId && "PAYPAL_CLIENT_ID",
    !clientSecret && "PAYPAL_CLIENT_SECRET",
  ].filter(Boolean);
  if (!clientId || !clientSecret) {
    throw new PayPalError(`Missing from .env: ${missing.join(", ")}`);
  }
  return { clientId, clientSecret };
}

function parseRecipient(argv: string[]): string | undefined {
  const index = argv.indexOf("--to");
  if (index === -1) return undefined;
  const email = argv[index + 1];
  if (!email || !email.includes("@")) {
    throw new PayPalError("--to needs an email address.");
  }
  return email;
}

// Prints PayPal's error fields only. Never includes request headers or credentials.
async function failure(step: string, res: Response): Promise<PayPalError> {
  const text = await res.text();
  let detail = text;
  try {
    detail = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: keep the raw text.
  }
  return new PayPalError(`${step} failed: HTTP ${res.status}\n${detail}`);
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw await failure("OAuth token request", res);
  const data = (await res.json()) as { access_token: string; scope?: string };
  if (!data.scope?.includes("invoicing")) {
    console.warn("Warning: the token's scopes do not mention invoicing.");
  }
  return data.access_token;
}

async function createDraft(token: string, recipient?: string): Promise<string> {
  const body = {
    // invoice_date is left out so PayPal uses its own current date. A local date
    // can be ahead of PayPal's, and a future date schedules the send.
    detail: {
      currency_code: "USD",
      note: "Chaser Day 1 sandbox test invoice.",
      payment_term: { term_type: "NET_15" },
    },
    ...(recipient && {
      primary_recipients: [{ billing_info: { email_address: recipient } }],
    }),
    items: [
      {
        name: "March brand work (sandbox test)",
        quantity: "1",
        unit_amount: { currency_code: "USD", value: "2400.00" },
      },
    ],
  };
  const res = await fetch(`${BASE_URL}/v2/invoicing/invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure("Create invoice", res);
  const data = (await res.json()) as { id?: string; href?: string };
  // The docs only specify the body for return=representation, so also accept an href.
  const id = data.id ?? data.href?.split("/").pop();
  if (!id) throw new PayPalError("Create invoice returned no invoice ID.");
  return id;
}

async function sendInvoice(token: string, id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/v2/invoicing/invoices/${id}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ send_to_recipient: true, send_to_invoicer: true }),
  });
  if (!res.ok) throw await failure("Send invoice", res);
}

async function getStatus(token: string, id: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/v2/invoicing/invoices/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await failure("Get invoice", res);
  const data = (await res.json()) as { status: string };
  return data.status;
}

async function main(): Promise<void> {
  const recipient = parseRecipient(process.argv.slice(2));
  const { clientId, clientSecret } = loadCredentials();

  const token = await getAccessToken(clientId, clientSecret);
  console.log("Authenticated with PayPal sandbox.");

  const id = await createDraft(token, recipient);
  console.log(`Created invoice: ${id}`);

  if (recipient) {
    await sendInvoice(token, id);
    console.log(`Sent invoice to: ${recipient}`);
  } else {
    console.log("No --to recipient given, so the invoice was NOT sent.");
  }

  console.log(`Status: ${await getStatus(token, id)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof PayPalError ? err.message : err);
  process.exitCode = 1;
});
