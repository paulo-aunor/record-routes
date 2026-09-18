import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { Subscriber } from "@/types";

const KEY = "@rr/notes";

export function noteKey(sub: Pick<Subscriber, "address" | "postal">): string {
  const addr = sub.address.toUpperCase().replace(/\s+/g, " ").trim();
  const postal = sub.postal.toUpperCase().replace(/\s+/g, " ").trim();
  return `${addr}|${postal}`;
}

export function useNotes() {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((raw) => {
      if (raw) {
        try { setNotes(JSON.parse(raw)); } catch { /* corrupt, start empty */ }
      }
      setReady(true);
    });
  }, []);

  const setNote = useCallback((key: string, text: string) => {
    setNotes((prev) => {
      const next = { ...prev };
      const trimmed = text.trim();
      if (trimmed === "") delete next[key];
      else next[key] = trimmed;
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  return { notes, setNote, ready };
}
