import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext(
  "C:/Users/Debasish Sadangi/AppData/Local/Temp/claude/tv-inv2-" + Date.now(),
  { headless:false, viewport:{width:1300,height:840} });
const p = await ctx.newPage();
const RX="truck|lkw|camion|vrachtwagen|occasion|used|stock|gebraucht|voorraad|aanbod|vehicles|search|kamion|veicoli|usato";
async function probe(name, home) {
  const out={name,verdict:"?",url:"",prices:0,kms:0};
  try{
    await p.goto(home,{waitUntil:"domcontentloaded",timeout:22000}); await p.waitForTimeout(5000);
    let html=await p.content();
    if(/challenge-platform|Just a moment|Checking your browser/i.test(html)){out.verdict="GATED";return out;}
    const meas=()=>p.evaluate(()=>({p:(document.body.innerText.match(/(?:€|EUR|£|zł|Kč|лв|грн|RSD)\s?\d[\d\s.,]{2,}|\d[\d\s.,]{2,}\s?(?:€|EUR|£)/g)||[]).length,
      k:(document.body.innerText.match(/\d[\d\s.,]{2,}\s*(?:km|miles)/gi)||[]).length}));
    let m=await meas(); if(m.p>=6){Object.assign(out,{verdict:"GOOD",url:p.url(),prices:m.p,kms:m.k});return out;}
    const links=await p.evaluate((rx)=>{const re=new RegExp(rx,"i");
      return [...new Set(Array.from(document.querySelectorAll("a[href]")).map(a=>a.href))]
        .filter(h=>re.test(h)&&!/login|cookie|privacy|contact|about|impressum|career|blog|news|mailto|tel:/i.test(h)).slice(0,3);},RX);
    for(const u of links){
      await p.goto(u,{waitUntil:"domcontentloaded",timeout:22000}); await p.waitForTimeout(6500);
      html=await p.content();
      if(/challenge-platform|Just a moment|Checking your browser/i.test(html)){out.verdict="GATED";out.url=u;return out;}
      m=await meas(); if(m.p>=6){Object.assign(out,{verdict:"GOOD",url:u,prices:m.p,kms:m.k});return out;}
      out.prices=Math.max(out.prices,m.p); out.url=u;
    }
    out.verdict=out.prices>0?"thin":"none";
  }catch(e){out.verdict="ERR";out.url=String(e.message).slice(0,30);}
  return out;
}
for (const [n,u] of [
  ["keltruck","https://usedtrucks.keltruck.com/"],
  ["equipped4u","https://www.equipped4u.eu/"],
  ["walter-leasing","https://www.walter-leasing.com/"],
  ["ironplanet-eu","https://eu.ironplanet.com/"],
  ["truckplanet","https://www.truckplanet.com/"],
  ["trailer-store","https://www.trailer-store.com/"],
  ["krone-fleet","https://www.krone-fleet.com/"],
  ["fliegl-boerse","https://fahrzeugboerse.fliegl-trailer.com/"],
]) { const r=await probe(n,u);
  console.log(`${r.name.padEnd(16)} ${r.verdict.padEnd(6)} p=${String(r.prices).padStart(3)} km=${String(r.kms).padStart(3)}  ${String(r.url).replace(/^https?:\/\/(www\.)?/,"").slice(0,50)}`);}
await ctx.close();
