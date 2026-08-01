import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RouteId, ShiftState } from "@/types";

const SHIFT_PREFIX = "shift:";

export function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function keyFor(date: string): string {
  return `${SHIFT_PREFIX}${date}`;
}

export async function loadShift(date: string): Promise<ShiftState | null> {
  const raw = await AsyncStorage.getItem(keyFor(date));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShiftState;
  } catch {
    return null;
  }
}

export async function saveShift(state: ShiftState): Promise<void> {
  await AsyncStorage.setItem(keyFor(state.date), JSON.stringify(state));
}

export async function clearShift(date: string): Promise<void> {
  await AsyncStorage.removeItem(keyFor(date));
}

export function newShift(date: string, routeIds: RouteId[], orderedIds: string[]): ShiftState {
  return {
    date,
    routeIds,
    startedAt: Date.now(),
    finishedAt: null,
    deliveredIds: [],
    skippedIds: [],
    orderedIds,
  };
}
