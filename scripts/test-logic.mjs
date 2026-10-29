// Checks the app's logic against the real source: compiles src/ with tsc into a temp folder and runs the
// functions with React Native's storage and location swapped for in-memory stand-ins.
//
// usage: node scripts/test-logic.mjs        (no network; takes about 30 s because the order search is timed)

import assert from "assert";
import { spawnSync } from "child_process";
import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "rr-logic-"));

// ---- compile ----

const entries = ["lib/shift", "lib/importRoute", "lib/history", "lib/settings", "lib/schedule", "lib/headingData", "lib/headingSearch",
  "lib/mergeOrder", "lib/tracking", "data/cut-through", "data/seed-orders", "data/subscribers", "data/anchors"].map((f) => path.join(ROOT, "src", f + ".ts"));
fs.writeFileSync(path.join(OUT, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "es2020", module: "commonjs", moduleResolution: "node", resolveJsonModule: true, esModuleInterop: true,
    skipLibCheck: true, strict: true, rootDir: ROOT, outDir: path.join(OUT, "js"), baseUrl: ROOT, paths: { "@/*": ["src/*"] },
  },
  files: entries,
}));
const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], { encoding: "utf8" });
if (!fs.existsSync(path.join(OUT, "js/src/lib/shift.js"))) throw new Error("compile failed:\n" + tsc.stdout + tsc.stderr);
if (tsc.status !== 0) console.log("note: tsc reported type errors (run `npm run typecheck`):\n" + tsc.stdout.slice(0, 600));

// ---- stand-ins for the phone's modules ----

const store = {};
const asyncStorage = {
  getItem: async (k) => (k in store ? store[k] : null),
  setItem: async (k, v) => { store[k] = v; },
  removeItem: async (k) => { delete store[k]; },
};
// location: what the phone says, and a record of what the app asked it to do
const loc = {
  servicesOn: true, foreground: "granted", background: "granted", started: false, startedWith: null, startCalls: 0, stopCalls: 0,
  Accuracy: { High: 4 },
  hasServicesEnabledAsync: async () => loc.servicesOn,
  requestForegroundPermissionsAsync: async () => ({ status: loc.foreground }),
  requestBackgroundPermissionsAsync: async () => ({ status: loc.background }),
  hasStartedLocationUpdatesAsync: async () => loc.started,
  startLocationUpdatesAsync: async (name, options) => { loc.started = true; loc.startedWith = { name, options }; loc.startCalls++; },
  stopLocationUpdatesAsync: async () => { loc.started = false; loc.stopCalls++; },
};
const tasks = {};
const taskManager = { defineTask: (name, fn) => { tasks[name] = fn; } };
const stubs = { "@react-native-async-storage/async-storage": asyncStorage, "expo-location": loc, "expo-task-manager": taskManager };

const SRC = path.join(OUT, "js/src");
const resolveFilename = Module._resolveFilename;
const reactPath = resolveFilename.call(Module, "react", { id: "x", filename: path.join(ROOT, "x.js"), paths: [path.join(ROOT, "node_modules")] });
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(SRC, request.slice(2));
  else if (request === "react") return reactPath;
  else if (request in stubs) return path.join(OUT, "stub_" + request.replace(/\W/g, "_") + ".cjs");
  return resolveFilename.call(this, request, ...rest);
};
for (const [name, impl] of Object.entries(stubs)) {   // the stand-ins have to be the live objects, so they go in the module cache
  const p = path.join(OUT, "stub_" + name.replace(/\W/g, "_") + ".cjs");
  fs.writeFileSync(p, "");
  const m = new Module(p); m.filename = p; m.loaded = true; m.exports = { __esModule: true, default: impl, ...impl };
  Module._cache[p] = m;
}
const require = Module.createRequire(import.meta.url);
const lib = (n) => require(path.join(SRC, "lib", n + ".js"));
const data = (n) => require(path.join(SRC, "data", n + ".js"));

const sch = lib("schedule"), H = lib("history"), St = lib("settings"), HD = lib("headingData"), HS = lib("headingSearch");
const Shift = lib("shift"), Imp = lib("importRoute"), Trk = lib("tracking");
const { SUBSCRIBERS } = data("subscribers");
const { SEED_ORDERS } = data("seed-orders");
const { CUT_THROUGH } = data("cut-through");
const { matrixIdFor } = lib("matrixAlias");
const { anchorIdsFor } = data("anchors");

// ---- helpers ----

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
}
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);   // local time, so results don't depend on the time zone
const by = new Map(SUBSCRIBERS.map((s) => [s.id, s]));
const coordOf = (id) => (by.has(id) ? { lat: by.get(id).lat, lng: by.get(id).lng } : undefined);
const matrixIdOf = (id) => (by.has(id) ? matrixIdFor(by.get(id).address, by.get(id).city) : undefined);
const routeOf = (id) => by.get(id)?.routeId;
const subsOf = (r) => SUBSCRIBERS.filter((s) => s.routeId === r);
function shuffled(arr, seed) {   // deterministic
  const a = arr.slice(); let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) % 4294967296; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---- nights, paper days, pay, history ----

await test("calendar sanity: 2026-10-25 is a Sunday", () => assert.strictEqual(at(2026, 10, 25, 12).getDay(), 0));
await test("Sunday night is Monday's paper, Friday night is Saturday's", () => {
  assert.deepStrictEqual([at(2026, 10, 25, 23), at(2026, 10, 26, 21), at(2026, 10, 29, 20), at(2026, 10, 30, 23)].map((d) => sch.paperDayIndex(d)), [1, 2, 5, 6]);
});
await test("a shift past midnight keeps its paper; Saturday evening and Sunday morning point at Monday", () => {
  assert.deepStrictEqual([at(2026, 10, 26, 1), at(2026, 10, 31, 1), at(2026, 10, 31, 20), at(2026, 10, 25, 9)].map((d) => sch.paperDayIndex(d)), [1, 6, 1, 1]);
});
await test("a Sunday-night shift finds Monday's houses; FriSat houses start Thursday night", () => {
  assert.strictEqual(sch.deliversOn("Mon-Sat", sch.paperDayOfNight(0)), true);
  assert.strictEqual(sch.deliversOn("Mon-Sat", 0), false);
  assert.strictEqual(sch.deliversOn("FriSat", sch.paperDayOfNight(4)), true);
  assert.strictEqual(sch.deliversOn("FriSat", sch.paperDayOfNight(3)), false);
  assert.deepStrictEqual(sch.NIGHT_INDEXES.map(sch.paperDayOfNight), [1, 2, 3, 4, 5, 6]);
});
await test("nightOf and weekStart follow Sunday-night weeks", () => {
  assert.strictEqual(H.nightOf(at(2026, 10, 25, 21).getTime()), "2026-10-25");
  assert.strictEqual(H.nightOf(at(2026, 10, 26, 0, 30).getTime()), "2026-10-25");
  assert.deepStrictEqual(["2026-10-25", "2026-10-30", "2026-10-31", "2026-11-01"].map(H.weekStart), ["2026-10-25", "2026-10-25", "2026-10-25", "2026-11-01"]);
  assert.strictEqual(H.weekLabel("2026-10-25"), "Sun night Oct 25 to Fri night Oct 30");
  assert.throws(() => H.parseDate("Oct 25"), /isn't a date/);
});
await test("money format and parse", () => {
  assert.deepStrictEqual([St.formatMoney(245), St.formatMoney(-5)], ["$2.45", "-$0.05"]);
  assert.deepStrictEqual(["0.35", ".35", "1", "$2.5", "12.05"].map(St.parseDollars), [35, 35, 100, 250, 1205]);
  assert.deepStrictEqual(["", "abc", "0.355", "-1", "."].map(St.parseDollars), [null, null, null, null, null]);
});
await test("saving text: saves, or says there is no shorter order", () => {
  assert.strictEqual(H.savingText(4400, 3600), "4.4 km to 3.6 km: saves 0.8 km, about 2 min.");
  assert.match(H.savingText(3000, 2990), /no shorter order/);
  assert.match(H.savingText(3000, 3200), /no shorter order/);
});

const ids = subsOf("J3").slice(0, 10).map((s) => s.id);
const shiftState = (over = {}) => ({
  date: "2026-10-26", routeIds: ["J3"], startedAt: at(2026, 10, 25, 22).getTime(), finishedAt: null,
  deliveredIds: ids.slice(2, 7), skippedIds: [ids[7]], orderedIds: ids, deliveryDayIdx: 1, startMode: "library", ...over,
});
await test("buildRecord: due, ticked, counted, skipped, stopped, pay, saving", () => {
  const s = shiftState({ optimizations: [{ at: 1, kind: "reroute", houses: 5, beforeM: 4000, afterM: 3000 }, { at: 2, kind: "reroute", houses: 3, beforeM: 900, afterM: 1000 }] });
  const r = H.buildRecord(s, { stoppedIds: [ids[0], ids[1]], rateCents: 35, plannedM: 4200, coveredM: 3900, drivenM: 4100, finishedAt: at(2026, 10, 26, 0, 10).getTime(), routeOf });
  assert.deepStrictEqual([r.due, r.ticked, r.skipped, r.counted, r.stopped], [8, 5, 1, 2, 2]);
  assert.deepStrictEqual([H.delivered(r), H.payCents(r), H.duePayCents(r)], [7, 245, 280]);
  assert.deepStrictEqual([r.coveredM, r.drivenM, r.savedM, r.optimizations, r.night, r.paperDay], [3900, 4100, 1000, 2, "2026-10-25", 1]);
  assert.throws(() => H.buildRecord({ ...s, startedAt: null }, { stoppedIds: [], rateCents: 35, plannedM: null, coveredM: null, drivenM: null, finishedAt: 1, routeOf }), /never started/);
  assert.throws(() => H.buildRecord(s, { stoppedIds: [], rateCents: 35, plannedM: null, coveredM: null, drivenM: null, finishedAt: 1, routeOf: () => undefined }), /no route/);
});
const mk = (startedAt, o = {}) => ({
  id: String(startedAt), startedAt, finishedAt: startedAt + 2 * 3_600_000, night: H.nightOf(startedAt), paperDay: (new Date(startedAt).getDay() + 1) % 7,
  routeIds: ["J3"], due: 50, ticked: 40, counted: 5, skipped: 0, stopped: 1, rateCents: 35, plannedM: 9000, coveredM: 8000, drivenM: 9500, savedM: 1200, optimizations: 2, startMode: "library", byRoute: {}, ...o,
});
const all = [mk(at(2026, 10, 25, 21).getTime()), mk(at(2026, 10, 30, 22).getTime(), { ticked: 50, counted: 0, plannedM: null, coveredM: null, drivenM: null, savedM: 0, optimizations: 0 }), mk(at(2026, 11, 1, 21).getTime())];
await test("totalsOf: pay, hours, per-hour, distance covered, per house, saved", () => {
  const t = H.totalsOf([all[0], all[1]]);
  assert.deepStrictEqual([t.shifts, t.delivered, t.payCents, t.duePayCents, t.hours], [2, 95, 95 * 35, 100 * 35, 4]);
  assert.deepStrictEqual([t.housesPerHour, t.centsPerHour], [95 / 4, (95 * 35) / 4]);
  assert.deepStrictEqual([t.plannedM, t.plannedPartial, t.coveredM, t.coveredPartial, t.drivenM, t.drivenPartial, t.savedM, t.optimizations], [9000, true, 8000, true, 9500, true, 1200, 2]);
  assert.strictEqual(t.kmPerHouse, 8 / 45);
  assert.deepStrictEqual([H.totalsOf([]).housesPerHour, H.totalsOf([]).coveredM, H.totalsOf([]).kmPerHouse], [null, null, null]);
});
await test("weekReport groups by Sunday-night week and night", () => {
  const w = H.weekReport(all, "2026-10-25");
  assert.deepStrictEqual(w.nights.map((n) => n.night), ["2026-10-25", "2026-10-30"]);
  assert.deepStrictEqual([H.weekReport(all, "2026-11-01").totals.shifts, H.weekReport(all, "2026-10-18").totals.shifts], [1, 0]);
});
await test("history storage: append once, replace on repeat, old records get the new fields, bad data raises", async () => {
  delete store["@rr/history/v1"];
  await H.appendRecord(all[1]); await H.appendRecord(all[0]); await H.appendRecord(all[1]);
  assert.deepStrictEqual((await H.loadHistory()).map((r) => r.id), [all[0].id, all[1].id]);
  const { coveredM, drivenM, savedM, optimizations, ...old } = all[0];
  store["@rr/history/v1"] = JSON.stringify([old]);
  const [loaded] = await H.loadHistory();
  assert.deepStrictEqual([loaded.coveredM, loaded.drivenM, loaded.savedM, loaded.optimizations], [null, null, 0, 0]);
  store["@rr/history/v1"] = JSON.stringify({ not: "a list" });
  await assert.rejects(H.loadHistory(), /expected shape/);
  delete store["@rr/history/v1"];
});
await test("rate: default 35, saved, rejects bad values", async () => {
  delete store["@rr/settings/v1"];
  assert.strictEqual(await St.loadRateCents(), 35);
  await St.saveRateCents(40);
  assert.strictEqual(await St.loadRateCents(), 40);
  await assert.rejects(St.saveRateCents(0.5), /whole number/);
  store["@rr/settings/v1"] = JSON.stringify({ rateCents: "x" });
  await assert.rejects(St.loadRateCents(), /expected shape/);
  delete store["@rr/settings/v1"];
});

// ---- road data, penalties ----

await test("base64 decoder matches Node on the shipped road data", () => {
  const { HEADING_DATA_B64 } = data("heading-matrix");
  assert.strictEqual(Buffer.compare(Buffer.from(HD.decodeBase64(HEADING_DATA_B64)), Buffer.from(HEADING_DATA_B64, "base64")), 0);
  assert.throws(() => HD.decodeBase64("abc"), /multiple of 4/);
});
await test("cut-through penalties raise a pair's cost when ordering, and are left out of a distance that will be driven", () => {
  assert.ok(CUT_THROUGH.length > 0, "the audit found no cut-through pairs");
  const [a, b, m] = CUT_THROUGH[0];
  const input = { stopIds: [a, b], coordOf, matrixIdOf, start: { kind: "library" } };
  const withPen = HD.buildProblem(input), without = HD.buildProblem({ ...input, withPenalties: false });
  const ia = withPen.index.get(a), ib = withPen.index.get(b);
  for (let q = 0; q < 4; q++) {
    const plain = without.problem.c[q][ia * 2 + ib], pen = withPen.problem.c[q][ia * 2 + ib], back = withPen.problem.c[q][ib * 2 + ia] - without.problem.c[q][ib * 2 + ia];
    assert.ok(Math.abs(pen - plain - m) < 1 || plain === Infinity, `forward ${pen - plain} vs ${m}`);
    assert.ok(Math.abs(back - m) < 1 || without.problem.c[q][ib * 2 + ia] === Infinity, `back ${back} vs ${m}`);
  }
  assert.strictEqual(HD.plannedMeters({ ...input, order: [a, b] }), HS.legsGreedy(without.problem, [ia, ib]).reduce((t, x) => t + x, 0));
});

// ---- re-route, GPS start, distances ----

const seed = SEED_ORDERS["G11+G7+H21"];
await test("planReroute: delivered on top, stopped at the bottom, every house once, and a scrambled order is shown as a saving", () => {
  const delivered = seed.slice(0, 60), rest = seed.slice(60);
  const stopped = [rest[3], rest[40]];
  const scrambled = [...delivered, ...shuffled(rest, 7)];
  const c = coordOf(delivered[59]);
  const here = { lat: c.lat + 0.0003, lng: c.lng + 0.0003 };
  const plan = Shift.planReroute(scrambled, delivered, stopped, here, coordOf, matrixIdOf);
  assert.strictEqual(new Set(plan.orderedIds).size, seed.length);
  assert.deepStrictEqual(plan.orderedIds.slice(0, 60), delivered);
  assert.deepStrictEqual(plan.orderedIds.slice(-2), scrambled.filter((id) => stopped.includes(id)));
  assert.strictEqual(plan.stops, rest.length - 2);
  assert.ok(plan.beforeM > 0 && plan.afterM > 0);
  assert.ok(plan.afterM < plan.beforeM * 0.6, `a scrambled order should shrink a lot: ${plan.beforeM} -> ${plan.afterM}`);
  assert.throws(() => Shift.planReroute(seed, seed, [], here, coordOf, matrixIdOf), /Nothing left/);
});
await test("planFromGps: every house once, a before figure only when there is a usual order", () => {
  const set = SEED_ORDERS.J3, here = { lat: coordOf(set[30]).lat + 0.0004, lng: coordOf(set[30]).lng };
  const solvable = set.filter((id) => id !== set[5]);
  const withBase = Shift.planFromGps(solvable, set, here, coordOf, matrixIdOf);
  assert.deepStrictEqual([...withBase.orderedIds].sort(), [...solvable].sort());
  assert.ok(withBase.beforeM > 0 && withBase.afterM > 0 && withBase.afterM <= withBase.beforeM * 1.02);
  assert.strictEqual(Shift.planFromGps(solvable, null, here, coordOf, matrixIdOf).beforeM, null);
  assert.deepStrictEqual(Shift.planFromGps([], null, here, coordOf, matrixIdOf).orderedIds, []);
});
await test("shiftDistances: covered follows the order houses were ticked; in order it equals the plan, scrambled it is longer", () => {
  const order = SEED_ORDERS.J3;
  const inOrder = { ...shiftState({ orderedIds: order }), deliveredIds: order };
  const a = Shift.shiftDistances(inOrder, [], true);
  assert.ok(Math.abs(a.coveredM - a.plannedM) < 1, `${a.coveredM} vs ${a.plannedM}`);
  const scrambled = { ...inOrder, deliveredIds: shuffled(order, 3) };
  assert.ok(Shift.shiftDistances(scrambled, [], true).coveredM > a.plannedM * 1.3);
  const half = Shift.shiftDistances({ ...inOrder, deliveredIds: order.slice(0, 20) }, [], false);
  assert.ok(half.coveredM > 0 && half.coveredM < a.plannedM, "partway through, less than the plan");
  assert.ok(Shift.shiftDistances({ ...inOrder, deliveredIds: order.slice(0, 20) }, [], true).coveredM > half.coveredM - 1, "Shift done adds the houses it counts");
  const gps = Shift.shiftDistances({ ...inOrder, startCoord: { lat: coordOf(order[40]).lat, lng: coordOf(order[40]).lng } }, [], false);
  assert.notStrictEqual(Math.round(gps.plannedM), Math.round(a.plannedM), "a live start point changes the plan");
});
await test("recordShift (the real end-of-shift path): stopped houses, pay at the saved rate, distances, saving", async () => {
  store["@rr/pausedSubs/v1"] = JSON.stringify({ [ids[0]]: true, [ids[1]]: true });
  store["@rr/settings/v1"] = JSON.stringify({ rateCents: 40 });
  delete store["@rr/history/v1"];
  await Shift.recordShift(shiftState({ optimizations: [{ at: 1, kind: "start", houses: 8, beforeM: 5000, afterM: 4200 }] }));
  const [r] = await H.loadHistory();
  assert.deepStrictEqual([r.due, r.stopped, r.ticked, r.skipped, r.counted, r.rateCents, r.savedM, r.optimizations], [8, 2, 5, 1, 2, 40, 800, 1]);
  assert.strictEqual(H.payCents(r), 7 * 40);
  assert.ok(r.plannedM > 500 && r.plannedM < 15000 && r.coveredM > 500 && r.coveredM < 15000, `planned ${r.plannedM}, covered ${r.coveredM}`);
  // a shift that started from a live location is measured from there
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 26, 22).getTime(), startMode: "gps", startCoord: coordOf(ids[5]) }));
  const two = await H.loadHistory();
  assert.strictEqual(two.length, 2);
  assert.ok(two[1].plannedM > 0);
  await Shift.recordShift(shiftState());   // the same shift again must not count twice
  assert.strictEqual((await H.loadHistory()).length, 2);
});

// ---- GPS recording ----

const here0 = { lat: 43.4643, lng: -80.5204 };
const metresNorth = (m) => m / 111320;   // degrees of latitude per metre
const fix = (t, northM, acc = 5, eastM = 0) => ({ t, lat: here0.lat + metresNorth(northM), lng: here0.lng + eastM / (111320 * Math.cos(here0.lat * Math.PI / 180)), acc });
await test("trackDistance: a straight 1 km drive adds up; a phone standing still adds almost nothing", () => {
  const drive = Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100));
  assert.ok(Math.abs(Trk.trackDistance(drive).meters - 1000) < 15, String(Trk.trackDistance(drive).meters));
  const still = Array.from({ length: 300 }, (_, i) => fix(i * 1000, (i % 3) * 2 - 2, 6, (i % 4) - 1.5));   // wanders a few metres
  assert.ok(Trk.trackDistance(still).meters < 20, String(Trk.trackDistance(still).meters));
  assert.strictEqual(Trk.trackDistance([]).meters, 0);
});
await test("trackDistance: a glitch jump, poor fixes and out-of-order fixes are handled", () => {
  const good = Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100));
  const glitch = [...good.slice(0, 5), fix(50_500, 5000), ...good.slice(5)];   // 5 km away for one fix
  assert.ok(Math.abs(Trk.trackDistance(glitch).meters - 1000) < 20, String(Trk.trackDistance(glitch).meters));
  assert.strictEqual(Trk.trackDistance(glitch).dropped, 1);
  const poor = [...good.slice(0, 5), { ...fix(45_000, 3000), acc: 200 }, ...good.slice(5)];
  assert.ok(Math.abs(Trk.trackDistance(poor).meters - 1000) < 20);
  assert.ok(Math.abs(Trk.trackDistance([...good].reverse()).meters - Trk.trackDistance(good).meters) < 1e-9);
});
await test("the background task appends points in order, ignores a shift nobody is recording, and stores its own errors", async () => {
  const task = tasks[Trk.TRACK_TASK];
  assert.strictEqual(typeof task, "function", "the task is registered when the module loads");
  const batch = (n, base) => ({ locations: Array.from({ length: n }, (_, i) => ({ timestamp: base + i * 10_000, coords: { latitude: here0.lat + metresNorth((base / 1000 + i * 10) * 10), longitude: here0.lng, accuracy: 5 } })) });
  delete store["@rr/track/active"]; delete store["@rr/track/points/123"]; delete store["@rr/track/error"];
  await task({ data: batch(3, 0), error: null });
  assert.strictEqual(store["@rr/track/points/123"], undefined, "nothing is written while no shift is being recorded");
  store["@rr/track/active"] = "123";
  await task({ data: batch(3, 0), error: null }); await task({ data: batch(2, 100_000), error: null });
  assert.strictEqual(JSON.parse(store["@rr/track/points/123"]).length, 5);
  await task({ data: null, error: { message: "location task failed" } });
  assert.strictEqual(await Trk.lastTrackError(), "location task failed");
  assert.strictEqual(JSON.parse(store["@rr/track/points/123"]).length, 5, "an error doesn't touch the saved points");
});
await test("startTracking asks for each permission, says which one is missing, and starts the service once", async () => {
  const reset = () => { Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false, startedWith: null, startCalls: 0, stopCalls: 0 }); delete store["@rr/track/active"]; };
  reset(); loc.servicesOn = false;
  await assert.rejects(Trk.startTracking(7), /switched off/);
  reset(); loc.foreground = "denied";
  await assert.rejects(Trk.startTracking(7), /permission wasn't granted/);
  reset(); loc.background = "denied";
  await assert.rejects(Trk.startTracking(7), /Allow all the time/);
  assert.strictEqual(loc.startCalls, 0, "nothing starts without the permission");
  reset();
  await Trk.startTracking(7);
  assert.deepStrictEqual([loc.startCalls, loc.startedWith.name, store["@rr/track/active"]], [1, Trk.TRACK_TASK, "7"]);
  assert.ok(loc.startedWith.options.foregroundService.notificationTitle, "a visible notification is part of the service");
  assert.strictEqual(await Trk.isTracking(7), true);
  assert.strictEqual(await Trk.isTracking(8), false);
  await Trk.startTracking(7);
  assert.strictEqual(loc.startCalls, 1, "asking again doesn't start a second service");
  await Trk.stopTracking(7);
  assert.deepStrictEqual([loc.started, loc.stopCalls, store["@rr/track/active"], store["@rr/track/points/7"]], [false, 1, undefined, undefined]);
});
await test("recordShift keeps the GPS distance with the shift, then ends the recording", async () => {
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false, startCalls: 0, stopCalls: 0 });
  store["@rr/pausedSubs/v1"] = "{}"; store["@rr/settings/v1"] = JSON.stringify({ rateCents: 35 }); delete store["@rr/history/v1"];
  const s = shiftState({ startedAt: at(2026, 10, 27, 21).getTime() });
  await Trk.startTracking(s.startedAt);
  store["@rr/track/points/" + s.startedAt] = JSON.stringify(Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100)));
  await Shift.recordShift(s);
  const [r] = await H.loadHistory();
  assert.ok(Math.abs(r.drivenM - 1000) < 15, String(r.drivenM));
  assert.deepStrictEqual([loc.started, store["@rr/track/points/" + s.startedAt], store["@rr/track/active"]], [false, undefined, undefined]);
  // a shift nobody recorded has no GPS figure
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 28, 21).getTime() }));
  assert.strictEqual((await H.loadHistory()).find((x) => x.startedAt === at(2026, 10, 28, 21).getTime()).drivenM, null);
});

// ---- update mode ----

const CODE = { G11: "N2G00011", J13: "N2J00013", H21: "N2H00021", G7: "N2G00007", J3: "N2J00003" };
const parsedFrom = (rid, subs) => ({ code: CODE[rid], expected: null, subs: subs.map((s) => ({ name: s.name, address: s.address, city: s.city, postal: s.postal, schedule: s.schedule, note: s.note })) });
const coordsOf = (subs) => subs.map((s) => ({ lat: s.lat, lng: s.lng }));
for (const rid of ["G11", "G7", "H21", "J3", "J13"]) {
  await test(`update ${rid}: the same list changes nothing`, () => {
    const subs = subsOf(rid), order = SEED_ORDERS[rid];
    const r = Imp.buildUpdatedRoute(parsedFrom(rid, subs), coordsOf(subs), 1, new Map(), { subs, order });
    assert.deepStrictEqual([r.changes.added.length, r.changes.removed.length, r.changes.kept], [0, 0, subs.length]);
    assert.deepStrictEqual(r.imported.seed, order.map((id) => r.changes.idMap.get(id)));
  });
}
await test("update G11: remove 3, add 1: survivors keep their order and J13's first nine would still lead", () => {
  const subs = subsOf("G11"), order = SEED_ORDERS.G11, drop = new Set([order[5], order[40], order[90]]);
  const keep = subs.filter((s) => !drop.has(s.id)), near = by.get(order[30]);
  const parsed = { code: CODE.G11, expected: null, subs: [...keep.map((s) => ({ name: s.name, address: s.address, city: s.city, postal: s.postal, schedule: s.schedule })), { name: "NEW", address: "999 FAKE ST", city: near.city, postal: near.postal, schedule: "Mon-Sat" }] };
  const r = Imp.buildUpdatedRoute(parsed, [...coordsOf(keep), { lat: near.lat + 0.0004, lng: near.lng + 0.0004 }], 1, new Map(), { subs, order });
  assert.deepStrictEqual([r.changes.removed.length, r.changes.added.length], [3, 1]);
  const newId = r.changes.added[0].id;
  assert.deepStrictEqual(r.imported.seed.filter((id) => id !== newId), order.filter((id) => !drop.has(id)).map((id) => r.changes.idMap.get(id)));
});
await test("update J13: the first nine lead even when the old order had one buried", () => {
  const subs = subsOf("J13"), order = SEED_ORDERS.J13, bad = [...order.slice(1), order[0]];
  const r = Imp.buildUpdatedRoute(parsedFrom("J13", subs), coordsOf(subs), 1, new Map(), { subs, order: bad });
  const first = r.imported.seed.slice(0, 9).map((id) => r.imported.subs.find((s) => s.id === id).address);
  assert.deepStrictEqual(first, ["14 DEVITT AVE N", "53 DOVER ST", "47 DOVER ST", "163 ERB ST E", "182 ERB ST E", "198 ERB ST E", "208 ERB ST E APT A", "218 ERB ST E", "238 ERB ST E"]);
});
await test("every baked seed lists each house once, with J13's first nine leading where J13 is included", () => {
  const anchors = anchorIdsFor(["J13"], SUBSCRIBERS);
  for (const [key, order] of Object.entries(SEED_ORDERS)) {
    const routes = key.split("+");
    assert.deepStrictEqual([...order].sort(), SUBSCRIBERS.filter((s) => routes.includes(s.routeId)).map((s) => s.id).sort(), key);
    if (routes.includes("J13")) assert.deepStrictEqual(order.slice(0, 9), anchors, key + " anchors");
  }
});

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
