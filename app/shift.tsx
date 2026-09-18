import { useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { subscribersForRoutes } from "@/data/subscribers";
import { DEPOT_NOTES } from "@/data/depot-notes";
import { openInGoogleMaps } from "@/lib/navigation";
import { noteKey, useNotes } from "@/lib/notes";
import { DAY_NAMES, todayDayIndex } from "@/lib/schedule";
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
  const insets = useSafeAreaInsets();
  const { state, ready, reorder, markDelivered, unmarkDelivered, finish, finishAsDone, reset } = useShift();
  const { notes, setNote } = useNotes();
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<Subscriber | null>(null);
  const [draft, setDraft] = useState("");

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
    return ordered;
  }, [state]);

  if (!ready) return <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>;

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
  const remaining = stops.filter((s) => !delivered.includes(s.id));
  const nextStop = remaining[0];
  const allDone = remaining.length === 0;
  const elapsed = state.startedAt ? now - state.startedAt : 0;

  const openNote = (s: Subscriber) => {
    setEditing(s);
    setDraft(notes[noteKey(s)] ?? "");
  };
  const closeNote = () => { setEditing(null); setDraft(""); };
  const saveNote = () => {
    if (editing) setNote(noteKey(editing), draft);
    closeNote();
  };

  const onFinish = () => {
    Alert.alert("Finish shift?", "Marks the shift complete.", [
      { text: "Cancel", style: "cancel" },
      { text: "Finish", onPress: async () => { await finish(); router.replace("/"); } },
    ]);
  };

  const onShiftDone = () => {
    const remaining = stops.length - state.deliveredIds.length;
    Alert.alert(
      "Shift done?",
      remaining > 0
        ? `Marks the remaining ${remaining} stop${remaining === 1 ? "" : "s"} as delivered and saves this order for next time.`
        : "Marks the shift complete and saves this order for next time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Shift done", onPress: async () => { await finishAsDone(); router.replace("/"); } },
      ],
    );
  };

  const onReset = () => {
    Alert.alert("Reset shift?", "Clears all delivery marks for today.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: async () => { await reset(); router.replace("/"); } },
    ]);
  };

  const onDragEnd = ({ data }: { data: Subscriber[] }) => {
    void reorder(data.map((s) => s.id));
  };

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Subscriber>) => {
    const isDone = delivered.includes(item.id);
    const isNext = nextStop?.id === item.id;
    const userNote = notes[noteKey(item)];
    const depotNote = DEPOT_NOTES[item.id];
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
            {depotNote ? <Text style={styles.rowDepotNote}>📮 {depotNote}</Text> : null}
            {userNote ? <Text style={styles.rowNote}>✎ {userNote}</Text> : null}
            <Text style={styles.rowMeta}>{item.routeId} · {item.postal}{item.schedule ? ` · ${item.schedule}` : ""}</Text>
          </Pressable>
          <Pressable onPress={() => openNote(item)} style={styles.noteBtn} hitSlop={12}>
            <Text style={[styles.noteBtnText, userNote && styles.noteBtnTextActive]}>✎</Text>
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
        <View style={styles.headerTop}>
          <Text style={styles.headerRoutes}>{state.routeIds.join(" · ")}  ·  {DAY_NAMES[state.deliveryDayIdx ?? todayDayIndex()]}</Text>
          <Pressable style={styles.doneBtn} onPress={onShiftDone}>
            <Text style={styles.doneBtnText}>Shift done</Text>
          </Pressable>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${(delivered.length / Math.max(stops.length, 1)) * 100}%` }]} />
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.headerStat}>{delivered.length} / {stops.length}</Text>
          <Text style={styles.headerStat}>{formatElapsed(elapsed)}</Text>
        </View>
      </View>

      {nextStop && !allDone && (
        <Pressable style={styles.next} onPress={() => openInGoogleMaps(nextStop)}>
          <Text style={styles.nextLabel}>NEXT</Text>
          <Text style={styles.nextAddress}>{nextStop.address}</Text>
          <Text style={styles.nextName}>{nextStop.name}</Text>
          {DEPOT_NOTES[nextStop.id] ? <Text style={styles.nextDepotNote}>📮 {DEPOT_NOTES[nextStop.id]}</Text> : null}
          {notes[noteKey(nextStop)] ? <Text style={styles.nextNote}>✎ {notes[noteKey(nextStop)]}</Text> : null}
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
        style={{ flex: 1 }}
        containerStyle={{ flex: 1 }}
        contentContainerStyle={[styles.list, { paddingBottom: 24 }]}
      />

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Text style={styles.footerHint}>Tap ✎ to add note · long-press ≡ to reorder</Text>
        <Pressable style={styles.footerBtn} onPress={onReset}>
          <Text style={styles.footerText}>Reset today's shift</Text>
        </Pressable>
      </View>

      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={closeNote}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
          <Pressable style={styles.modalBackdrop} onPress={closeNote} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editing?.address}</Text>
            <Text style={styles.modalSub}>{editing?.name} · {editing?.postal}</Text>
            <TextInput
              style={styles.modalInput}
              multiline
              placeholder="e.g. 'side door', 'red brick, no number', 'watch for dog'"
              placeholderTextColor="#555"
              value={draft}
              onChangeText={setDraft}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={closeNote}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalSave} onPress={saveNote}>
                <Text style={styles.modalSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a", gap: 12 },
  dim: { color: "#888" },

  header: { padding: 16, paddingBottom: 12, borderBottomWidth: 1, borderColor: "#1a1a1a" },
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 },
  headerRoutes: { color: "#888", fontSize: 12, letterSpacing: 1, flex: 1 },
  doneBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: "#facc15" },
  doneBtnText: { color: "#0a0a0a", fontSize: 13, fontWeight: "700" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  headerStat: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  progressBar: { height: 6, backgroundColor: "#1a1a1a", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#4ade80" },

  next: {
    backgroundColor: "#0f1a12", margin: 16, marginTop: 12, padding: 20,
    borderRadius: 16, borderWidth: 1, borderColor: "#4ade80",
  },
  nextLabel: { color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  nextAddress: { color: "#f5f5f5", fontSize: 24, fontWeight: "700", marginTop: 8 },
  nextName: { color: "#aaa", fontSize: 14, marginTop: 4 },
  nextDepotNote: { color: "#60a5fa", fontSize: 14, marginTop: 6 },
  nextNote: { color: "#facc15", fontSize: 14, marginTop: 6, fontStyle: "italic" },
  nextNav: { color: "#4ade80", fontSize: 14, marginTop: 12, fontWeight: "600" },

  doneBanner: { borderColor: "#facc15", backgroundColor: "#1a1305", alignItems: "center", gap: 12 },
  doneTitle: { color: "#facc15", fontSize: 24, fontWeight: "700" },
  doneSub: { color: "#c9a83a", fontSize: 14 },

  list: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 12,
    marginBottom: 8, backgroundColor: "#141414", borderRadius: 10, gap: 8,
  },
  rowNext: { backgroundColor: "#101c14", borderWidth: 1, borderColor: "#4ade80" },
  rowDone: { opacity: 0.4 },
  rowActive: { backgroundColor: "#1c1c1c", borderWidth: 1, borderColor: "#666" },
  rowCheck: {
    width: 32, height: 32, borderRadius: 8, borderWidth: 2, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
  },
  rowCheckOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  rowCheckMark: { color: "#0a0a0a", fontSize: 18, fontWeight: "700" },
  rowBody: { flex: 1 },
  rowAddress: { color: "#f5f5f5", fontSize: 16, fontWeight: "600" },
  rowName: { color: "#aaa", fontSize: 13, marginTop: 2 },
  rowDepotNote: { color: "#60a5fa", fontSize: 12, marginTop: 4 },
  rowNote: { color: "#facc15", fontSize: 12, marginTop: 4, fontStyle: "italic" },
  rowMeta: { color: "#666", fontSize: 11, marginTop: 4 },
  rowStrike: { textDecorationLine: "line-through" },
  noteBtn: { width: 28, height: 40, alignItems: "center", justifyContent: "center" },
  noteBtnText: { color: "#444", fontSize: 18 },
  noteBtnTextActive: { color: "#facc15" },
  dragHandle: { width: 28, height: 40, alignItems: "center", justifyContent: "center" },
  dragHandleText: { color: "#666", fontSize: 22 },

  primary: { backgroundColor: "#facc15", borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14 },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },

  footer: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderColor: "#1a1a1a" },
  footerHint: { color: "#555", fontSize: 11, textAlign: "center" },
  footerBtn: { padding: 8, alignItems: "center" },
  footerText: { color: "#666", fontSize: 12 },

  modalWrap: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  modalCard: {
    backgroundColor: "#141414", padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: "#333", gap: 12,
  },
  modalTitle: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  modalSub: { color: "#888", fontSize: 13 },
  modalInput: {
    backgroundColor: "#0a0a0a", color: "#f5f5f5", padding: 14, borderRadius: 10,
    minHeight: 120, fontSize: 16, textAlignVertical: "top",
    borderWidth: 1, borderColor: "#333",
  },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  modalCancel: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: "#1f1f1f", alignItems: "center" },
  modalCancelText: { color: "#aaa", fontWeight: "600" },
  modalSave: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: "#facc15", alignItems: "center" },
  modalSaveText: { color: "#0a0a0a", fontWeight: "700" },
});
