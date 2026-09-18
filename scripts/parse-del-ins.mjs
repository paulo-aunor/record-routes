import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import fs from "fs/promises";
import path from "path";

const [, , pdfPath, outPath = "del-ins.json"] = process.argv;
if (!pdfPath) { console.error("usage: node parse-del-ins.mjs <pdf> [out]"); process.exit(1); }

const buf = await fs.readFile(pdfPath);
const { text } = await pdf(buf);

// Cleanup page-frame boilerplate but preserve the row and instruction text.
const cleaned = text
  .replace(/-{3,}/g, " ")
  .replace(/\bPAC\b/g, " ")
  .replace(/PRINTED BY:\s+\S+/g, " ")
  .replace(/PRINT DATE:\s+\S+\s+\d\d\/\d\d\/\d{4}\s+\d\d?:\d\d\s+[AP]M/g, " ")
  .replace(/RTELST\.\S+/g, " ")
  .replace(/PAGE\s+\d+/g, " ")
  .replace(/DELIVERY COPIES\s+VACNAME\s+ADDRESS\s+SCHEDULE\s+S M T W T F S/g, " ")
  .replace(/TRUCK DROP LOCATIONS:\s+WR\S+\s+WAT DEPOT/g, " ")
  .replace(/Active Subscribers\s+Office Pay,Carrier Collect,Third Party,Paid Comp,U/g, " ")
  .replace(/ADDRESSES:\s+\d+\s+NON-SUBSCRIBERS:\s+\d+/g, " ")
  .replace(/PUBLICATION:\s+WR\s+Waterloo Region Record/g, " ")
  .replace(/END OF ROUTE DELIVERY LIST REPORT/g, " ")
  .replace(/WATERLOO REGION RECORD/g, " ")
  .replace(/ROUTE DELIVERY LIST REPORT/g, " ")
  .replace(/ROUTE:\s+N2[HJ]\d+\s+N2[HJ]\d+/g, " ")
  .replace(/\d\d\/\d\d\/\d{4}/g, " ") // stray dates (page footer bleed-through)
  .replace(/[A-Z]{3,}\s+\d\d\/\d\d\/\d{4}\s+\d\d?:\d\d\s+[AP]M/g, " ");

// Pull known subscribers from subscribers.ts
const src = await fs.readFile(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/data/subscribers.ts"),
  "utf8",
);
const subRows = [...src.matchAll(
  /\{ id: "(J13-\d+)", routeId: "J13", name: "([^"]+)", address: "([^"]+)", postal: "([^"]+)"/g
)].map(m => ({ id: m[1], name: m[2], address: m[3], postal: m[4] }));

// For each subscriber, find its anchor: address + WATERLOO/KITCHENER ON [+ optional postal].
// Case-insensitive since the PDF mixes "ST" / "St", "CRES" / "Cres", etc.
// Postal-optional because some postal codes in subscribers.ts (from Nominatim geocoding)
// differ from what the depot has in the PDF.
function findAnchor(sub, textLower) {
  const addr = sub.address.toLowerCase();
  const attempts = [
    `${addr} waterloo on  ${sub.postal.toLowerCase()}`,
    `${addr} waterloo on ${sub.postal.toLowerCase()}`,
    `${addr} kitchener on  ${sub.postal.toLowerCase()}`,
    `${addr} kitchener on ${sub.postal.toLowerCase()}`,
    `${addr} waterloo on`,   // postal-less fallback
    `${addr} kitchener on`,
  ];
  for (const q of attempts) {
    const idx = textLower.indexOf(q);
    if (idx >= 0) return { idx, endIdx: idx + q.length };
  }
  return null;
}

const cleanedLower = cleaned.toLowerCase();
const anchors = [];
for (const sub of subRows) {
  const a = findAnchor(sub, cleanedLower);
  if (a) anchors.push({ ...sub, ...a });
}
anchors.sort((a, b) => a.idx - b.idx);

// Handle both anchor forms: full (with postal) and no-postal fallback.
// If we anchored without postal, the postal code + schedule + counts still lead the slice.
const scheduleRe = /^\s*(?:N\d[A-Z]\s?\d[A-Z]\d\s+)?(?:Mon-Sat|FriSat|MonSat|WedSat|Sat|Fri)(?:\s+\d){0,7}\s*/;

const notesById = {};
let withNote = 0;
for (let i = 0; i < anchors.length; i++) {
  const cur = anchors[i];
  const nx = anchors[i + 1];

  const afterAnchor = cleaned.slice(cur.endIdx);
  const sm = afterAnchor.match(scheduleRe);
  const instrStart = cur.endIdx + (sm ? sm[0].length : 0);

  let instrEnd;
  if (nx) {
    // Find the next subscriber's NAME in the text (case-insensitive), truncate the instruction there.
    const searchStart = Math.max(instrStart, nx.idx - 300);
    const nameIdx = cleanedLower.indexOf(nx.name.toLowerCase(), searchStart);
    instrEnd = nameIdx >= 0 && nameIdx < nx.idx ? nameIdx : nx.idx;
  } else {
    instrEnd = cleaned.length;
  }

  const raw = cleaned.slice(instrStart, instrEnd).replace(/\s+/g, " ").trim();
  if (raw) {
    notesById[cur.id] = raw;
    withNote++;
  }
}

await fs.writeFile(outPath, JSON.stringify(notesById, null, 2));
console.log(`anchored ${anchors.length}/${subRows.length} subscribers, ${withNote} have delivery instructions`);
console.log(`wrote ${outPath}\n`);

const missing = subRows.filter(s => !anchors.find(a => a.id === s.id));
if (missing.length) {
  console.log(`could NOT anchor (${missing.length}):`);
  for (const m of missing) console.log(`  ${m.id}  ${m.address}  ${m.postal}`);
  console.log();
}

console.log("all instructions:");
for (const [id, note] of Object.entries(notesById)) {
  const sub = subRows.find(s => s.id === id);
  console.log(`  ${id}  ${sub.address.padEnd(28)} → ${note}`);
}
