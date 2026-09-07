import { chromium } from "playwright";
import { pool } from "./lib/db.js";
import path from "node:path";
const EXT = path.resolve("../extension");
const ctx = await chromium.launchPersistentContext(
  "C:/Users/Debasish Sadangi/AppData/Local/Temp/claude/tv-q1-" + Date.now(),
  { headless:false, args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`],
    viewport:{width:1400,height:950} });
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker",{timeout:20000});
await sw.evaluate(async () => { await chrome.storage.local.set({ apiBase:"http://localhost:3101",
  token:"tv_ext_9f3b2c7a41e84d6fb05e2a8c17d94f60", concurrency:3 }); });
// Exactly what the dashboard sends for "DAF XF 106.480".
const { jobId } = await (await fetch("http://localhost:3101/api/search-jobs",{method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({requirements:{make:"daf",model:"XF 480",yearMin:2020,yearMax:2021,priceMax:32000,currency:"EUR"},
  sources:["otomoto","autoline","truckscout24","olx_pl"]})})).json();
console.log("job",jobId);
for (let i=0;i<60;i++){
  await new Promise(r=>setTimeout(r,5000));
  const j=await (await fetch(`http://localhost:3101/api/search-jobs/${jobId}`)).json();
  if (j.status!=="running"){ console.log("done. listings:",j.progress.listings); break; }
}
const { rows } = await pool.query(
  `SELECT source_id, manufacturer, model, normalized_model, year, price_eur, original_title
     FROM job_listings WHERE job_id=$1 AND matched ORDER BY source_id, price_eur LIMIT 40`, [jobId]);
console.log("\n--- MATCHED rows (what the user sees) ---");
rows.forEach(r=>console.log(`${String(r.source_id).padEnd(13)}| ${String(r.manufacturer||"-").padEnd(6)} ${String(r.model||"-").slice(0,16).padEnd(16)}| norm=${String(r.normalized_model||"-").padEnd(10)}| ${String(r.year||"-").padEnd(5)}| ${String(r.price_eur||"-").padEnd(7)}| ${String(r.original_title||"").slice(0,42)}`));
console.log("\njobId for follow-up:", jobId);
await pool.end(); await ctx.close();
