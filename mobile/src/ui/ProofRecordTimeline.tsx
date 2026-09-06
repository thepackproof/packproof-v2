import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ChronologyEntry } from "../v2-api";
import { chronologyCategoryLabel, isShipmentAfterFinalization } from "../copy/chronology";
import { formatDate, formatTime } from "../copy/format";
import { orderedRecordEvents, recordEventFilters } from "../copy/proof-record";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { PressableScale } from "./motion";

export function ProofRecordTimeline({ entries, finalizedAt, filter, onFilter, onSelect }: {
  entries: ChronologyEntry[];
  finalizedAt?: string | null;
  filter: string;
  onFilter: (category: string) => void;
  onSelect: (entry: ChronologyEntry) => void;
}) {
  const { colors } = useTheme();
  const ordered = orderedRecordEvents(entries);
  const filters = recordEventFilters(ordered);
  const selected = filters.some(item => item.category === filter) ? filter : "ALL";
  const visible = ordered.filter(entry => selected === "ALL" || entry.category === selected);
  return <View style={styles.root} accessibilityLabel="Proof timeline">
    {entries.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} accessibilityLabel="Timeline filters">
      {filters.map(item => <PressableScale key={item.category} onPress={() => onFilter(item.category)} accessibilityRole="button" accessibilityState={{ selected: selected === item.category }} accessibilityLabel={`${item.label}, ${item.count} events`} style={[styles.filter, { borderColor: selected === item.category ? colors.accentSoftBorder : colors.border, backgroundColor: selected === item.category ? colors.accentSoft : colors.surface }]}>
        <Text style={[styles.filterLabel, { color: selected === item.category ? colors.accentText : colors.textSecondary }]}>{item.label}  {item.count}</Text>
      </PressableScale>)}
    </ScrollView> : null}
    {!visible.length ? <View style={styles.empty}>
      <Ionicons name="time-outline" size={32} color={colors.accent} />
      <Text style={[styles.title, { color: colors.textPrimary }]}>Your story starts here.</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>Recorded events will appear in this timeline.</Text>
    </View> : visible.map((entry, index) => {
      const preserved = entry.eventType === "PROOF_FINALIZED";
      const afterCore = isShipmentAfterFinalization(entry.occurredAt, finalizedAt, entry.category);
      const previous = visible[index - 1];
      const newDay = !previous || new Date(previous.occurredAt).toDateString() !== new Date(entry.occurredAt).toDateString();
      const tone = preserved ? colors.success : entry.category === "COMMERCE" ? colors.accent : colors.textSecondary;
      return <View key={entry.id} style={styles.entry}>
        <View style={styles.dateRow}>
          {newDay ? <Text style={[styles.date, { color: colors.textSecondary }]}>{formatDate(entry.occurredAt) || "Time unavailable"}</Text> : null}
          <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(entry.occurredAt)}</Text>
        </View>
        <View style={styles.eventRow}>
          <View style={styles.rail}>
            <View style={[styles.node, { borderColor: preserved ? colors.success : colors.border, backgroundColor: preserved ? colors.success : entry.category === "COMMERCE" ? colors.accentSoft : colors.surface }]}>
              <Ionicons name={preserved ? "shield-checkmark-outline" : entry.category === "SHIPMENT" ? "location-outline" : entry.category === "COMMERCE" ? "storefront-outline" : "cube-outline"} size={18} color={preserved ? colors.background : tone} />
            </View>
            {index < visible.length - 1 ? <View style={[styles.line, { backgroundColor: colors.divider }]} /> : null}
          </View>
          <View style={styles.cardColumn}>
            <PressableScale onPress={() => onSelect(entry)} accessibilityRole="button" accessibilityLabel={`${entry.title}. ${formatDate(entry.occurredAt)}, ${formatTime(entry.occurredAt)}. View event details.`} style={[styles.card, { borderColor: preserved ? colors.successSoftBorder : colors.border, backgroundColor: preserved ? colors.successSoft : colors.surface }]}>
              <View style={styles.cardTop}>
                <Text style={[styles.source, { color: colors.textSecondary }]}>{chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType)}</Text>
                {preserved ? <View style={styles.preserved}><Ionicons name="shield-checkmark-outline" size={13} color={colors.successText} /><Text style={[styles.time, { color: colors.successText }]}>Preserved</Text></View> : <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />}
              </View>
              <Text style={[styles.title, { color: colors.textPrimary }]}>{entry.title}</Text>
              {entry.description ? <Text style={[styles.body, { color: colors.textSecondary }]}>{entry.description}</Text> : null}
              {afterCore ? <Text style={[styles.time, { color: colors.textSecondary }]}>Shipment update · recorded separately from the frozen core</Text> : null}
            </PressableScale>
          </View>
        </View>
      </View>;
    })}
    <View style={styles.end}><View style={[styles.endDot, { backgroundColor: colors.border }]} /><Text style={[styles.time, { color: colors.textMuted }]}>Every recorded step, in order.</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 0 }, filters: { flexDirection: "row", gap: 8, paddingBottom: 28 },
  filter: { paddingHorizontal: 10, paddingVertical: 12, borderWidth: 1, borderRadius: 10, minHeight: 44, justifyContent: "center" },
  filterLabel: { ...typography.caption, fontSize: 13 }, empty: { gap: 12, paddingVertical: 24 },
  entry: { gap: 10 }, dateRow: { marginLeft: 48, flexDirection: "row", gap: 8, flexWrap: "wrap" },
  date: { ...typography.caption }, time: { ...typography.caption }, eventRow: { flexDirection: "row", gap: 12 },
  rail: { width: 36, alignItems: "center" }, node: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  line: { width: 1, flex: 1, minHeight: 22, marginTop: 5 }, cardColumn: { flex: 1, paddingBottom: 24 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 }, cardTop: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
  source: { ...typography.caption, flex: 1 }, preserved: { flexDirection: "row", gap: 4, alignItems: "center" }, title: { ...typography.bodyStrong },
  body: { ...typography.body }, end: { flexDirection: "row", gap: 10, alignItems: "center", paddingTop: 8 }, endDot: { width: 6, height: 6, borderRadius: 3 },
});
