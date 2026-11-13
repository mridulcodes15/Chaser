import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { initDb } from "./db.js";
import { startJobs } from "./jobs.js";
import { refreshProviderState } from "./payments/manager.js";
import { seedIfEmpty } from "./seed.js";

const config = getConfig();
initDb(config.DATABASE_PATH);

if (config.seedDemo && seedIfEmpty()) console.log("Database was empty, so demo data was seeded.");

// Runs in the background so a slow PayPal can't hold up startup. Sends wait for the result.
void refreshProviderState().then((state) => {
  console.log(`Payment mode: ${state.mode}. ${state.reason}`);
});

createApp().listen(config.PORT, () => {
  console.log(`Chaser is running on port ${config.PORT} (public URL: ${config.publicBaseUrl}). PayPal sandbox only.`);
});
startJobs();
