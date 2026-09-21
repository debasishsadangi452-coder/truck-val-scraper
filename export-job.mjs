// Same query, same filter, same INSERT/ON CONFLICT as the dashboard's
// POST /api/search-jobs/:id/export route — run directly because that route is
// behind a super-admin session login.
import { pool } from "./lib/db.js";
import { normalizeModel } from "./lib/normalize-model.js";

const JOB = process.argv[2];
const r = await pool.query(
  `SELECT source_id, source_listing_id, url, original_title, manufacturer,
          model, normalized_model, year, mileage_km, price_amount, currency,
          country, city, seller, fuel_type, thumbnail_url
     FROM job_listings WHERE job_id=$1`,
  [JOB],
);
const rows = r.rows;
const usable = rows.filter((x) => x.source_listing_id && x.url && String(x.manufacturer || "").trim());
let exported = 0;
for (const x of usable) {
  await pool.query(
    `INSERT INTO truck_listings (source, source_id, url, title, make, model,
       model_normalized, year, mileage_km, price_amount, price_currency,
       country_origin, city, seller_name, fuel_type, thumbnail_url, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (source, source_id) DO UPDATE SET
       price_amount=EXCLUDED.price_amount, price_currency=EXCLUDED.price_currency,
       mileage_km=EXCLUDED.mileage_km, updated_at=now()`,
    [x.source_id, x.source_listing_id, x.url, x.original_title || null,
     x.manufacturer || null, x.model || null,
     x.normalized_model || normalizeModel(x.manufacturer, x.model),
     x.year ?? null, x.mileage_km ?? null, x.price_amount ?? null,
     x.currency || null, x.country || null, x.city || null, x.seller || null,
     x.fuel_type || null, x.thumbnail_url || null],
  );
  exported++;
}
console.log(JSON.stringify({ ok: true, exported, total: rows.length, skipped: rows.length - usable.length }));
await pool.end();
