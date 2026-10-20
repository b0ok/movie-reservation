import { openDb } from './db.js';
import { createApp, ensureAdmin } from './app.js';
import { startDemandSimulator } from './simulator.js';

try { process.loadEnvFile(); } catch { /* .env is optional */ }

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set (copy .env.example to .env)');
  process.exit(1);
}

const db = openDb();
ensureAdmin(db);
if (process.env.SIMULATE_DEMAND !== 'false') startDemandSimulator(db);
const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`Movie reservation API listening on http://localhost:${port}`));
