import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { subscribersForRoutes } from "@/data/subscribers";
import { openInGoogleMaps } from "@/lib/navigation";
import { useShift } from "@/lib/shift";
import type { Subscriber } from "@/types";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Shift() {
  useKeepAwake();
  const router = useRouter();
  const { state, ready, reorder, markDelivered, unmarkDelivered, markSkipped, finish, reset } = useShift();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const stops = useMemo(() => {
    if (!state) return [];
    const bag = subscribersForRoutes(state.routeIds);
    const byId = new Map(bag.map((s) => [s.id, s]));
    const ordered: Subscriber[] = [];
    for (const id of state.orderedIds) {
      const s = byId.get(id);
      if (s) ordered.push(s);
    }
    for (const s of bag) if (!state.orderedIds.includes(s.id)) ordered.push(s);
    return ordered;
  }, [state]);

  if (!ready) {
    return <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>;
  }

  if (!state) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>No shift in progress.</Text>
        <Pressable style={styles.primary} onPress={() => router.replace("/")}>
          <Text style={styles.primaryText}>Go home</Text>
        </Pressable>
      </View>
    );
  }

  const delivered = state.deliveredIds;
  const skipped = state.skippedIds;
  const remaining = stops.filter((s) => !delivered.includes(s.id));
  const nextStop = remaining.find((s) => !skipped.includes(s.id)) ?? remaining[0];
  const allDone = remaining.length === 0;
  const elapsed = state.startedAt ? now - state.startedAt : 0;

  const confirmSkip = (s: Subscriber) => {
    Alert.alert(
      "Skip this stop?",
      `${s.name}\n${s.address}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Skip", style: "destructive", onPress: () => void markSkipped(s.id) },
      ],
    );
  };

  const onFinish = () => {
    Alert.alert("Finish shift?", "Marks the shift complete.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Finish",
        onPress: async () => {
          await finish();
          router.replace("/");
        },
      },
    ]);
  };

  const onReset = () => {
    Alert.alert("Reset shift?", "Clears all delivery marks for today.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: async () => {
          await reset();
          router.replace("/");
        },
      },
    ]);
  };

  const onDragEnd = ({ data }: { data: Subscriber[] }) => {
    void reorder(data.map((s) => s.id));
  };

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Subscriber>) => {
    const isDone = delivered.includes(item.id);
    const isSkipped = skipped.includes(item.id);
    const isNext = nextStop?.id === item.id;
    return (
      <ScaleDecorator>
        <View style={[styles.row, isNext && styles.rowNext, isDone && styles.rowDone, isActive && styles.rowActive]}>
          <Pressable
            style={[styles.rowCheck, isDone && styles.rowCheckOn]}
            onPress={() => (isDone ? unmarkDelivered(item.id) : markDelivered(item.id))}
            hitSlop={12}
          >
            {isDone && <Text style={styles.rowCheckMark}>✓</Text>}
          </Pressable>
          <Pressable
            style={styles.rowBody}
            onPress={() => openInGoogleMaps(item)}
            onLongPress={drag}
            delayLongPress={220}
          >
            <Text style={[styles.rowAddress, isDone && styles.rowStrike]}>{item.address}</Text>
            <Text style={[styles.rowName, isDone && styles.rowStrike]}>{item.name}</Text>
            <Text style={styles.rowMeta}>
              {item.routeId} · {item.postal}
              {isSkipped && "  ·  SKIPPED"}
            </Text>
          </Pressable>
          <Pressable onLongPress={drag} delayLongPress={0} style={styles.dragHandle} hitSlop={12}>
            <Text style={styles.dragHandleText}>≡</Text>
          </Pressable>
        </View>
      </ScaleDecorator>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerRoutes}>{state.routeIds.join(" · ")}  ·  optimized</Text>
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              { width: `${(delivered.length / Math.max(stops.length, 1)) * 100}%` },
            ]}
          />
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.headerStat}>{delivered.length} / {stops.length}</Text>
          <Text style={styles.headerStat}>{formatElapsed(elapsed)}</Text>
          {skipped.length > 0 && <Text style={styles.headerSkip}>{skipped.length} skipped</Text>}
        </View>
      </View>

      {nextStop && !allDone && (
        <Pressable style={styles.next} onPress={() => openInGoogleMaps(nextStop)}>
          <Text style={styles.nextLabel}>NEXT</Text>
          <Text style={styles.nextAddress}>{nextStop.address}</Text>
          <Text style={styles.nextName}>{nextStop.name}</Text>
          <Text style={styles.nextNav}>Tap to navigate ›</Text>
        </Pressable>
      )}

      {allDone && (
        <View style={[styles.next, styles.doneBanner]}>
          <Text style={styles.doneTitle}>All delivered</Text>
          <Text style={styles.doneSub}>Time: {formatElapsed(elapsed)} · Go home.</Text>
          <Pressable style={styles.primary} onPress={onFinish}>
            <Text style={styles.primaryText}>Finish shift</Text>
          </Pressable>
        </View>
      )}

      <DraggableFlatList
        data={stops}
        keyExtractor={(s) => s.id}
        onDragEnd={onDragEnd}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
      />

      <View style={styles.footer}>
        <Text style={styles.footerHint}>Long-press ≡ to reorder · long-press a stop to skip</Text>
        <Pressable style={styles.footerBtn} onPress={onReset}>
          <Text style={styles.footerText}>Reset today's shift</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a", gap: 12 },
  dim: { color: "#888" },

  header: { padding: 16, paddingBottom: 12, borderBottomWidth: 1, borderColor: "#1a1a1a" },
  headerRoutes: { color: "#888", fontSize: 12, letterSpacing: 1, marginBottom: 8 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  headerStat: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  headerSkip: { color: "#facc15", fontSize: 14 },
  progressBar: { height: 6, backgroundColor: "#1a1a1a", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#4ade80" },

  next: {
    backgroundColor: "#0f1a12",
    margin: 16,
    marginTop: 12,
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#4ade80",
  },
  nextLabel: { color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  nextAddress: { color: "#f5f5f5", fontSize: 24, fontWeight: "700", marginTop: 8 },
  nextName: { color: "#aaa", fontSize: 14, marginTop: 4 },
  nextNav: { color: "#4ade80", fontSize: 14, marginTop: 12, fontWeight: "600" },

  doneBanner: { borderColor: "#facc15", backgroundColor: "#1a1305", alignItems: "center", gap: 12 },
  doneTitle: { color: "#facc15", fontSize: 24, fontWeight: "700" },
  doneSub: { color: "#c9a83a", fontSize: 14 },

  list: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: "#141414",
    borderRadius: 10,
    gap: 12,
  },
  rowNext: { backgroundColor: "#101c14", borderWidth: 1, borderColor: "#4ade80" },
  rowDone: { opacity: 0.4 },
  rowActive: { backgroundColor: "#1c1c1c", borderWidth: 1, borderColor: "#666" },
  rowCheck: {
    width: 32, height: 32, borderRadius: 8,
    borderWidth: 2, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
  },
  rowCheckOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  rowCheckMark: { color: "#0a0a0a", fontSize: 18, fontWeight: "700" },
  rowBody: { flex: 1 },
  rowAddress: { color: "#f5f5f5", fontSize: 16, fontWeight: "600" },
  rowName: { color: "#aaa", fontSize: 13, marginTop: 2 },
  rowMeta: { color: "#666", fontSize: 11, marginTop: 4 },
  rowStrike: { textDecorationLine: "line-through" },
  dragHandle: { width: 32, height: 40, alignItems: "center", justifyContent: "center" },
  dragHandleText: { color: "#666", fontSize: 22 },

  primary: { backgroundColor: "#facc15", borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14 },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },

  footer: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderColor: "#1a1a1a" },
  footerHint: { color: "#555", fontSize: 11, textAlign: "center" },
  footerBtn: { padding: 8, alignItems: "center" },
  footerText: { color: "#666", fontSize: 12 },
});
