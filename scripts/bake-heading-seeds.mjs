// Bakes delivery orders that account for which way the car is facing.
//
// The old seeds minimised the OSRM /table distance, which lets the car reverse for free at every stop.
// A real drive can't: after delivering a house you carry on in the direction you were going, so
// "across the street, behind you" costs a loop round the block. On J3 that was 12 houses driven past
// three or more times. Here every stop has two states (the two directions of travel along its road),
// distances come from /table with a bearing on each end, and the search picks the order that is short
// when each leg takes the shortest way from the direction the car is facing.
//
// usage:
//   node scripts/bake-heading-seeds.mjs fetch                       road directions + distances for every house (public OSRM, ~10 min, cached)
//   node scripts/bake-heading-seeds.mjs solve G7 J3+J13 [options]   optimise route sets, check each against OSRM /route
//   node scripts/bake-heading-seeds.mjs solve all-sets [options]    all 31 combinations of the five routes
//   node scripts/bake-heading-seeds.mjs write                       rewrite src/data/seed-orders.ts from scripts/heading-seeds/*.json
// solve options: --seconds N (search time per start, default 60)  --starts N (independent searches, default 3)
//                --calibrate N (rounds of correcting pairs the model got wrong against /route, default 2)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(HERE, ".cache");
const OUT_DIR = path.join(HERE, "heading-seeds");
const OSRM = "https://router.project-osrm.org";
const RANGE = 35;          // degrees either side of a stop's road direction
const SNAP_SLACK_M = 20;   // a direction whose road is this much farther than the nearest road doesn't exist here (one-way)
const NEAR_TIE_M = 30;     // arrival directions this close in cost may go either way; the plan assumes the worse
const BLOCK = 50;

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------- data

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/subscribers.geocoded.json"), "utf8"));
const subsSrc = fs.readFileSync(path.join(ROOT, "src/data/subscribers.ts"), "utf8");
const SUBS = [...subsSrc.matchAll(/\{ id: "([^"]+)", routeId: "([^"]+)", name: "[^"]*", address: "([^"]+)"/g)].map((m) => ({
  id: m[1], routeId: m[2], address: m[3].replace(/\s+/g, " ").trim().toUpperCase(),
}));
if (SUBS.length === 0) throw new Error("no subscribers parsed from src/data/subscribers.ts");
for (const s of SUBS) {
  const c = geo.stops[s.id];
  if (!c) throw new Error(`no coordinates for ${s.id}`);
  s.lat = c.lat; s.lng = c.lng;
}
const IDS = SUBS.map((s) => s.id);
const N = IDS.length;
const IDX = new Map(IDS.map((id, k) => [id, k]));
const LIB = { lat: geo.library.lat, lng: geo.library.lng };
const ROUTE_IDS = [...new Set(SUBS.map((s) => s.routeId))].sort();

const anchorsSrc = fs.readFileSync(path.join(ROOT, "src/data/anchors.ts"), "utf8");
const ROUTE_ANCHORS = {};
for (const m of anchorsSrc.matchAll(/^\s{2}(\w+): \[([^\]]*)\]/gm)) {
  ROUTE_ANCHORS[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
function anchorsFor(routes) {
  const out = [];
  for (const r of routes) for (const addr of ROUTE_ANCHORS[r] ?? []) {
    const hit = SUBS.find((s) => s.routeId === r && s.address === addr);
    if (hit) out.push(IDX.get(hit.id));
  }
  return out;
}

function readSeeds() {
  const src = fs.readFileSync(path.join(ROOT, "src/data/seed-orders.ts"), "utf8");
  const seeds = {};
  for (const m of src.matchAll(/^\s{2}"([^"]+)": \[([^\]]*)\]/gm)) seeds[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return seeds;
}

// ---------------------------------------------------------------- OSRM

let lastCall = 0;
async function osrm(pathAndQuery) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(OSRM + pathAndQuery);
    } catch (e) {
      lastError = e;   // a dropped connection; retried, and raised if it keeps happening
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      if (j.code !== "Ok") throw new Error(`OSRM ${j.code}: ${j.message ?? ""} (${pathAndQuery.slice(0, 120)})`);
      return j;
    }
    if (res.status === 400) throw new Error(`OSRM 400 for ${pathAndQuery.slice(0, 160)}`);
    lastError = new Error(`OSRM answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(`OSRM kept failing for ${pathAndQuery.slice(0, 120)}: ${lastError?.cause?.code ?? lastError?.message}`);
}

function jsonCache(name) {
  const file = path.join(CACHE, name);
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return { data, save: () => fs.writeFileSync(file, JSON.stringify(data)) };
}

const pt = (k) => (k === -1 ? LIB : SUBS[k]);
const lonlat = (k) => `${pt(k).lng},${pt(k).lat}`;

// ---------------------------------------------------------------- fetch

const KX = Math.cos((43.45 * Math.PI) / 180);

// Road direction at each house: the first ~15 m of the route from the house to the library.
async function fetchAxes() {
  const c = jsonCache("axes.json");
  let n = 0;
  for (const s of SUBS) {
    if (c.data[s.id]) continue;
    const j = await osrm(`/route/v1/driving/${s.lng},${s.lat};${LIB.lng},${LIB.lat}?overview=false&steps=true&geometries=geojson`);
    const line = j.routes[0].legs[0].steps.flatMap((st) => st.geometry.coordinates);
    let p = line[line.length - 1];
    for (const q of line.slice(1)) {
      if (Math.hypot((q[0] - line[0][0]) * KX * 111320, (q[1] - line[0][1]) * 111320) >= 15) { p = q; break; }
    }
    const dx = (p[0] - line[0][0]) * KX, dy = p[1] - line[0][1];
    c.data[s.id] = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (++n % 25 === 0) { c.save(); console.log(`  road directions ${n}`); }
  }
  c.save();
  return c.data;
}

const bearingOf = (axes, k, state) => Math.round((((axes[IDS[k]] + (state ? 180 : 0)) % 360) + 360) % 360);

async function fetchMatrices() {
  const axes = await fetchAxes();
  const c = jsonCache("table-blocks.json");

  // how far each house is from its nearest road (any direction)
  const snap = new Float64Array(N);
  for (let i = 0; i < N; i += 99) {
    const part = Array.from({ length: Math.min(99, N - i) }, (_, k) => i + k);
    const key = `snap|${i}`;
    if (!c.data[key]) {
      const j = await osrm(`/table/v1/driving/${part.map(lonlat).join(";")}?annotations=distance&sources=0`);
      c.data[key] = j.destinations.map((d) => d.distance);
      c.save();
    }
    part.forEach((k, a) => (snap[k] = c.data[key][a]));
  }

  const C = [0, 1, 2, 3].map(() => new Float32Array(N * N));   // index s*2+t: leave in state s, arrive in state t
  const Lib = [new Float32Array(N), new Float32Array(N)];       // library -> house, arriving in state t
  const missing = Array.from({ length: N }, () => [false, false]);

  for (let i0 = 0; i0 < N; i0 += BLOCK) {
    for (let j0 = 0; j0 < N; j0 += BLOCK) {
      const S = Array.from({ length: Math.min(BLOCK, N - i0) }, (_, k) => i0 + k);
      const D = Array.from({ length: Math.min(BLOCK, N - j0) }, (_, k) => j0 + k);
      for (let s = 0; s < 2; s++) for (let t = 0; t < 2; t++) {
        const key = `${s}${t}|${i0}|${j0}`;
        if (!c.data[key]) {
          const bearings = [...S.map((k) => `${bearingOf(axes, k, s)},${RANGE}`), ...D.map((k) => `${bearingOf(axes, k, t)},${RANGE}`)].join(";");
          const j = await osrm(
            `/table/v1/driving/${[...S, ...D].map(lonlat).join(";")}?annotations=distance` +
            `&sources=${S.map((_, k) => k).join(";")}&destinations=${D.map((_, k) => S.length + k).join(";")}&bearings=${bearings}`,
          );
          c.data[key] = { d: j.distances, sd: j.sources.map((x) => x.distance), dd: j.destinations.map((x) => x.distance) };
          c.save();
          console.log(`  block ${key}`);
        }
        const r = c.data[key];
        S.forEach((k, a) => { if (r.sd[a] > snap[k] + SNAP_SLACK_M) missing[k][s] = true; });
        D.forEach((k, b) => { if (r.dd[b] > snap[k] + SNAP_SLACK_M) missing[k][t] = true; });
        for (let a = 0; a < S.length; a++) for (let b = 0; b < D.length; b++) {
          C[s * 2 + t][S[a] * N + D[b]] = r.d[a][b] === null ? Infinity : r.d[a][b];
        }
      }
    }
  }
  for (let j0 = 0; j0 < N; j0 += 99) {
    const D = Array.from({ length: Math.min(99, N - j0) }, (_, k) => j0 + k);
    for (let t = 0; t < 2; t++) {
      const key = `lib|${t}|${j0}`;
      if (!c.data[key]) {
        const j = await osrm(
          `/table/v1/driving/${[-1, ...D].map(lonlat).join(";")}?annotations=distance&sources=0&bearings=;${D.map((k) => `${bearingOf(axes, k, t)},${RANGE}`).join(";")}`,
        );
        c.data[key] = j.distances[0].slice(1);
        c.save();
      }
      D.forEach((k, b) => { Lib[t][k] = c.data[key][b] ?? Infinity; });
    }
  }
  for (let k = 0; k < N; k++) for (let st = 0; st < 2; st++) {
    if (!missing[k][st]) continue;
    Lib[st][k] = Infinity;
    for (let o = 0; o < N; o++) for (let other = 0; other < 2; other++) {
      C[st * 2 + other][k * N + o] = Infinity;   // can't leave in a direction the road doesn't allow
      C[other * 2 + st][o * N + k] = Infinity;   // can't arrive that way either
    }
  }
  const oneWay = missing.filter((m) => m[0] || m[1]).length;
  const file = path.join(CACHE, "heading-matrices.bin");
  const buf = Buffer.concat([...C, ...Lib].map((a) => Buffer.from(a.buffer)));
  fs.writeFileSync(file, buf);
  fs.writeFileSync(path.join(CACHE, "heading-matrices.json"), JSON.stringify({ ids: IDS, oneWay }));
  console.log(`done: ${N} houses, ${oneWay} on a road with only one usable direction`);
}

function loadMatrices() {
  const meta = JSON.parse(fs.readFileSync(path.join(CACHE, "heading-matrices.json"), "utf8"));
  if (meta.ids.length !== N || meta.ids.some((id, k) => id !== IDS[k])) {
    throw new Error("the cached distances are for a different list of houses; run `fetch` again (delete scripts/.cache first)");
  }
  const raw = fs.readFileSync(path.join(CACHE, "heading-matrices.bin"));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const C = [0, 1, 2, 3].map((q) => f.subarray(q * N * N, (q + 1) * N * N));
  const Lib = [0, 1].map((t) => f.subarray(4 * N * N + t * N, 4 * N * N + (t + 1) * N));
  return { C, Lib };
}

// ---------------------------------------------------------------- scoring

// Cost of an order (global house indexes) when near-ties go the worst way. `pen` adds a per-pair correction.
function makeCost({ C, Lib }, pen) {
  const [c00, c01, c10, c11] = C;
  return function cost(o) {
    const m = o.length;
    if (m === 0) return 0;
    const l0 = Lib[0][o[0]], l1 = Lib[1][o[0]];
    const lm = l0 < l1 ? l0 : l1;
    let w0 = l0 <= lm + NEAR_TIE_M ? l0 : -Infinity;
    let w1 = l1 <= lm + NEAR_TIE_M ? l1 : -Infinity;
    for (let i = 1; i < m; i++) {
      const ix = o[i - 1] * N + o[i];
      const extra = pen ? pen[ix] : 0;
      let n0 = -Infinity, n1 = -Infinity;
      if (w0 !== -Infinity) {
        const a = c00[ix], b = c01[ix], mn = a < b ? a : b;
        if (a <= mn + NEAR_TIE_M && w0 + a > n0) n0 = w0 + a;
        if (b <= mn + NEAR_TIE_M && w0 + b > n1) n1 = w0 + b;
      }
      if (w1 !== -Infinity) {
        const a = c10[ix], b = c11[ix], mn = a < b ? a : b;
        if (a <= mn + NEAR_TIE_M && w1 + a > n0) n0 = w1 + a;
        if (b <= mn + NEAR_TIE_M && w1 + b > n1) n1 = w1 + b;
      }
      w0 = n0 + extra; w1 = n1 + extra;
    }
    const r = w0 > w1 ? w0 : w1;
    return r === -Infinity ? Infinity : r;
  };
}

// Leg lengths along an order when every leg takes the shortest way from the current direction.
function legsGreedy({ C, Lib }, o) {
  let s = Lib[0][o[0]] <= Lib[1][o[0]] ? 0 : 1;
  const out = [Lib[s][o[0]]];
  for (let i = 1; i < o.length; i++) {
    const ix = o[i - 1] * N + o[i];
    const a = C[s * 2][ix], b = C[s * 2 + 1][ix];
    const t = a <= b ? 0 : 1;
    out.push(t === 0 ? a : b);
    s = t;
  }
  return out;
}

// ---------------------------------------------------------------- search

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nearest houses by the best-case distance in either direction.
function neighbourLists(mats, stops, K) {
  const best = (a, b) => Math.min(mats.C[0][a * N + b], mats.C[1][a * N + b], mats.C[2][a * N + b], mats.C[3][a * N + b]);
  const lists = new Map();
  for (const a of stops) {
    const d = stops.filter((b) => b !== a).map((b) => [Math.min(best(a, b), best(b, a)), b]).sort((x, y) => x[0] - y[0]);
    lists.set(a, d.slice(0, K).map((x) => x[1]));
  }
  return lists;
}

// Don't-look-bit local search: 2-opt and or-opt (1-3 houses, either way round) restricted to near neighbours.
function improve(cost, order, fixed, near, active, deadline) {
  let cur = order.slice();
  let best = cost(cur);
  const queue = [...active];
  const queued = new Set(queue);
  const pos = new Map();
  const reindex = () => cur.forEach((k, i) => pos.set(k, i));
  reindex();
  const push = (k) => { if (!queued.has(k)) { queued.add(k); queue.push(k); } };

  const accept = (cand, c, touched) => {
    cur = cand; best = c; reindex();
    for (const k of touched) { push(k); for (const nb of near.get(k) ?? []) push(nb); }
  };

  while (queue.length > 0 && Date.now() < deadline) {
    const x = queue.shift();
    queued.delete(x);
    const i = pos.get(x);
    if (i === undefined || i < fixed) continue;
    let moved = false;

    // 2-opt: make x adjacent to one of its neighbours by reversing the stretch between them
    for (const v of near.get(x)) {
      const j = pos.get(v);
      if (j === undefined || moved) continue;
      let a, b;
      if (j > i) { a = i + 1; b = j; } else { a = j + 1; b = i; }
      if (a < fixed || a >= b) continue;
      const cand = cur.slice(0, a).concat(cur.slice(a, b + 1).reverse(), cur.slice(b + 1));
      const c = cost(cand);
      if (c < best - 1e-6) { accept(cand, c, [cur[a - 1], cur[a], cur[b], cur[b + 1] ?? cur[b]]); moved = true; }
    }
    if (moved) { push(x); continue; }

    // or-opt: move a stretch of 1-3 houses containing x next to a neighbour of either end
    for (let len = 1; len <= 3 && !moved; len++) {
      for (let st = i - len + 1; st <= i && !moved; st++) {
        if (st < fixed || st + len > cur.length) continue;
        const seg = cur.slice(st, st + len);
        const rest = cur.slice(0, st).concat(cur.slice(st + len));
        const ends = len === 1 ? [seg[0]] : [seg[0], seg[len - 1]];
        for (const e of ends) {
          for (const v of near.get(e)) {
            if (moved) break;
            const pv = rest.indexOf(v);
            if (pv < 0) continue;
            for (const ins of [pv, pv + 1]) {
              if (ins < fixed || moved) continue;
              for (const flip of len === 1 ? [false] : [false, true]) {
                const piece = flip ? seg.slice().reverse() : seg;
                const cand = rest.slice(0, ins).concat(piece, rest.slice(ins));
                const c = cost(cand);
                if (c < best - 1e-6) { accept(cand, c, [...seg, v, rest[ins - 1] ?? v]); moved = true; break; }
              }
              if (moved) break;
            }
          }
        }
      }
    }
    if (moved) push(x);
  }
  return { order: cur, cost: best };
}

function iterate(mats, cost, start, fixed, stops, seconds, seed) {
  const deadline = Date.now() + seconds * 1000;
  const near = neighbourLists(mats, stops, 12);
  const rnd = mulberry32(seed);
  let cur = improve(cost, start, fixed, near, stops, deadline);
  let best = cur;
  let kicks = 0;
  const free = cur.order.length - fixed;
  while (Date.now() < deadline && free >= 8) {
    kicks++;
    const o = cur.order.slice();
    const w = Math.min(free, 12 + Math.floor(rnd() * 30));
    const a0 = fixed + Math.floor(rnd() * (free - w + 1));
    const touched = new Set();
    let kicked;
    if (rnd() < 0.5) {
      // swap two neighbouring stretches inside a window
      const c1 = a0 + 1 + Math.floor(rnd() * (w - 2)), c2 = c1 + 1 + Math.floor(rnd() * (a0 + w - c1 - 1 || 1));
      const cand = o.slice(0, a0).concat(o.slice(c1, c2), o.slice(a0, c1), o.slice(c2));
      cand.slice(a0, a0 + w).forEach((k) => touched.add(k));
      kicked = cand;
    } else {
      // relocate a short stretch somewhere nearby
      const len = 1 + Math.floor(rnd() * 4);
      const from = a0 + Math.floor(rnd() * Math.max(1, w - len));
      const seg = o.splice(from, len);
      const to = Math.max(fixed, Math.min(o.length, a0 + Math.floor(rnd() * w)));
      o.splice(to, 0, ...seg);
      o.slice(Math.min(from, to), Math.min(o.length, Math.max(from, to) + len)).forEach((k) => touched.add(k));
      kicked = o;
    }
    const cand = improve(cost, kicked, fixed, near, touched, deadline);
    if (cand.cost < cur.cost - 1e-6) { cur = cand; if (cand.cost < best.cost) best = cand; }
  }
  return { ...best, kicks };
}

// ---------------------------------------------------------------- checking against the real router

const realCache = jsonCache("real-routes.json");
// Plain OSRM /route (what a navigation app does): length of every leg, library first. Chunked to stay under the demo server's limits.
async function realLegs(order) {
  const ids = [-1, ...order];
  const legs = [];
  for (let i = 0; i < ids.length - 1; i += 99) {
    const part = ids.slice(i, Math.min(i + 100, ids.length));
    const key = part.join(">");
    if (!realCache.data[key]) {
      const j = await osrm(`/route/v1/driving/${part.map(lonlat).join(";")}?overview=false`);
      realCache.data[key] = j.routes[0].legs.map((l) => l.distance);
      realCache.save();
    }
    legs.push(...realCache.data[key]);
  }
  return legs;
}
const sum = (a) => a.reduce((t, x) => t + x, 0);

// ---------------------------------------------------------------- solve

function parseSet(arg) {
  const routes = arg.split("+").map((x) => x.trim().toUpperCase()).sort();
  for (const r of routes) if (!ROUTE_IDS.includes(r)) throw new Error(`unknown route ${r} (have ${ROUTE_IDS.join(", ")})`);
  return routes;
}

async function solveSet(routes, opts, mats) {
  const key = routes.join("+");
  const stops = SUBS.map((s, k) => (routes.includes(s.routeId) ? k : -1)).filter((k) => k >= 0);
  const stopSet = new Set(stops);
  const seeds = readSeeds();
  const full = seeds[ROUTE_IDS.join("+")];
  const baseline = (seeds[key] ?? full?.filter((id) => routes.includes(SUBS[IDX.get(id)].routeId)) ?? []).map((id) => IDX.get(id));
  if (baseline.length !== stops.length || baseline.some((k) => !stopSet.has(k))) {
    throw new Error(`${key}: no existing seed covering all ${stops.length} houses to start from`);
  }
  const fixedIds = anchorsFor(routes);
  const fixed = fixedIds.length;
  if (fixedIds.some((k, i) => baseline[i] !== k)) throw new Error(`${key}: the existing seed doesn't start with the fixed first houses`);

  const before = sum(await realLegs(baseline)) / 1000;
  console.log(`${key}: ${stops.length} houses, current seed ${before.toFixed(2)} km on the real roads`);

  const pen = new Float32Array(N * N);
  let candidates = [];
  let start = baseline;
  for (let round = 0; round <= opts.calibrate; round++) {
    const cost = makeCost(mats, pen);
    for (let n = 0; n < opts.starts; n++) {
      const r = iterate(mats, cost, start, fixed, stops, opts.seconds, 1000 * round + n + 1);
      const km = sum(await realLegs(r.order)) / 1000;
      candidates.push({ order: r.order, modelKm: r.cost / 1000, realKm: km, round });
      console.log(`  round ${round} search ${n + 1}: model ${(r.cost / 1000).toFixed(2)} km, real ${km.toFixed(2)} km (${r.kicks} restarts)`);
    }
    const top = candidates.reduce((a, b) => (b.realKm < a.realKm ? b : a));
    if (round === opts.calibrate) break;
    // where the model said "short" and the router said "long", add the difference to that pair and search again
    const real = await realLegs(top.order);
    const model = legsGreedy(mats, top.order);
    let fixes = 0;
    for (let i = 1; i < top.order.length; i++) {
      const diff = real[i] - model[i];
      if (diff > 60) { pen[top.order[i - 1] * N + top.order[i]] += diff; fixes++; }
    }
    console.log(`  calibration: ${fixes} pairs corrected`);
    if (fixes === 0) break;
    start = top.order;
  }
  const best = candidates.reduce((a, b) => (b.realKm < a.realKm ? b : a));
  // never ship something worse than what's already there
  const keep = best.realKm < before ? best : { order: baseline, realKm: before, modelKm: null, round: -1 };
  const result = {
    set: key,
    houses: stops.length,
    order: keep.order.map((k) => IDS[k]),
    currentKm: +before.toFixed(3),
    newKm: +keep.realKm.toFixed(3),
    modelKm: keep.modelKm === null ? null : +keep.modelKm.toFixed(3),
    bakedOn: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(result, null, 1));
  console.log(`  -> ${key}: ${before.toFixed(2)} km -> ${keep.realKm.toFixed(2)} km (${((keep.realKm / before - 1) * 100).toFixed(1)}%)\n`);
  return result;
}

function allSets() {
  const out = [];
  for (let mask = 1; mask < 1 << ROUTE_IDS.length; mask++) out.push(ROUTE_IDS.filter((_, i) => mask & (1 << i)));
  return out;
}

// ---------------------------------------------------------------- write

function writeSeeds() {
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error("nothing in scripts/heading-seeds/ - run `solve` first");
  const results = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")));
  const old = readSeeds();
  const merged = { ...old };
  for (const r of results) merged[r.set] = r.order;
  const keys = Object.keys(merged).sort((a, b) => a.split("+").length - b.split("+").length || a.localeCompare(b));
  const chunk = (arr) => {
    const lines = [];
    for (let i = 0; i < arr.length; i += 7) lines.push("    " + arr.slice(i, i + 7).map((x) => `"${x}"`).join(", ") + ",");
    return lines.join("\n");
  };
  const note = (k) => {
    const r = results.find((x) => x.set === k);
    return r ? `  // ${k}: ${r.houses} houses, ${r.newKm.toFixed(2)} km on the road (was ${r.currentKm.toFixed(2)} km), direction-aware order\n` : `  // ${k}: not re-baked\n`;
  };
  const header = fs.readFileSync(path.join(ROOT, "src/data/seed-orders.ts"), "utf8").split("export const SEED_ORDERS")[0]
    .replace(/\n\/\/ \d{4}-\d{2}-\d{2} direction-aware refresh:[\s\S]*?\n(?=\n|export)/, "\n");
  const stamp = new Date().toISOString().slice(0, 10);
  const body = keys.map((k) => `${note(k)}  "${k}": [\n${chunk(merged[k])}\n  ],`).join("\n");
  const text = header.trimEnd() + `\n//\n// ${stamp} direction-aware refresh: orders re-baked with scripts/bake-heading-seeds.mjs so the car is\n// never assumed able to reverse at a stop. Each set was checked against OSRM /route (km figures below).\n\nexport const SEED_ORDERS: Record<string, string[]> = {\n${body}\n};\n`;
  fs.writeFileSync(path.join(ROOT, "src/data/seed-orders.ts"), text);
  console.log(`wrote ${keys.length} seeds (${results.length} re-baked) to src/data/seed-orders.ts`);
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? +rest[i + 1] : dflt;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

if (cmd === "fetch") {
  await fetchMatrices();
} else if (cmd === "solve") {
  const mats = loadMatrices();
  const opts = { seconds: flag("seconds", 60), starts: flag("starts", 3), calibrate: flag("calibrate", 2) };
  const sets = positional.includes("all-sets") ? allSets() : positional.map(parseSet);
  if (sets.length === 0) throw new Error("name at least one route set, e.g. `solve G7 J3+J13` or `solve all-sets`");
  for (const s of sets) await solveSet(s, opts, mats);
} else if (cmd === "write") {
  writeSeeds();
} else {
  throw new Error("usage: bake-heading-seeds.mjs fetch | solve <sets...|all-sets> [--seconds N --starts N --calibrate N] | write");
}
