import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import fs from "fs/promises";

const [, , pdfPath, routeId] = process.argv;
if (!pdfPath || !routeId) { console.error("usage: node parse-driving-order.mjs <pdf> <routeId>"); process.exit(1); }

const buf = await fs.readFile(pdfPath);
const { text } = await pdf(buf);

// The Delivery Ink format prints each stop as a block:
//   [delivery instruction lines]
//    1
//   à  (or ß)   ← direction arrow
//   WREC        ← section code
//   217         ← house number
//     3         ← apt/unit (optional, sometimes blank)
//   MAYHEW BRENDA & JEF   ← name
//
// Between stops, "ON --" / "L --" / "R --" / "U-TURN" driving directions may appear.
// We extract the ordered sequence of house numbers → match to subscribers.

const lines = text.split(/\n/).map(l => l.trim());

// Pass 1: identify each stop's start line (the "1"/copies count) and its end line (name).
const stopBlocks = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^\d+$/.test(lines[i])) continue;
  const dir = lines[i + 1];
  if (dir !== "à" && dir !== "ß") continue;
  if (!/^WREC/i.test(lines[i + 2])) continue;
  const houseLine = lines[i + 3];
  if (!/^\d+/.test(houseLine)) continue;
  const houseNum = houseLine.match(/^(\d+)/)[1];
  const aptLine = lines[i + 4];
  const nextLine = lines[i + 5];
  let apt = null, name, endLine;
  if (/^\d+\s*$/.test(aptLine) && aptLine !== "") {
    apt = aptLine.trim(); name = nextLine; endLine = i + 5;
  } else if (aptLine === "") {
    name = nextLine; endLine = i + 5;
  } else {
    name = aptLine; endLine = i + 4;
  }
  stopBlocks.push({ startLine: i, endLine, house: houseNum, apt, name: (name || "").trim() });
}

// Page-frame boilerplate filters (per line, exact-ish matches on the trimmed line)
const boilerplate = [
  /^Thursday Delivery List/, /^Wednesday Delivery List/, /^Tuesday Delivery List/,
  /^Monday Delivery List/, /^Friday Delivery List/, /^Saturday Delivery List/,
  /^Disclaimer:/, /^You$/, /^are required/, /^required/, /^computer- generated/,
  /^computer-generated/, /^ADDRESSES NOT ROUTED/, /^DELIVERY INST/, /^ADDRESSPRDDRW/,
  /^START ROUTE/, /^Plant\s*:/, /^Delivery Ink/, /^Page \d+ of \d+/, /^Process ID:/,
  /^\d+\/\d+\/\d+\s+\d+:\d+:\d+/,
];
const isBoilerplate = (s) => boilerplate.some(re => re.test(s));

// Pass 2: for each stop, its instruction lives BETWEEN the previous stop's endLine and its own startLine.
// (For the very first stop, the instruction — if any — lives between the start-of-doc and its startLine.)
const stops = [];
for (let s = 0; s < stopBlocks.length; s++) {
  const block = stopBlocks[s];
  const prevEnd = s === 0 ? -1 : stopBlocks[s - 1].endLine;
  const instrLines = [];
  for (let j = prevEnd + 1; j < block.startLine; j++) {
    const p = lines[j];
    if (p === "" || /^ON --|^L --|^R --|^U-TURN/.test(p)) continue;
    if (isBoilerplate(p)) continue;
    instrLines.push(p);
  }
  stops.push({ ...block, instruction: instrLines.join(" ").trim() });
}

console.log(`extracted ${stops.length} stops in order`);
console.log("first 5:");
for (const s of stops.slice(0, 5)) {
  console.log(`  ${s.house}${s.apt ? " Apt " + s.apt : ""}  ${s.name}${s.instruction ? "  →  " + s.instruction : ""}`);
}
console.log("last 3:");
for (const s of stops.slice(-3)) {
  console.log(`  ${s.house}${s.apt ? " Apt " + s.apt : ""}  ${s.name}${s.instruction ? "  →  " + s.instruction : ""}`);
}

await fs.writeFile("driving-" + routeId.toLowerCase() + ".json", JSON.stringify(stops, null, 2));
console.log(`\nwrote driving-${routeId.toLowerCase()}.json`);
