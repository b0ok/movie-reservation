import { openDb } from './db.js';
import { createApp, ensureAdmin, ensureDemoUser } from './app.js';
import { startDemandSimulator } from './simulator.js';
import { startDemoReset } from './demo.js';

try { process.loadEnvFile(); } catch { /* .env is optional */ }

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set (copy .env.example to .env)');
  process.exit(1);
}
// The example secret is public in the repo, so anyone could forge an admin token with it.
if (process.env.JWT_SECRET === 'change-me-to-a-long-random-string' || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is the example value or too short; set a long random one (see .env.example)');
  process.exit(1);
}

const db = openDb();
ensureAdmin(db);
ensureDemoUser(db);
startDemoReset(db);
if (process.env.SIMULATE_DEMAND !== 'false') startDemandSimulator(db);
const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`Movie reservation API listening on http://localhost:${port}`));
