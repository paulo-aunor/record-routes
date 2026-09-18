// Precompute a driving-distance-optimized seed order per route set via OSRM's trip endpoint.
// Runs at build time; the resulting sequence is baked into the app so no runtime internet
// is needed. usage: node build-osrm-seed.mjs H21 J3 J13 --write

import fs from "fs/promises";
import path from "path";

const routes = process.argv.slice(2).filter(a => !a.startsWith("--"));
const write = process.argv.includes("--write");
if (!routes.length) { console.error("usage: node build-osrm-seed.mjs <route> [route...] [--write]"); process.exit(1); }

const scratch = path.dirname(new URL(import.meta.url).pathname);
const geo = JSON.parse(await fs.readFile(path.resolve(scratch, "../src/data/subscribers.geocoded.json"), "utf8"));
const src = await fs.readFile(path.resolve(scratch, "../src/data/subscribers.ts"), "utf8");

const subs = [...src.matchAll(/\{ id: "([^"]+)", routeId: "([^"]+)", name: "([^"]+)", address: "([^"]+)"[^}]*\}/g)]
  .map(m => ({ id: m[1], routeId: m[2], name: m[3], address: m[4] }));

async function osrmTrip(routeId) {
  const stops = subs.filter(s => s.routeId === routeId);
  const coords = [
    [geo.library.lng, geo.library.lat],
    ...stops.map(s => [geo.stops[s.id].lng, geo.stops[s.id].lat]),
  ];
  const coordStr = coords.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
  const url = `http://router.project-osrm.org/trip/v1/driving/${coordStr}?source=first&roundtrip=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error(`OSRM error for ${routeId}: ${data.message || data.code}`);
  const trip = data.trips[0];
  // waypoints[i].waypoint_index = position of input i in the optimized tour
  const orderedInputs = data.waypoints
    .map((w, i) => ({ input: i, tripPos: w.waypoint_index }))
    .sort((a, b) => a.tripPos - b.tripPos);
  // Drop the library (input 0) — it's just the anchor
  const orderedIds = orderedInputs.filter(x => x.input > 0).map(x => stops[x.input - 1].id);
  return { orderedIds, distanceKm: trip.distance / 1000, durationMin: trip.duration / 60, stopCount: stops.length };
}

const results = {};
for (const r of routes) {
  process.stdout.write(`  ${r}: computing... `);
  const t = await osrmTrip(r);
  results[r] = t;
  process.stdout.write(`${t.stopCount} stops · ${t.distanceKm.toFixed(2)} km · ${t.durationMin.toFixed(1)} min\n`);
  await new Promise(r => setTimeout(r, 500));   // be polite to the free demo server
}

if (write) {
  const seedPath = path.resolve(scratch, "../src/data/seed-orders.ts");
  const existing = await fs.readFile(seedPath, "utf8");
  const preservedH21 = /"H21":\s*\[([\s\S]+?)\],/.exec(existing);
  const preservedJ13 = /"J13":\s*\[([\s\S]+?)\],/.exec(existing);
  const preservedJ3  = /"J3":\s*\[([\s\S]+?)\],/.exec(existing);

  const finalOrders = {};
  for (const rid of ["H21", "J3", "J13"]) {
    if (results[rid]) finalOrders[rid] = results[rid].orderedIds;
    else if (rid === "H21" && preservedH21) finalOrders[rid] = preservedH21[1].match(/"[^"]+"/g).map(x => x.slice(1, -1));
    else if (rid === "J13" && preservedJ13) finalOrders[rid] = preservedJ13[1].match(/"[^"]+"/g).map(x => x.slice(1, -1));
    else if (rid === "J3"  && preservedJ3 ) finalOrders[rid] = preservedJ3 [1].match(/"[^"]+"/g).map(x => x.slice(1, -1));
  }

  let out = `// Hardcoded seed orders per route set. Used on the FIRST shift when no saved order exists.
// Once a shift finishes, its final order (post drag-reorder) overwrites the seed via saveLastOrder.
// Precomputed via OSRM (OpenStreetMap Routing Machine) 'trip' endpoint — real driving-distance
// optimization on real road network, minimizes total km & time from the library.

export const SEED_ORDERS: Record<string, string[]> = {
`;
  for (const rid of ["H21", "J3", "J13"]) {
    const order = finalOrders[rid];
    if (!order) continue;
    const r = results[rid];
    const note = r
      ? `OSRM-optimized: ${order.length} stops · ${r.distanceKm.toFixed(2)} km · ${r.durationMin.toFixed(1)} min`
      : "(preserved from previous seed — not re-computed this run)";
    out += `  // ${rid} — ${note}\n  "${rid}": [\n`;
    for (let i = 0; i < order.length; i += 7)
      out += "    " + order.slice(i, i + 7).map(x => `"${x}"`).join(", ") + ",\n";
    out += "  ],\n";
  }
  out += "};\n";
  await fs.writeFile(seedPath, out);
  console.log(`\nwrote seed-orders.ts with OSRM-optimized seeds for: ${routes.join(", ")}`);
}
