// Shared Postgres pool for the standalone scraper. DATABASE_URL must point at
// the SAME database the TruckVal web app uses, so scraped rows land in the same
// truck_listings table.
//
// Railway's *internal* host (…​.railway.internal) speaks plain TCP (no SSL); the
// *public* proxy host requires SSL with a non-publicly-trusted cert. Pick per
// host so this works both from inside Railway and from a local machine — same
// logic as the web app's server/db.js.
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. on Railway, where env vars are injected directly)
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

const connectionString = process.env.DATABASE_URL;
const isInternal = /\.railway\.internal(:|\/|$)/.test(connectionString);

export const pool = new Pool({
  connectionString,
  ssl: isInternal ? false : { rejectUnauthorized: false },
});
