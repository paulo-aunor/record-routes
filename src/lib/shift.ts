import { useCallback, useEffect, useState } from "react";
import type { RouteId, ShiftState } from "@/types";
import { LIBRARY } from "@/data/routes";
import { subscribersForRoutes } from "@/data/subscribers";
import { optimize } from "./optimizer";
import { loadShift, saveShift, todayKey, newShift, clearShift } from "./storage";

export function useShift() {
  const [state, setState] = useState<ShiftState | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadShift(todayKey()).then((s) => {
      setState(s);
      setReady(true);
    });
  }, []);

  const start = useCallback(async (routeIds: RouteId[]) => {
    const stops = subscribersForRoutes(routeIds);
    const { ordered } = optimize({ lat: LIBRARY.lat, lng: LIBRARY.lng }, stops);
    const s = newShift(todayKey(), routeIds, ordered.map((x) => x.id));
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

  const finish = useCallback(async () => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = { ...prev, finishedAt: Date.now() };
      void saveShift(next);
      return next;
    });
  }, []);

  const reset = useCallback(async () => {
    await clearShift(todayKey());
    setState(null);
  }, []);

  return { state, ready, start, reorder, markDelivered, unmarkDelivered, markSkipped, finish, reset };
}
