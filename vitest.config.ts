import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // NODE_ENV=test stops config.ts from loading the real .env, so no test can
    // ever reach PayPal or Groq with real credentials. A test that switches
    // NODE_ENV (the production check) would load it, so dotenv is also pointed
    // at a file that doesn't exist.
    env: { NODE_ENV: "test", DOTENV_CONFIG_PATH: "test/no-such-env-file" },
    setupFiles: ["test/setup.ts"],
  },
});
