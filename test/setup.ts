import { afterEach, beforeEach, vi } from "vitest";
import { closeDb, initDb } from "../src/db.js";

// Every test gets a fresh in-memory DB, fixed fake settings, and a fetch that
// throws, so a test can never reach a real API unless it installs its own mock.
beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "test-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
  process.env.PAYPAL_WEBHOOK_ID = "WH-TEST";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.GROQ_MODEL = "test-model";
  process.env.LLM_PROVIDER = "groq";
  process.env.LLM_BACKOFF_BASE_MS = "0";
  process.env.PAYMENT_PROVIDER = "auto";
  process.env.PUBLIC_BASE_URL = "http://chaser.test";
  delete process.env.DEV_TOOLS;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.PAYPAL_BASE_URL;
  initDb(":memory:");
  vi.stubGlobal("fetch", async (url: unknown) => {
    throw new Error(`Unexpected network call in test: ${String(url)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
});
