import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import fs from "fs/promises";

const [, , pdfPath, outPath = "parsed-subs.json"] = process.argv;
if (!pdfPath) { console.error("usage: node parse-route-pdf.mjs <pdf> [out.json]"); process.exit(1); }

const buf = await fs.readFile(pdfPath);
const parsed = await pdf(buf);
const rawText = parsed.text;

const ROUTE_MAP = { N2J00003: "J3", N2J00013: "J13", N2H00021: "H21" };

const routeSplitRe = /ROUTE:\s+(N2[HJ]\d+)(?:\s+N2[HJ]\d+)?/g;

const chunks = [];
let lastIdx = 0;
let lastRoute = null;
for (const m of rawText.matchAll(routeSplitRe)) {
  if (lastRoute) chunks.push({ route: lastRoute, body: rawText.slice(lastIdx, m.index) });
  lastRoute = ROUTE_MAP[m[1]] ?? null;
  lastIdx = m.index + m[0].length;
}
if (lastRoute) chunks.push({ route: lastRoute, body: rawText.slice(lastIdx) });

function cleanChunk(body) {
  return body
    .replace(/-{3,}/g, " ")
    .replace(/\bPAC\b/g, " ")
    .replace(/PRINTED BY:\s+\S+/g, " ")
    .replace(/PRINT DATE:\s+\S+\s+\d\d\/\d\d\/\d{4}\s+\d\d?:\d\d\s+[AP]M/g, " ")
    .replace(/RTELST\.\S+/g, " ")
    .replace(/PAGE\s+\d+/g, " ")
    .replace(/DELIVERY COPIES\s+VACNAME\s+ADDRESS\s+SCHEDULE\s+S M T W T F S/g, " ")
    .replace(/TRUCK DROP LOCATIONS:\s+WRSat\s+WAT DEPOT/g, " ")
    .replace(/Active Subscribers\s+Office Pay,Carrier Collect,Third Party,Paid Comp,U/g, " ")
    .replace(/ADDRESSES:\s+\d+\s+NON-SUBSCRIBERS:\s+\d+/g, " ")
    .replace(/PUBLICATION:\s+WR\s+Waterloo Region Record/g, " ")
    .replace(/END OF ROUTE DELIVERY LIST REPORT/g, " ")
    .replace(/WATERLOO REGION RECORD/g, " ")
    .replace(/ROUTE DELIVERY LIST REPORT/g, " ");
}

const rowRe = /([A-Za-z][A-Za-z .&/'\-\d,]+?)\s{2,}(\d+\s+[A-Za-z][A-Za-z0-9 .&/'\-]+?(?:\s+(?:APT|UNIT)\s+\S+)?)\s+(WATERLOO|KITCHENER)\s+ON\s+(N2[HJ])\s?(\d[A-Z]\d)\s+(Mon-Sat|FriSat|MonSat|WedSat|Sat|Fri)/gi;

const byRoute = {};
for (const { route, body } of chunks) {
  const text = cleanChunk(body);
  const arr = (byRoute[route] ||= []);
  for (const m of text.matchAll(rowRe)) {
    const name = m[1].trim().replace(/\s+/g, " ");
    const addressRaw = m[2].trim().replace(/\s+/g, " ").toUpperCase();
    const address = addressRaw
      .replace(/\bST\.?\b/g, "ST").replace(/\bAVE\.?\b/g, "AVE").replace(/\bDR\.?\b/g, "DR")
      .replace(/\bRD\.?\b/g, "RD").replace(/\bCRES\.?\b/g, "CRES").replace(/\bPL\.?\b/g, "PL");
    const city = m[3][0].toUpperCase() + m[3].slice(1).toLowerCase();
    const postal = `${m[4].toUpperCase()} ${m[5].toUpperCase()}`;
    const schedule = m[6].replace(/frisat/i, "FriSat").replace(/mon-sat/i, "Mon-Sat");
    arr.push({ name, address, postal, city, schedule });
  }
}

const out = { routes: {} };
for (const rid of Object.keys(byRoute).sort()) {
  const arr = byRoute[rid];
  out.routes[rid] = arr.map((s, i) => ({
    id: `${rid}-${String(i + 1).padStart(3, "0")}`,
    routeId: rid,
    name: s.name,
    address: s.address,
    postal: s.postal,
    city: s.city,
    schedule: s.schedule,
  }));
  console.log(`${rid}: ${arr.length}`);
}

await fs.writeFile(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}`);
