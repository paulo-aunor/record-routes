import fs from "fs/promises";
import path from "path";

const ocrText = await fs.readFile(
  "/private/tmp/claude-501/-Users-pauloaunor-Documents-obsidian-vault/1498224d-d34d-478d-83ff-ec9aea41a65b/scratchpad/j13-ocr/all-columns.txt",
  "utf8",
);

// Extract every "<digits> WREC <digits>" from the full text.
// OCR quirks: leading char may be €, >, e, <, or missing; digits may have OCR misread prefix (e.g. "5173" for "173").
// Trailing count digit is often OCR-missed; make it optional.
// Also allow up to 4 chars of unit designator between house# and WREC ("208 A WREC" for Apt A).
const stopRe = /(?:[^\d]|^)(\d{1,4})(?:\s+[\dA-Za-z]{1,4})?\s+WREC(?:\s+[\d']+)?/g;
const houseSequence = [];
for (const m of ocrText.matchAll(stopRe)) {
  houseSequence.push({ raw: m[1], startIdx: m.index });
}
// Filter obvious junk (last "SERVICE TIME" line): drop the last if it's clearly summary
const lastLine = ocrText.slice(ocrText.lastIndexOf("HOME DEL WREC"));
if (lastLine) {
  // Nothing to remove from sequence — regex already skipped "WREC_" (underscore ≠ space).
}

console.log(`extracted ${houseSequence.length} stop candidates from OCR`);

const src = await fs.readFile(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/data/subscribers.ts"),
  "utf8",
);
const subs = [...src.matchAll(/\{ id: "(J13-\d+)", routeId: "J13", name: "([^"]+)", address: "([^"]+)", postal: "([^"]+)", city: "[^"]+", schedule: "([^"]+)"/g)]
  .map(m => ({ id: m[1], name: m[2], address: m[3], postal: m[4], schedule: m[5] }));

// Subs Paulo kept but the depot's driving order has stopped visiting (likely on hold or unsubscribed).
// Excluding them from matching prevents them from stealing OCR house# slots from real deliveries.
const NOT_IN_DEPOT_ROUTE = new Set(["J13-014", "J13-036", "J13-046"]);

// Only Mon-Sat J13 subs are on this Wednesday route.
const eligible = subs.filter(s => s.schedule === "Mon-Sat" && !NOT_IN_DEPOT_ROUTE.has(s.id));
console.log(`eligible Mon-Sat J13 (excl. ${NOT_IN_DEPOT_ROUTE.size} ghosts): ${eligible.length}`);

// Build a lookup: house# → list of subs starting with that house#.
const byHouse = new Map();
for (const s of eligible) {
  const h = s.address.match(/^(\d+)/)?.[1];
  if (!h) continue;
  if (!byHouse.has(h)) byHouse.set(h, []);
  byHouse.get(h).push(s);
}

// Function to attempt reconciliation: try raw number, then trimmed variants (strip leading digit for OCR "5173"→"173").
function tryMatch(raw) {
  const attempts = [raw, raw.slice(1), raw.slice(0, -1)].filter(x => x && /^\d+$/.test(x));
  for (const a of attempts) if (byHouse.has(a)) return { house: a, subs: byHouse.get(a) };
  return null;
}

// Known OCR misreads that a raw digit check can't catch (letter-in-digit substitutions).
// Empirically observed: tesseract reads "47" as "A7" so the leading "A" gets stripped
// down to "7" and no J13 sub has house#7. Fold "7" → "47" for this specific route context.
const OCR_HOUSE_CORRECTIONS = { "7": "47" };

const orderIds = [];
const unmatched = [];
const used = new Set();
for (const { raw } of houseSequence) {
  const corrected = OCR_HOUSE_CORRECTIONS[raw] ?? raw;
  const hit = tryMatch(corrected);
  if (!hit) { unmatched.push(raw); continue; }
  const pick = hit.subs.find(s => !used.has(s.id));
  if (!pick) continue;
  orderIds.push(pick.id);
  used.add(pick.id);
}

console.log(`\nmatched ${orderIds.length}/${houseSequence.length} OCR stops`);
console.log(`used ${used.size}/${eligible.length} eligible J13 subs`);
if (unmatched.length) console.log(`unmatched OCR house#s: ${unmatched.join(", ")}`);

const missed = eligible.filter(s => !used.has(s.id));
if (missed.length) {
  console.log(`\neligible J13 subs NOT in OCR order (${missed.length}):`);
  for (const m of missed) console.log(`  ${m.id}  ${m.address.padEnd(28)}  ${m.name}`);
}

await fs.writeFile("j13-order.json", JSON.stringify(orderIds, null, 2));
console.log(`\nwrote j13-order.json (${orderIds.length} ids)`);
