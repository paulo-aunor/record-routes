import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SUBS_PATH = path.join(REPO_ROOT, "src/data/subscribers.ts");
const OUT_PATH = path.join(REPO_ROOT, "src/data/subscribers.geocoded.json");
const LIBRARY_QUERY = "35 Albert St, Waterloo, ON, Canada";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "record-routes-personal-tool/0.1 (paulo, non-commercial)";

async function geocode(query) {
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=ca&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${query}`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseSubscribersTs(source) {
  const rows = [];
  const re = /\{\s*id:\s*"([^"]+)",\s*routeId:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*address:\s*"([^"]+)",\s*postal:\s*"([^"]+)",\s*city:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    rows.push({ id: m[1], routeId: m[2], name: m[3], address: m[4], postal: m[5], city: m[6] });
  }
  return rows;
}

function buildQueries(sub) {
  const cleaned = sub.address.replace(/\s+APT\s+\S+/i, "").replace(/\s+UNIT\s+\S+/i, "");
  return [
    `${cleaned}, ${sub.city}, ON ${sub.postal}, Canada`,
    `${cleaned}, ${sub.city}, ON, Canada`,
  ];
}

async function main() {
  const src = await fs.readFile(SUBS_PATH, "utf8");
  const subs = parseSubscribersTs(src);
  console.log(`parsed ${subs.length} subscribers from source`);

  console.log("\n1) library anchor:");
  const lib = await geocode(LIBRARY_QUERY);
  if (!lib) throw new Error("library geocode failed");
  console.log(`   ${lib.lat}, ${lib.lng}  (${lib.displayName})`);
  await sleep(1100);

  const existing = await fs.readFile(OUT_PATH, "utf8").then(JSON.parse).catch(() => ({ library: null, stops: {} }));
  const results = { library: lib, stops: { ...existing.stops } };

  console.log(`\n2) stops (skipping ${Object.keys(results.stops).length} already cached):`);
  let done = 0, failed = 0;
  for (const sub of subs) {
    done++;
    if (results.stops[sub.id]) {
      process.stdout.write(`  [${done}/${subs.length}] ${sub.id} cached\n`);
      continue;
    }
    const queries = buildQueries(sub);
    let hit = null, lastQuery = "";
    try {
      for (let i = 0; i < queries.length; i++) {
        lastQuery = queries[i];
        hit = await geocode(lastQuery);
        if (hit) break;
        if (i < queries.length - 1) await sleep(1100);
      }
      if (hit) {
        results.stops[sub.id] = { lat: hit.lat, lng: hit.lng };
        process.stdout.write(`  [${done}/${subs.length}] ${sub.id}  ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}\n`);
      } else {
        failed++;
        results.stops[sub.id] = null;
        process.stdout.write(`  [${done}/${subs.length}] ${sub.id}  NO MATCH  (${lastQuery})\n`);
      }
    } catch (err) {
      failed++;
      results.stops[sub.id] = null;
      process.stdout.write(`  [${done}/${subs.length}] ${sub.id}  ERROR  ${err.message}\n`);
    }
    if (done % 10 === 0) {
      await fs.writeFile(OUT_PATH, JSON.stringify(results, null, 2));
    }
    await sleep(1100);
  }
  await fs.writeFile(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\ndone. ${done} attempted, ${failed} failed. wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
