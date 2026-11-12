# Chaser: AI invoicing & collections agent (PayPal x AI hackathon)

## What this is
A web app where a freelancer describes work in plain language ("Bill Acme $2,400
for March brand work, net 15") or pastes an email/contract. An LLM extracts the
details and drafts a PayPal invoice. The user approves it, it is sent via the
PayPal Invoicing API, and PayPal webhooks track payment status. For overdue
invoices the LLM drafts escalating reminders, which also need user approval.

## Hard requirements (hackathon)
- PayPal integration is central (Invoicing API + webhooks), SANDBOX ONLY.
- AI does real work: extraction, next-action decisions, reminder writing.
- Must run: clear README setup instructions AND deployable to a hosted URL.
- Public open-source repo with LICENSE. Never commit secrets.

## Stack
- TypeScript, Node, Express, SQLite (better-sqlite3), simple Vite + React frontend.
- LLM calls go through ONE wrapper (src/llm/index.ts) with a provider switch
  via env LLM_PROVIDER=groq|anthropic. Use JSON-schema-validated outputs (zod),
  with retry on invalid JSON.

## Rules
- NEVER run git commit, add, push, reset, checkout, rebase, or merge. The human
  handles all git. Read-only git (status, diff, log) is fine.
- NEVER create or edit .env with real secrets. Maintain .env.example only.
- Nothing money-related is ever sent without an explicit human approval step.
- Verify PayPal endpoints and payloads against official PayPal developer docs
  before coding them. Do not guess endpoint shapes.
- Overdue status is computed locally from due dates, not assumed from a webhook.
- Keep changes small. Explain what you changed after each task.
- Write tests for money-moving paths (invoice create/send, webhook handling).

## Roadmap
The app was built in one pass. See PROGRESS.md for current status and next steps.
1. Scaffold, database, config
2. PayPal clients, capability check, Invoicing and Orders providers
3. LLM wrapper, extraction, agent tools
4. Approval and invoice flows
5. Webhooks, reconciler, collections
6. Frontend
7. Seed data and tests
8. Docs and Render config
9. Deploy, demo video, submit (human)
