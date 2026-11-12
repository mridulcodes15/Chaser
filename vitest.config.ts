import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // NODE_ENV=test stops config.ts from loading the real .env, so no test can
    // ever reach PayPal or Groq with real credentials.
    env: { NODE_ENV: "test" },
    setupFiles: ["test/setup.ts"],
  },
});
