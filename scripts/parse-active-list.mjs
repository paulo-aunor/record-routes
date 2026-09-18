import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import fs from "fs/promises";
import path from "path";

const [, , pdfPath, routeId] = process.argv;
if (!pdfPath || !routeId) { console.error("usage: node parse-active-list.mjs <pdf> <routeId>"); process.exit(1); }

const buf = await fs.readFile(pdfPath);
const { text } = await pdf(buf);

// Format per subscriber block (all lines from the extraction):
//   <street header>
//   1                     ← copies count
//   LASTNAME              ← last name
//   FIRSTNAME             ← first name (may span 1-2 lines)
//   WREC                  ← section
//   YYYYYYN 10YYYYYYN     ← schedule + sequence#
//   [blank / whitespace]
//   <house#>              ← house number
//   Special Instructions: <text>  ← optional

const lines = text.split(/\n/).map(l => l.trim());

// A stop begins where a line is JUST a number (copies count = 1 or 2), followed by capitalized name lines.
// After a while WREC appears. Then the sequence line "YYYYYYN <seq#>YYYYYYN". Then house# is a lone number.
const stops = [];
let currentStreet = "";

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  // Street header: two spaces + street name + optional descriptor (e.g. "  WATERLOO  ST")
  const streetMatch = l.match(/^([A-Z][A-Z\s]+?)\s+(ST|AVE|DR|RD|CRES|PL|WAY|LN|BLVD|CT)\s*$/);
  if (streetMatch) { currentStreet = `${streetMatch[1].trim()} ${streetMatch[2]}`; continue; }

  // Copies count line: lone integer 1-9 (rarely more)
  if (!/^[1-9]$/.test(l)) continue;
  // Look for WREC within the next ~8 lines
  let wrecIdx = -1;
  for (let k = i + 1; k < Math.min(i + 12, lines.length); k++) {
    if (lines[k] === "WREC") { wrecIdx = k; break; }
    // Also stop if we hit another copies count (means the previous entry was malformed)
    if (/^[1-9]$/.test(lines[k]) && k > i + 1) break;
  }
  if (wrecIdx < 0) continue;

  // Sequence line: "YYYYYYN <seq>YYYYYYN" — right after WREC
  const seqLine = lines[wrecIdx + 1] || "";
  const seqMatch = seqLine.match(/^[YN]+\s+(\d+)[YN]+/);
  if (!seqMatch) continue;
  const seq = parseInt(seqMatch[1]);

  // House number: lone number a bit further down (usually 3-5 lines below WREC after blanks)
  let houseIdx = -1;
  for (let k = wrecIdx + 2; k < Math.min(wrecIdx + 10, lines.length); k++) {
    if (/^\d{1,5}[A-Z]?$/.test(lines[k])) { houseIdx = k; break; }
    if (lines[k].startsWith("Special Instructions") || lines[k] === "WREC") break;
  }
  if (houseIdx < 0) continue;
  const house = lines[houseIdx];

  // Name: gather lines between i+1 and wrecIdx that are non-empty and not the copies count
  const nameLines = [];
  for (let k = i + 1; k < wrecIdx; k++) {
    if (lines[k] && !/^[1-9]$/.test(lines[k])) nameLines.push(lines[k]);
  }
  const name = nameLines.join(" ").replace(/\s+/g, " ").trim();

  // Instruction: line starting with "Special Instructions:" within the next 8 lines
  let instr = "";
  for (let k = houseIdx + 1; k < Math.min(houseIdx + 10, lines.length); k++) {
    const m = lines[k].match(/^Special Instructions:\s*(.+)$/);
    if (m) { instr = m[1].trim(); break; }
    if (/^[1-9]$/.test(lines[k])) break;   // next stop began
  }

  stops.push({ seq, street: currentStreet, house, name, instr });
  i = houseIdx;   // skip past this block
}

// Sort by depot sequence #
stops.sort((a, b) => a.seq - b.seq);
console.log(`extracted ${stops.length} stops`);

// Match to subscribers.ts by house# + street match
const src = await fs.readFile(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/data/subscribers.ts"),
  "utf8",
);
const subs = [...src.matchAll(new RegExp(`\\{ id: "(${routeId}-\\d+)", routeId: "${routeId}", name: "([^"]+)", address: "([^"]+)"`, "g"))]
  .map(m => ({ id: m[1], name: m[2], address: m[3] }));

function normStreet(s) { return s.replace(/\s+/g, " ").toUpperCase().trim(); }
function streetOf(addr) {
  return normStreet(addr.replace(/^\d+\s+/, "").replace(/\s+(?:APT|UNIT)\s+\S+.*$/, ""));
}
function houseOf(addr) { return addr.match(/^(\d+)/)?.[1] || ""; }

const orderIds = [];
const notes = {};
const unmatched = [];
const used = new Set();
for (const s of stops) {
  const street = normStreet(s.street);
  const cands = subs.filter(x => !used.has(x.id) && houseOf(x.address) === s.house && streetOf(x.address) === street);
  if (!cands.length) { unmatched.push(s); continue; }
  // Prefer exact name match, else first candidate
  const pick = cands.find(x => x.name.toUpperCase().includes(s.name.split(" ")[0].toUpperCase())) ?? cands[0];
  orderIds.push(pick.id);
  used.add(pick.id);
  if (s.instr) notes[pick.id] = s.instr;
}

console.log(`matched ${orderIds.length}/${stops.length}; ${Object.keys(notes).length} instructions captured`);
if (unmatched.length) {
  console.log(`unmatched (${unmatched.length}):`);
  for (const u of unmatched) console.log(`  seq ${u.seq}: ${u.house} ${u.street} · ${u.name} · "${u.instr}"`);
}
const missed = subs.filter(x => !used.has(x.id));
if (missed.length) {
  console.log(`\nsubs in my data NOT in this PDF (${missed.length}) — will float via mergeOrder:`);
  for (const m of missed) console.log(`  ${m.id} ${m.address}  ${m.name}`);
}

await fs.writeFile(`${routeId.toLowerCase()}-depot-sat.json`, JSON.stringify({ orderedIds: orderIds, notes }, null, 2));
console.log(`\nwrote ${routeId.toLowerCase()}-depot-sat.json`);
