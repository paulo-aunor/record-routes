// A record of every finished shift, and the daily and weekly reports built from them.
//
// A week runs Sunday night to Friday night: Sunday night's shift delivers Monday's paper, Friday night's
// delivers Saturday's. A shift belongs to the evening it started (one that starts before noon is the
// tail of the night before). Everything here is pure except load/append and the hook.

import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ShiftState } from "@/types";

const KEY = "@rr/history/v1";

// Driving speed used to turn a distance saved into minutes saved. About what the baked orders came to when
// OSRM timed them (14.3 km in 37 min, 10.7 km in 26 min, 8.2 km in 20 min); it is an estimate, not a measurement.
export const DRIVING_KMH = 24;
export const minutesFor = (m: number): number => (m / 1000 / DRIVING_KMH) * 60;
export const kmText = (m: number): string => `${(m / 1000).toFixed(1)} km`;
export const minText = (m: number): string => `about ${Math.max(1, Math.round(minutesFor(m)))} min`;

// "4.4 km to 3.6 km: saves 0.8 km, about 2 min", or says so when the new order isn't shorter.
export function savingText(beforeM: number, afterM: number): string {
  const saved = beforeM - afterM;
  if (saved < 50) return `${kmText(afterM)} left; no shorter order than the one you had (${kmText(beforeM)}).`;
  return `${kmText(beforeM)} to ${kmText(afterM)}: saves ${kmText(saved)}, ${minText(saved)}.`;
}

export type ShiftRecord = {
  id: string;                 // the start time, so a shift is only ever recorded once
  startedAt: number;
  finishedAt: number;
  night: string;              // local date of the evening it ran, "2026-10-25" = Sunday night
  paperDay: number;           // 0-6, the day of the paper delivered
  routeIds: string[];
  due: number;                // houses due, stopped houses excluded
  ticked: number;             // houses ticked off one at a time
  counted: number;            // houses Shift done counted as delivered without a tick
  skipped: number;
  stopped: number;            // houses on hold, left out
  rateCents: number;          // pay per delivered house when the shift finished
  plannedM: number | null;    // planned road distance of the whole order from where the shift started
  coveredM: number | null;    // road distance along the houses delivered, in the order delivered; no drive home
  drivenM: number | null;     // distance the phone actually moved, from the GPS recording; null when not recorded
  savedM: number;             // distance saved by re-optimizing during the shift
  optimizations: number;      // how many times the order was re-optimized
  startMode: "library" | "gps";
  byRoute: Record<string, { due: number; delivered: number }>;
};

export const delivered = (r: ShiftRecord): number => r.ticked + r.counted;
export const payCents = (r: ShiftRecord): number => delivered(r) * r.rateCents;
export const duePayCents = (r: ShiftRecord): number => r.due * r.rateCents;

// ---- dates (local time) ----

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseDate(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`"${key}" isn't a date like 2026-10-25.`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
export function addDays(key: string, days: number): string {
  const d = parseDate(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

// The evening a shift belongs to: its start date, or the day before when it began before noon.
export function nightOf(ms: number): string {
  const d = new Date(ms);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  return dateKey(d);
}
export const nightWeekday = (night: string): number => parseDate(night).getDay();
// The Sunday that opens the week this night is in (a Saturday night stays with the week before it).
export const weekStart = (night: string): string => addDays(night, -nightWeekday(night));

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function nightLabel(night: string): string {
  const d = parseDate(night);
  return `${DAYS[d.getDay()]} night, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export const paperLabel = (paperDay: number): string => `${DAYS[paperDay]} paper`;
export function weekLabel(start: string): string {
  const a = parseDate(start), b = parseDate(addDays(start, 5));
  return `Sun night ${MONTHS[a.getMonth()]} ${a.getDate()} to Fri night ${MONTHS[b.getMonth()]} ${b.getDate()}`;
}

// ---- building a record ----

export type RecordContext = {
  stoppedIds: readonly string[];       // houses on hold when the shift ended
  rateCents: number;
  plannedM: number | null;
  coveredM: number | null;
  drivenM: number | null;
  finishedAt: number;
  routeOf: (houseId: string) => string | undefined;
};

export function buildRecord(s: ShiftState, ctx: RecordContext): ShiftRecord {
  if (s.startedAt === null) throw new Error("This shift never started, so there is nothing to record.");
  if (s.deliveryDayIdx === undefined) throw new Error("This shift has no paper day recorded.");
  const stopped = new Set(ctx.stoppedIds);
  const dueIds = s.orderedIds.filter((id) => !stopped.has(id));
  const done = new Set(s.deliveredIds);
  const skippedIds = new Set(s.skippedIds);
  const ticked = dueIds.filter((id) => done.has(id)).length;
  const skipped = dueIds.filter((id) => !done.has(id) && skippedIds.has(id)).length;
  const byRoute: ShiftRecord["byRoute"] = {};
  for (const id of dueIds) {
    const route = ctx.routeOf(id);
    if (route === undefined) throw new Error(`House ${id} is on no route, so its shift can't be recorded.`);
    const e = (byRoute[route] ??= { due: 0, delivered: 0 });
    e.due++;
    if (!skippedIds.has(id) || done.has(id)) e.delivered++;   // Shift done counts every house not skipped
  }
  return {
    id: String(s.startedAt),
    startedAt: s.startedAt,
    finishedAt: ctx.finishedAt,
    night: nightOf(s.startedAt),
    paperDay: s.deliveryDayIdx,
    routeIds: s.routeIds,
    due: dueIds.length,
    ticked,
    counted: dueIds.length - ticked - skipped,
    skipped,
    stopped: s.orderedIds.length - dueIds.length,
    rateCents: ctx.rateCents,
    plannedM: ctx.plannedM,
    coveredM: ctx.coveredM,
    drivenM: ctx.drivenM,
    savedM: (s.optimizations ?? []).reduce((t, o) => t + Math.max(0, o.beforeM - o.afterM), 0),
    optimizations: (s.optimizations ?? []).length,
    startMode: s.startMode ?? "library",
    byRoute,
  };
}

// ---- reports ----

export type Totals = {
  shifts: number;
  due: number;
  delivered: number;
  ticked: number;
  counted: number;
  skipped: number;
  stopped: number;
  payCents: number;
  duePayCents: number;
  hours: number;
  housesPerHour: number | null;
  centsPerHour: number | null;
  plannedM: number | null;       // null when no shift has a planned distance
  plannedPartial: boolean;       // some shifts have none
  coveredM: number | null;
  coveredPartial: boolean;
  drivenM: number | null;        // GPS distance, summed over the shifts that were recorded
  drivenPartial: boolean;
  kmPerHouse: number | null;     // distance covered per house delivered
  savedM: number;
  optimizations: number;
};

export function totalsOf(records: readonly ShiftRecord[]): Totals {
  const t: Totals = {
    shifts: records.length, due: 0, delivered: 0, ticked: 0, counted: 0, skipped: 0, stopped: 0,
    payCents: 0, duePayCents: 0, hours: 0, housesPerHour: null, centsPerHour: null, plannedM: null, plannedPartial: false,
    coveredM: null, coveredPartial: false, drivenM: null, drivenPartial: false, kmPerHouse: null, savedM: 0, optimizations: 0,
  };
  let planned = 0, plannedN = 0, covered = 0, coveredN = 0, coveredHouses = 0, driven = 0, drivenN = 0;
  for (const r of records) {
    t.due += r.due; t.delivered += delivered(r); t.ticked += r.ticked; t.counted += r.counted;
    t.skipped += r.skipped; t.stopped += r.stopped;
    t.payCents += payCents(r); t.duePayCents += duePayCents(r);
    t.hours += (r.finishedAt - r.startedAt) / 3_600_000;
    if (r.plannedM === null) t.plannedPartial = true; else { planned += r.plannedM; plannedN++; }
    if (r.coveredM === null) t.coveredPartial = true; else { covered += r.coveredM; coveredN++; coveredHouses += delivered(r); }
    if (r.drivenM === null) t.drivenPartial = true; else { driven += r.drivenM; drivenN++; }
    t.savedM += r.savedM; t.optimizations += r.optimizations;
  }
  if (t.hours > 0) {
    t.housesPerHour = t.delivered / t.hours;
    t.centsPerHour = t.payCents / t.hours;
  }
  if (plannedN > 0) t.plannedM = planned;
  if (drivenN > 0) t.drivenM = driven;
  if (coveredN > 0) {
    t.coveredM = covered;
    if (coveredHouses > 0) t.kmPerHouse = covered / 1000 / coveredHouses;
  }
  return t;
}

export type Night = { night: string; paperDay: number; records: ShiftRecord[]; totals: Totals };
export type WeekReport = { start: string; nights: Night[]; totals: Totals };

export function weekReport(records: readonly ShiftRecord[], start: string): WeekReport {
  const inWeek = records.filter((r) => weekStart(r.night) === start).sort((a, b) => a.startedAt - b.startedAt);
  const byNight = new Map<string, ShiftRecord[]>();
  for (const r of inWeek) byNight.set(r.night, [...(byNight.get(r.night) ?? []), r]);
  const nights = [...byNight.entries()].map(([night, rs]) => ({
    night, paperDay: rs[0].paperDay, records: rs, totals: totalsOf(rs),
  }));
  return { start, nights, totals: totalsOf(inWeek) };
}

export function nightRecords(records: readonly ShiftRecord[], night: string): ShiftRecord[] {
  return records.filter((r) => r.night === night).sort((a, b) => a.startedAt - b.startedAt);
}

// ---- storage ----

export async function loadHistory(): Promise<ShiftRecord[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  if (!Array.isArray(v)) throw new Error("The saved shift history isn't in the expected shape.");
  // records saved by an earlier version lack the newer fields
  return (v as Partial<ShiftRecord>[]).map((r) => ({ coveredM: null, drivenM: null, savedM: 0, optimizations: 0, ...r })) as ShiftRecord[];
}

// Adding a shift that is already recorded replaces it, so finishing twice can't count it twice.
export async function appendRecord(record: ShiftRecord): Promise<void> {
  const all = await loadHistory();
  const next = [...all.filter((r) => r.id !== record.id), record].sort((a, b) => a.startedAt - b.startedAt);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export function useHistory() {
  const [records, setRecords] = useState<ShiftRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    loadHistory()
      .then((r) => { setRecords(r); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setReady(true));
  }, []);
  useEffect(reload, [reload]);

  return { records, ready, error, reload };
}
