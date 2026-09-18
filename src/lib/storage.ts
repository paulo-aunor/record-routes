import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RouteId, ShiftState } from "@/types";

const KEY_PREFIX = "@rr/shift/";
// v7: bumped 2026-09-10 for Sept subscriber sync (6 adds + 7 exclusions) + fresh OR-Tools seeds.
// Fresh start = OR-Tools seed wins.
const LAST_ORDER_PREFIX = "@rr/lastOrder/v7/";

export function todayKey(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export async function loadShift(date: string): Promise<ShiftState | null> {
  const raw = await AsyncStorage.getItem(KEY_PREFIX + date);
  return raw ? JSON.parse(raw) : null;
}

export async function saveShift(state: ShiftState): Promise<void> {
  await AsyncStorage.setItem(KEY_PREFIX + state.date, JSON.stringify(state));
}

export async function clearShift(date: string): Promise<void> {
  await AsyncStorage.removeItem(KEY_PREFIX + date);
}

export function newShift(
  date: string,
  routeIds: RouteId[],
  orderedIds: string[],
  deliveryDayIdx: number,
): ShiftState {
  return {
    date,
    routeIds,
    startedAt: Date.now(),
    finishedAt: null,
    deliveredIds: [],
    skippedIds: [],
    orderedIds,
    deliveryDayIdx,
  };
}

export function routeSetKey(routeIds: readonly string[]): string {
  return [...routeIds].sort().join("+");
}

export async function loadLastOrder(routeIds: readonly string[]): Promise<string[] | null> {
  const raw = await AsyncStorage.getItem(LAST_ORDER_PREFIX + routeSetKey(routeIds));
  return raw ? JSON.parse(raw) : null;
}

export async function saveLastOrder(routeIds: readonly string[], orderedIds: string[]): Promise<void> {
  await AsyncStorage.setItem(LAST_ORDER_PREFIX + routeSetKey(routeIds), JSON.stringify(orderedIds));
}
