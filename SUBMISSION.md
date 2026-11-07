# Chaser: hackathon submission

## Project description

Freelancers lose money twice: once on the admin of invoicing, and again on the awkward job of chasing late payers. Chaser is an AI agent that does both, while a person stays in charge of anything that goes out.

## Live Demo

**URL:** https://chaser-9d4o.onrender.com

**Login:** the app is protected by a basic auth popup.
- Username: anything (not checked)
- Password: `chaser-demo-2026`

This is a sandbox-only demo — no real PayPal accounts or real money are
involved — so sharing the password here is safe.

**Note on PayPal mode:** this sandbox app doesn't have Invoicing permission
enabled, so the app automatically falls back to PayPal Orders with its own
payment page. You'll see a banner in the dashboard confirming this. This is
expected, automatic behavior — not an error — and demonstrates the app's
capability detection and graceful fallback.

**To see the full payment flow:** open any invoice from the Invoices page,
click **Open payment link**, and complete checkout using a PayPal sandbox
buyer account.

Full setup, architecture, and local run instructions: see [README.md](README.md).

### Features and functionality

- **Plain-language invoicing:** type a one-liner or paste a messy email or contract, and the agent extracts a structured draft. If the amount or client is missing, it asks.
- **Approval queue:** every invoice and reminder waits for a human click. You can approve, edit or reject.
- **Two PayPal integrations behind one interface:**
  - **Invoicing API v2**, when the sandbox app has the permission.
  - **Orders API v2**, with a hosted `/pay/:id` page, buyer redirect and capture.
  - A startup check picks the mode automatically, falls back on a 403, and tells you why in a banner.
- **Live payment status:** signature-verified, idempotent PayPal webhooks, plus a reconciler that checks PayPal every 60 seconds.
- **Collections agent:** finds overdue invoices, then drafts a friendly, firm or final-notice reminder. Code picks the tier from the due date, and the AI writes the words.
- **Risk flags:** large amounts, very overdue invoices, previous disputes and promises to pay go to the human instead of getting a demand-style message.
- **Decision log:** each decision is recorded with its reasoning and shown in the UI.
- **Safeguards that don't rely on the model:**
  - The agent has no tool that can send anything.
  - Amounts must come from what the user typed.
  - Reminder text can't state a different amount or contain links.
  - A payment only counts if the amount matches.
- **Copyable messages:** Chaser produces a link and message for you to share. It doesn't send email or SMS.

## Tools used

| Tool | How it's used |
|---|---|
| **Groq** (OpenAI-compatible API, model set by `GROQ_MODEL`) | Extraction, tool-calling agent, reminder writing, and deciding when to flag a human |
| **PayPal Invoicing API v2** | Create, send, get, remind, cancel and delete invoices, plus the capability check |
| **PayPal Orders API v2** | Create and capture orders for the hosted payment page |
| **PayPal Webhooks API** | Verifying webhook signatures with verify-webhook-signature |
| **TypeScript and Node.js** | The whole app |
| **Express** | API server, which also serves the built frontend as one service |
| **better-sqlite3** | Clients, invoices, approvals, reminders, events, decision log and settings |
| **zod** | Validating all LLM output, tool arguments and API input, and generating tool schemas |
| **dotenv** | Loading local configuration |
| **Vite and React** | The frontend |
| **lucide-react** | Interface icons |
| **IBM Plex Sans and Mono** (Fontsource) | Self-hosted type, with monospaced figures for money |
| **Vitest and Supertest** | Tests, with PayPal and the LLM mocked |
| **Render** | Hosting through `render.yaml` |
| **Claude Code** | Used to help build the project |

## Demo video - coming soon
