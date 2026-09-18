import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ROUTES, LIBRARY } from "@/data/routes";
import { countByRoute, countByRouteOn } from "@/data/subscribers";
import { DAY_NAMES, todayDayIndex } from "@/lib/schedule";
import { useShift } from "@/lib/shift";
import type { RouteId } from "@/types";

export default function Home() {
  const router = useRouter();
  const { state, ready, start, reset } = useShift();
  const [selected, setSelected] = useState<Set<RouteId>>(new Set());
  const realToday = useMemo(() => todayDayIndex(), []);
  const [dayIdx, setDayIdx] = useState<number>(realToday);
  const dayName = DAY_NAMES[dayIdx];
  const counts = useMemo(() => countByRoute(), []);
  const dayCounts = useMemo(() => countByRouteOn(dayIdx), [dayIdx]);

  const toggle = (id: RouteId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(ROUTES.map((r) => r.id)));

  const canStart = selected.size > 0 && !state;

  const onStart = async () => {
    await start(Array.from(selected), dayIdx);
    router.push("/shift");
  };

  const onResume = () => router.push("/shift");

  const totalSelected = Array.from(selected).reduce((n, id) => n + (dayCounts[id] ?? 0), 0);

  if (!ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {state && !state.finishedAt && (
        <Pressable style={[styles.card, styles.resumeCard]} onPress={onResume}>
          <Text style={styles.resumeTitle}>Shift in progress</Text>
          <Text style={styles.resumeSub}>
            {state.deliveredIds.length} delivered · tap to continue
          </Text>
        </Pressable>
      )}

      <Text style={styles.section}>Delivering for</Text>
      <View style={styles.dayRow}>
        {DAY_NAMES.map((name, i) => {
          const isSelected = i === dayIdx;
          const isRealToday = i === realToday;
          return (
            <Pressable
              key={i}
              style={[styles.dayPill, isSelected && styles.dayPillActive]}
              onPress={() => setDayIdx(i)}
            >
              <Text style={[styles.dayPillText, isSelected && styles.dayPillTextActive]}>{name}</Text>
              {isRealToday && <View style={[styles.dayPillDot, isSelected && styles.dayPillDotOnActive]} />}
            </Pressable>
          );
        })}
      </View>
      {dayIdx !== realToday && (
        <Pressable style={styles.linkBtn} onPress={() => setDayIdx(realToday)}>
          <Text style={styles.linkText}>Reset to today ({DAY_NAMES[realToday]})</Text>
        </Pressable>
      )}

      <Text style={styles.section}>Pick routes · {dayName}</Text>

      {ROUTES.map((r) => {
        const isOn = selected.has(r.id);
        const today = dayCounts[r.id] ?? 0;
        const total = counts[r.id] ?? 0;
        const metaText = today === total
          ? `${r.city} · ${r.postalPrefix} · ${total} stops`
          : `${r.city} · ${r.postalPrefix} · ${today} today (of ${total})`;
        return (
          <Pressable
            key={r.id}
            style={[styles.card, isOn && styles.cardOn]}
            onPress={() => toggle(r.id)}
          >
            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.routeCode}>{r.id}</Text>
                <Text style={styles.routeMeta}>{metaText}</Text>
              </View>
              <View style={[styles.checkbox, isOn && styles.checkboxOn]}>
                {isOn && <Text style={styles.checkmark}>✓</Text>}
              </View>
            </View>
          </Pressable>
        );
      })}

      <Pressable style={styles.linkBtn} onPress={selectAll}>
        <Text style={styles.linkText}>Select all 3</Text>
      </Pressable>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {selected.size === 0
            ? "No routes selected"
            : `${totalSelected} stops · start from ${LIBRARY.name}`}
        </Text>
      </View>

      <Pressable
        style={[styles.primary, !canStart && styles.primaryDisabled]}
        onPress={onStart}
        disabled={!canStart}
      >
        <Text style={styles.primaryText}>
          {state ? "Reset first" : "Start shift"}
        </Text>
      </Pressable>

      {state && (
        <Pressable style={styles.dangerBtn} onPress={reset}>
          <Text style={styles.dangerText}>Reset today's shift</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a" },
  dim: { color: "#888" },
  section: { color: "#aaa", fontSize: 14, textTransform: "uppercase", letterSpacing: 1, marginTop: 8, marginBottom: 4 },
  card: {
    backgroundColor: "#161616",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#222",
  },
  cardOn: { borderColor: "#4ade80", backgroundColor: "#0f1a12" },
  resumeCard: { backgroundColor: "#1a1305", borderColor: "#facc15" },
  resumeTitle: { color: "#facc15", fontSize: 18, fontWeight: "700" },
  resumeSub: { color: "#c9a83a", marginTop: 4 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  routeCode: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  routeMeta: { color: "#888", fontSize: 14, marginTop: 4 },
  checkbox: {
    width: 32, height: 32, borderRadius: 8,
    borderWidth: 2, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
  },
  checkboxOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  checkmark: { color: "#0a0a0a", fontSize: 20, fontWeight: "700" },
  linkBtn: { paddingVertical: 8, alignItems: "center" },
  linkText: { color: "#60a5fa", fontSize: 14 },
  dayRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  dayPill: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: "#161616", borderWidth: 1, borderColor: "#222",
    alignItems: "center", justifyContent: "center",
  },
  dayPillActive: { backgroundColor: "#facc15", borderColor: "#facc15" },
  dayPillText: { color: "#aaa", fontSize: 13, fontWeight: "600" },
  dayPillTextActive: { color: "#0a0a0a", fontWeight: "700" },
  dayPillDot: {
    width: 4, height: 4, borderRadius: 2, backgroundColor: "#4ade80", marginTop: 4,
  },
  dayPillDotOnActive: { backgroundColor: "#0a0a0a" },
  summary: { paddingVertical: 8 },
  summaryText: { color: "#aaa", textAlign: "center" },
  primary: {
    backgroundColor: "#4ade80",
    borderRadius: 12,
    padding: 18,
    alignItems: "center",
    marginTop: 8,
  },
  primaryDisabled: { backgroundColor: "#333" },
  primaryText: { color: "#0a0a0a", fontSize: 18, fontWeight: "700" },
  dangerBtn: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  dangerText: { color: "#f87171", fontSize: 14 },
});
