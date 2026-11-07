import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const jwtSecret = process.env.JWT_SECRET;

// Fail fast: running with a guessable signing secret would let anyone forge tokens.
if (!jwtSecret || jwtSecret.length < 16) {
  console.error('JWT_SECRET must be set to a random string of at least 16 characters.');
  process.exit(1);
}

const hops = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(hops) || hops < 0) {
  console.error('TRUST_PROXY must be a non-negative integer (number of proxies in front of the app).');
  process.exit(1);
}

const db = openDb();
const server = createApp(db, { jwtSecret, trustProxy: hops || false }).listen(port, () => {
  console.log(`Expense tracker API listening on port ${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
