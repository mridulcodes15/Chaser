import { getConfig } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { seedDemoData } from "./seed.js";

const config = getConfig();
initDb(config.DATABASE_PATH);
const { invoices } = seedDemoData();
closeDb();
console.log(`Seeded ${invoices} demo invoices into ${config.DATABASE_PATH}. Real invoices were left alone.`);
