import { useCallback, useEffect, useRef, useState } from "react";
import type { RouteId, ShiftState } from "@/types";
import { anchorIdsFor } from "@/data/anchors";
import { SEED_ORDERS } from "@/data/seed-orders";
import { isAtLibrary } from "./location";
import { matrixIdFor } from "./matrixAlias";
import { mergeOrder } from "./mergeOrder";
import { optimize as optimizeV2, type Coord } from "./optimizer-v2";
import {
  allSubscribers, importedSeed, isImportedRoute, revisionTag, subscribersForRoutes, subscribersForRoutesOn,
} from "./registry";
import { todayDayIndex } from "./schedule";
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
): { orderedIds: string[]; stops: number } {
  const stopped = new Set(stoppedIds);
  const delivered = new Set(deliveredIds);
  const doneInOrder = orderedIds.filter((id) => delivered.has(id));
  const remaining = orderedIds.filter((id) => !delivered.has(id) && !stopped.has(id));
  const hidden = orderedIds.filter((id) => !delivered.has(id) && stopped.has(id));
  if (remaining.length === 0) throw new Error("Nothing left to re-route.");
  const solved = optimizeV2({ stopIds: remaining, startCoord: here, coordOf, matrixIdOf, timeBudgetMs: 3000 });
  return { orderedIds: [...doneInOrder, ...solved.orderedIds, ...hidden], stops: remaining.length };
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
    const dayIdx = deliveryDayIdx ?? todayDayIndex();
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
    if (fromGps) {
      // Away from the library: library-anchored seeds and saved orders don't fit,
      // so solve from where Paulo is standing.
      await nextFrame();
      const r = optimizeV2({ stopIds: solvable, startCoord, coordOf, matrixIdOf: matrixLookup(), timeBudgetMs: 4000 });
      orderedIds = [...r.orderedIds, ...hiddenTail];
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
        const r = optimizeV2({ stopIds: solvable, coordOf, matrixIdOf: matrixLookup(), preKeep, timeBudgetMs: 3000 });
        orderedIds = [...r.orderedIds, ...hiddenTail];
      }
    }

    const s = newShift(todayKey(), routeIds, orderedIds, dayIdx, fromGps ? "gps" : "library");
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
      const next: ShiftState = { ...prev, orderedIds: plan.orderedIds, startMode: "gps" };
      void saveShift(next);
      return next;
    });
    return { stops: plan.stops };
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
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
  }, []);

  // Shift done: save order, clear the shift. Same as finish; the button is just always-available
  // so Paulo can end the shift even when some stops are unmarked.
  const finishAsDone = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
  }, []);

  const reset = useCallback(async () => {
    await clearShift(todayKey());
    setState(null);
  }, []);

  return { state, ready, start, rerouteFrom, reorder, markDelivered, unmarkDelivered, markSkipped, finish, finishAsDone, reset };
}
