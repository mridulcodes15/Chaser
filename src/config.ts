import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Hard-coded on purpose. There is no setting that can point Chaser at live PayPal.
export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const ALLOWED_CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Currency = (typeof ALLOWED_CURRENCIES)[number];

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: optionalString,
  RENDER_EXTERNAL_URL: optionalString,
  DATABASE_PATH: z.string().default("data/chaser.sqlite"),
  ADMIN_PASSWORD: optionalString,

  PAYMENT_PROVIDER: z.enum(["auto", "invoicing", "orders"]).default("auto"),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYPAL_BASE_URL: optionalString,

  LLM_PROVIDER: z.enum(["groq", "anthropic"]).default("groq"),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: optionalString,
  LLM_BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(1000),

  MAX_INVOICE_AMOUNT: z.coerce.number().positive().default(100000),
  MAX_LINE_ITEMS: z.coerce.number().int().positive().default(20),
  LARGE_AMOUNT_THRESHOLD: z.coerce.number().positive().default(10000),
  VERY_OVERDUE_DAYS: z.coerce.number().int().positive().default(60),

  DEV_TOOLS: optionalString,
  SEED_DEMO: optionalString,
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  COLLECTIONS_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof envSchema> & {
  publicBaseUrl: string;
  paypalConfigured: boolean;
  devToolsEnabled: boolean;
  seedDemo: boolean;
};

let dotenvLoaded = false;

/** Reads settings from the environment each call. Values are never logged. */
export function getConfig(): Config {
  if (!dotenvLoaded && process.env.NODE_ENV !== "test") {
    loadDotenv({ quiet: true });
    dotenvLoaded = true;
  }
  const env = envSchema.parse(process.env);

  if (env.PAYPAL_BASE_URL && env.PAYPAL_BASE_URL !== PAYPAL_SANDBOX_BASE_URL) {
    throw new Error(
      `Refusing to start: PAYPAL_BASE_URL must be unset or ${PAYPAL_SANDBOX_BASE_URL}. Chaser is sandbox only.`,
    );
  }

  const publicBaseUrl = (
    env.PUBLIC_BASE_URL ??
    env.RENDER_EXTERNAL_URL ??
    `http://localhost:${env.PORT}`
  ).replace(/\/+$/, "");

  return {
    ...env,
    publicBaseUrl,
    paypalConfigured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    // Both conditions are required: production can never enable dev tools.
    devToolsEnabled: env.NODE_ENV !== "production" && env.DEV_TOOLS === "true",
    seedDemo: env.SEED_DEMO === "true",
  };
}
