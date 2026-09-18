import { useCallback, useEffect, useRef, useState } from "react";
import type { RouteId, ShiftState } from "@/types";
import { LIBRARY } from "@/data/routes";
import { subscribersForRoutesOn } from "@/data/subscribers";
import { SEED_ORDERS } from "@/data/seed-orders";
import { optimize } from "./optimizer";
import { todayDayIndex } from "./schedule";
import {
  loadShift, saveShift, todayKey, newShift, clearShift,
  loadLastOrder, saveLastOrder, routeSetKey,
} from "./storage";

// Merge a preferred order (from last shift or seed) with today's eligible stops.
// Kept stops keep their preferred position; newcomers are spliced next to their
// seed-order neighbors instead of dumped at the end. Without the seed anchor,
// switching from a weekday shift to a Fri/Sat shift dumped the FriSat stops at
// the tail instead of nesting them into their geographically-correct positions.
function mergeOrder(preferred: string[], eligibleIds: string[], seed: string[] | null): string[] {
  const eligible = new Set(eligibleIds);
  const kept = preferred.filter((id) => eligible.has(id));
  const keptSet = new Set(kept);
  const newcomerIds = eligibleIds.filter((id) => !keptSet.has(id));
  if (!newcomerIds.length) return kept;
  if (!seed || !seed.length) return [...kept, ...newcomerIds];

  const seedIndex = new Map<string, number>();
  seed.forEach((id, i) => seedIndex.set(id, i));

  // Insert newcomers in seed order so earlier ones become anchors for later ones.
  const newcomers = [...newcomerIds].sort((a, b) => {
    const ia = seedIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = seedIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });

  const result = [...kept];
  const inResult = new Set(result);
  for (const nc of newcomers) {
    const ncIdx = seedIndex.get(nc);
    if (ncIdx === undefined) {
      result.push(nc);
      inResult.add(nc);
      continue;
    }
    // Walk backwards through the seed for the closest already-placed stop; insert
    // after it. If nothing behind is placed, walk forward and insert before.
    let anchor: string | null = null;
    let after = true;
    for (let i = ncIdx - 1; i >= 0; i--) {
      if (inResult.has(seed[i])) { anchor = seed[i]; after = true; break; }
    }
    if (!anchor) {
      for (let i = ncIdx + 1; i < seed.length; i++) {
        if (inResult.has(seed[i])) { anchor = seed[i]; after = false; break; }
      }
    }
    if (!anchor) {
      result.push(nc);
      inResult.add(nc);
      continue;
    }
    const pos = result.indexOf(anchor);
    result.splice(after ? pos + 1 : pos, 0, nc);
    inResult.add(nc);
  }
  return result;
}

// Look up a seed for the exact route combination, falling back to concatenating
// individual route seeds where a combined-key seed is missing. Lets "H21+J13" reuse
// H21 driving order + J13 driving order without needing a hand-built combined seed.
function getSeedOrder(routeIds: readonly string[]): string[] | null {
  const exact = SEED_ORDERS[routeSetKey(routeIds)];
  if (exact && exact.length) return exact;
  const sorted = [...routeIds].sort();
  const combined: string[] = [];
  for (const r of sorted) {
    const seed = SEED_ORDERS[r];
    if (seed && seed.length) combined.push(...seed);
  }
  return combined.length ? combined : null;
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

  const start = useCallback(async (routeIds: RouteId[], deliveryDayIdx?: number) => {
    const dayIdx = deliveryDayIdx ?? todayDayIndex();
    const stops = subscribersForRoutesOn(routeIds, dayIdx);
    const eligibleIds = stops.map((s) => s.id);

    // Priority: saved last shift's order → seed order → geographic optimizer
    const saved = await loadLastOrder(routeIds);
    const seed = getSeedOrder(routeIds);
    let orderedIds: string[];
    if (saved && saved.length) {
      orderedIds = mergeOrder(saved, eligibleIds, seed);
    } else if (seed && seed.length) {
      orderedIds = mergeOrder(seed, eligibleIds, seed);
    } else {
      const { ordered } = optimize({ lat: LIBRARY.lat, lng: LIBRARY.lng }, stops);
      orderedIds = ordered.map((x) => x.id);
    }

    const s = newShift(todayKey(), routeIds, orderedIds, dayIdx);
    await saveShift(s);
    setState(s);
    return s;
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
    await saveLastOrder(s.routeIds, s.orderedIds);
    await clearShift(todayKey());
    setState(null);
  }, []);

  // Shift done: save order, clear the shift. Same as finish; the button is just always-available
  // so Paulo can end the shift even when some stops are unmarked.
  const finishAsDone = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    await saveLastOrder(s.routeIds, s.orderedIds);
    await clearShift(todayKey());
    setState(null);
  }, []);

  const reset = useCallback(async () => {
    await clearShift(todayKey());
    setState(null);
  }, []);

  return { state, ready, start, reorder, markDelivered, unmarkDelivered, markSkipped, finish, finishAsDone, reset };
}
