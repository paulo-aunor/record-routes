import { useCallback, useEffect, useRef, useState } from "react";
import type { Optimization, RouteId, ShiftState } from "@/types";
import { anchorIdsFor } from "@/data/anchors";
import { SEED_ORDERS } from "@/data/seed-orders";
import { isAtLibrary } from "./location";
import { loadPaused } from "./paused";
import { orderStops, plannedMeters, type StartSpec } from "./headingData";
import { appendRecord, buildRecord } from "./history";
import { matrixIdFor } from "./matrixAlias";
import { mergeOrder } from "./mergeOrder";
import { optimize as optimizeV2, type Coord } from "./optimizer-v2";
import {
  allSubscribers, importedSeed, isImportedRoute, revisionTag, subscribersForRoutes, subscribersForRoutesOn,
} from "./registry";
import { paperDayIndex } from "./schedule";
import { loadRateCents } from "./settings";
import { stopTracking, trackedMeters } from "./tracking";
import {
  loadShift, saveShift, todayKey, newShift, clearShift,
  loadLastOrder, saveLastOrder, routeSetKey,
} from "./storage";

// Coordinates for every house that currently exists, imported routes included.
function coordLookup(): (id: string) => Coord | undefined {
  const byId = new Map<string, Coord>(allSubscribers().map((s) => [s.id, { lat: s.lat, lng: s.lng }]));
  return (id) => byId.get(id);
}

// Lets an imported house borrow the real driving distances of the built-in house at the same address.
function matrixLookup(): (id: string) => string | undefined {
  const byId = new Map<string, string | undefined>(allSubscribers().map((s) => [s.id, matrixIdFor(s.address, s.city)]));
  return (id) => byId.get(id);
}

// Lets the "Finding your route" state paint before the solver blocks the JS thread.
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

export type StartOptions = {
  startCoord?: Coord;              // live GPS fix; ignored when it's at the library
  excludeIds?: readonly string[];  // stopped houses, left out of the solve
};

// Exact pre-baked seed for this route set, or null when nothing matches.
// Subsets without an exact seed fall through to the on-device TS optimizer in
// start() instead of the old alpha-concat fallback (which left routes
// end-to-end instead of cross-route optimized).
function getExactSeed(routeIds: readonly string[]): string[] | null {
  // An imported route replaces a built-in one, so the baked seeds (built from the
  // old houses) can't apply; a route imported on its own has its own solved order.
  if (routeIds.some(isImportedRoute)) {
    return routeIds.length === 1 ? importedSeed(routeIds[0]) : null;
  }
  const seed = SEED_ORDERS[routeSetKey(routeIds)];
  return seed && seed.length ? seed : null;
}

// The order a route would be delivered in from the library right now, every house
// on it (all days): the last saved order if there is one, otherwise the seed.
// An update from a new PDF keeps this order and slots changes into it.
export async function currentRouteOrder(routeId: RouteId): Promise<string[]> {
  const ids = subscribersForRoutes([routeId]).map((s) => s.id);
  const saved = await loadLastOrder([routeId], revisionTag([routeId]));
  const seed = getExactSeed([routeId]);
  if (saved && saved.length) return mergeOrder(saved, ids, seed);
  if (seed) return mergeOrder(seed, ids, seed);
  throw new Error(`Route ${routeId} has no saved order or seed to build on.`);
}

// The reordering behind "Re-route from here". Delivered stops keep their place at
// the top, undelivered stops are re-solved from `here`, stopped houses stay at the
// bottom (hidden on screen, so Resume still works).
export function planReroute(
  orderedIds: readonly string[],
  deliveredIds: readonly string[],
  stoppedIds: readonly string[],
  here: Coord,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
): { orderedIds: string[]; stops: number; beforeM: number; afterM: number } {
  const stopped = new Set(stoppedIds);
  const delivered = new Set(deliveredIds);
  const doneInOrder = orderedIds.filter((id) => delivered.has(id));
  const remaining = orderedIds.filter((id) => !delivered.has(id) && !stopped.has(id));
  const hidden = orderedIds.filter((id) => !delivered.has(id) && stopped.has(id));
  if (remaining.length === 0) throw new Error("Nothing left to re-route.");
  // Two starting points for the direction-aware search: the order as it stands, and a quick straight-distance order from here.
  const quick = optimizeV2({ stopIds: remaining, startCoord: here, coordOf, matrixIdOf, timeBudgetMs: 1000 });
  const solved = orderStops({
    stopIds: remaining,
    coordOf,
    matrixIdOf,
    start: { kind: "gps", coord: here },
    candidates: [remaining, quick.orderedIds],
    ms: 3000,
  });
  // Road distance of the houses still to deliver, from here, in the order they were in and in the new order.
  const start: StartSpec = { kind: "gps", coord: here };
  const beforeM = plannedMeters({ stopIds: remaining, order: remaining, coordOf, matrixIdOf, start });
  const afterM = plannedMeters({ stopIds: remaining, order: solved.orderedIds, coordOf, matrixIdOf, start });
  return { orderedIds: [...doneInOrder, ...solved.orderedIds, ...hidden], stops: remaining.length, beforeM, afterM };
}

// The order for a shift that starts away from the library. The usual library order (when there is one) and a quick
// straight-distance order from here are both improved with the direction-aware search; the shorter one wins.
export function planFromGps(
  solvable: readonly string[],
  libraryOrder: readonly string[] | null,
  here: Coord,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
): { orderedIds: string[]; beforeM: number | null; afterM: number } {
  const solvableSet = new Set(solvable);
  const quick = optimizeV2({ stopIds: solvable, startCoord: here, coordOf, matrixIdOf, timeBudgetMs: 1500 });
  const candidates = libraryOrder ? [libraryOrder.filter((id) => solvableSet.has(id)), quick.orderedIds] : [quick.orderedIds];
  const start: StartSpec = { kind: "gps", coord: here };
  const { orderedIds } = orderStops({ stopIds: solvable, coordOf, matrixIdOf, start, candidates, ms: 4000 });
  // the previous order is the usual library order, now driven from where the shift starts
  const usual = libraryOrder ? libraryOrder.filter((id) => solvableSet.has(id)) : null;
  return {
    orderedIds,
    beforeM: usual ? plannedMeters({ stopIds: usual, order: usual, coordOf, matrixIdOf, start }) : null,
    afterM: plannedMeters({ stopIds: orderedIds, order: orderedIds, coordOf, matrixIdOf, start }),
  };
}

// Road distance of the shift as driven: `plannedM` along the whole order from where it started, `coveredM` along
// the houses delivered, in the order they were ticked. With `final` the houses Shift done counts as delivered
// follow, in the order they stand. Neither includes the drive home.
export function shiftDistances(s: ShiftState, stoppedIds: readonly string[], final: boolean): { plannedM: number; coveredM: number } {
  const stopped = new Set(stoppedIds);
  const due = s.orderedIds.filter((id) => !stopped.has(id));
  const dueSet = new Set(due);
  const ticked = s.deliveredIds.filter((id) => dueSet.has(id));
  const tickedSet = new Set(ticked);
  const skipped = new Set(s.skippedIds);
  const walked = final ? [...ticked, ...due.filter((id) => !tickedSet.has(id) && !skipped.has(id))] : ticked;
  const start: StartSpec = s.startCoord ? { kind: "gps", coord: s.startCoord } : { kind: "library" };
  const coordOf = coordLookup(), matrixIdOf = matrixLookup();
  return {
    plannedM: plannedMeters({ stopIds: due, order: due, coordOf, matrixIdOf, start }),
    coveredM: plannedMeters({ stopIds: walked, order: walked, coordOf, matrixIdOf, start }),
  };
}

// Writes the finished shift into the history (pay, counts, time, planned distance) before it is cleared,
// so a failure leaves the shift in place to try again.
export async function recordShift(s: ShiftState): Promise<void> {
  const [paused, rateCents] = await Promise.all([loadPaused(), loadRateCents()]);
  const stoppedIds = s.orderedIds.filter((id) => paused[id]);
  const subs = new Map(allSubscribers().map((x) => [x.id, x]));
  const { plannedM, coveredM } = shiftDistances(s, stoppedIds, true);
  if (s.startedAt === null) throw new Error("This shift never started, so there is nothing to record.");
  const drivenM = await trackedMeters(s.startedAt);   // from the GPS recording; null when there wasn't one
  await appendRecord(buildRecord(s, {
    stoppedIds,
    rateCents,
    plannedM,
    coveredM,
    drivenM,
    finishedAt: Date.now(),
    routeOf: (id) => subs.get(id)?.routeId,
  }));
  await stopTracking(s.startedAt);   // only once the shift is safely recorded
}

export function useShift() {
  const [state, setState] = useState<ShiftState | null>(null);
  const [ready, setReady] = useState(false);

  // Mirror state to a ref so async callbacks (finish, finishAsDone) always see the
  // latest orderedIds even if React hasn't recomputed their memoized closure yet.
  // Without this, a fast drag → Shift-done sequence would save the pre-drag order.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadShift(todayKey()).then((s) => {
      setState(s);
      setReady(true);
    });
  }, []);

  const start = useCallback(async (routeIds: RouteId[], deliveryDayIdx?: number, opts?: StartOptions) => {
    const dayIdx = deliveryDayIdx ?? paperDayIndex();
    const eligibleIds = subscribersForRoutesOn(routeIds, dayIdx).map((s) => s.id);
    const excluded = new Set(opts?.excludeIds ?? []);
    const solvable = eligibleIds.filter((id) => !excluded.has(id));
    // Stopped houses stay in the order (hidden at render) so Resume works mid-shift.
    const hiddenTail = eligibleIds.filter((id) => excluded.has(id));

    const startCoord = opts?.startCoord;
    const fromGps = startCoord !== undefined && !isAtLibrary(startCoord);
    const coordOf = coordLookup();
    const revTag = revisionTag(routeIds);

    let orderedIds: string[];
    const optimizations: Optimization[] = [];
    if (fromGps) {
      // Away from the library: library-anchored seeds and saved orders don't fit,
      // so solve from where Paulo is standing.
      const saved = await loadLastOrder(routeIds, revTag);
      const seed = getExactSeed(routeIds);
      const base = saved && saved.length ? mergeOrder(saved, eligibleIds, seed) : seed ? mergeOrder(seed, eligibleIds, seed) : null;
      await nextFrame();
      const plan = planFromGps(solvable, base, startCoord, coordOf, matrixLookup());
      orderedIds = [...plan.orderedIds, ...hiddenTail];
      if (plan.beforeM !== null) {
        optimizations.push({ at: Date.now(), kind: "start", houses: solvable.length, beforeM: plan.beforeM, afterM: plan.afterM });
      }
    } else {
      // Priority: saved last shift's order → exact seed → on-device solver.
      const saved = await loadLastOrder(routeIds, revTag);
      const seed = getExactSeed(routeIds);
      if (saved && saved.length) {
        orderedIds = mergeOrder(saved, eligibleIds, seed);
      } else if (seed) {
        orderedIds = mergeOrder(seed, eligibleIds, seed);
      } else {
        const solvableSet = new Set(solvable);
        const preKeep = anchorIdsFor(routeIds, allSubscribers()).filter((id) => solvableSet.has(id));
        await nextFrame();
        const quick = optimizeV2({ stopIds: solvable, coordOf, matrixIdOf: matrixLookup(), preKeep, timeBudgetMs: 1000 });
        const r = orderStops({
          stopIds: solvable,
          coordOf,
          matrixIdOf: matrixLookup(),
          start: { kind: "library" },
          fixedIds: preKeep,
          candidates: [quick.orderedIds],
          ms: 3000,
        });
        orderedIds = [...r.orderedIds, ...hiddenTail];
      }
    }

    const s: ShiftState = {
      ...newShift(todayKey(), routeIds, orderedIds, dayIdx, fromGps ? "gps" : "library"),
      startCoord: fromGps ? startCoord : undefined,
      optimizations,
    };
    await saveShift(s);
    setState(s);
    return s;
  }, []);

  // Re-order everything not yet delivered, starting from `here`. Delivered stops
  // stay put at the top; stopped houses stay hidden at the bottom.
  const rerouteFrom = useCallback(async (here: Coord, stoppedIds: readonly string[]) => {
    const s = stateRef.current;
    if (!s) throw new Error("No shift in progress.");
    await nextFrame();
    const plan = planReroute(s.orderedIds, s.deliveredIds, stoppedIds, here, coordLookup(), matrixLookup());
    setState((prev) => {
      if (!prev) return prev;
      const note: Optimization = { at: Date.now(), kind: "reroute", houses: plan.stops, beforeM: plan.beforeM, afterM: plan.afterM };
      const next: ShiftState = { ...prev, orderedIds: plan.orderedIds, startMode: "gps", optimizations: [...(prev.optimizations ?? []), note] };
      void saveShift(next);
      return next;
    });
    return { stops: plan.stops, beforeM: plan.beforeM, afterM: plan.afterM };
  }, []);

  const reorder = useCallback(async (orderedIds: string[]) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = { ...prev, orderedIds };
      void saveShift(next);
      return next;
    });
  }, []);

  const markDelivered = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      if (prev.deliveredIds.includes(id)) return prev;
      const next: ShiftState = {
        ...prev,
        deliveredIds: [...prev.deliveredIds, id],
        skippedIds: prev.skippedIds.filter((x) => x !== id),
      };
      void saveShift(next);
      return next;
    });
  }, []);

  const unmarkDelivered = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = {
        ...prev,
        deliveredIds: prev.deliveredIds.filter((x) => x !== id),
      };
      void saveShift(next);
      return next;
    });
  }, []);

  const markSkipped = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = {
        ...prev,
        skippedIds: prev.skippedIds.includes(id)
          ? prev.skippedIds
          : [...prev.skippedIds, id],
        deliveredIds: prev.deliveredIds.filter((x) => x !== id),
      };
      void saveShift(next);
      return next;
    });
  }, []);

  // Finish: save current order for reuse next shift with these routes, then clear the shift.
  const finish = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    await recordShift(s);
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
  }, []);

  // Shift done: save order, clear the shift. Same as finish; the button is just always-available
  // so Paulo can end the shift even when some stops are unmarked.
  const finishAsDone = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    await recordShift(s);
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
  }, []);

  const reset = useCallback(async () => {
    const s = stateRef.current;
    if (s?.startedAt != null) await stopTracking(s.startedAt);
    await clearShift(todayKey());
    setState(null);
  }, []);

  return { state, ready, start, rerouteFrom, reorder, markDelivered, unmarkDelivered, markSkipped, finish, finishAsDone, reset };
}
