import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ChronologyEntry, ProofView } from "../v2-api";
import { chronologyCategoryLabel, humanChronologyTitle, isShipmentAfterFinalization } from "../copy/chronology";
import { formatDate, formatTime } from "../copy/format";
import { recordActivityEvents, recordActivityGroups, recordEventFilters } from "../copy/proof-record";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { PressableScale } from "./motion";

export function ProofRecordTimeline({ entries, auditEvents, finalizedAt, filter, onFilter, onSelect }: {
  entries: ChronologyEntry[];
  auditEvents?: ProofView["events"];
  finalizedAt?: string | null;
  filter: string;
  onFilter: (category: string) => void;
  onSelect: (entry: ChronologyEntry) => void;
}) {
  const { colors } = useTheme();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const detailed = filter !== "MILESTONES";
  const ordered = recordActivityEvents(entries, detailed);
  const filters = recordEventFilters(entries);
  const selected = filters.some(item => item.category === filter) ? filter : "ALL";
  const visible = detailed
    ? ordered.filter(entry => selected === "ALL" || entry.category === selected).map(entry => ({ key: entry.id, entry, entries: [entry], access: false }))
    : recordActivityGroups(entries, auditEvents);
  return <View style={styles.root} accessibilityLabel="Proof activity">
    <View style={styles.modeRow}>
      {[{ key: "MILESTONES", label: "Highlights" }, { key: "ALL", label: "Detailed history" }].map(mode => <PressableScale key={mode.key} accessibilityRole="button" accessibilityState={{ selected: mode.key === "MILESTONES" ? !detailed : detailed }} onPress={() => onFilter(mode.key)} style={styles.modeButton}>
        <Text style={[styles.filterLabel, { color: (mode.key === "MILESTONES" ? !detailed : detailed) ? colors.accentText : colors.textSecondary, fontWeight: (mode.key === "MILESTONES" ? !detailed : detailed) ? "700" : "400" }]}>{mode.label}</Text>
      </PressableScale>)}
    </View>
    {detailed && entries.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} accessibilityLabel="Timeline filters">
      {filters.map(item => <PressableScale key={item.category} onPress={() => onFilter(item.category)} accessibilityRole="button" accessibilityState={{ selected: selected === item.category }} accessibilityLabel={`${item.label}, ${item.count} events`} style={[styles.filter, { borderColor: selected === item.category ? colors.accentSoftBorder : colors.border, backgroundColor: selected === item.category ? colors.accentSoft : colors.surface }]}>
        <Text style={[styles.filterLabel, { color: selected === item.category ? colors.accentText : colors.textSecondary }]}>{item.label}  {item.count}</Text>
      </PressableScale>)}
    </ScrollView> : null}
    {!detailed && expandedGroups.size > 0 ? <Text style={[styles.groupNote, { color: colors.textSecondary }]}>Access is grouped by the same known account or link within 30-minute UTC windows. Counts are events, not people.</Text> : null}
    {!visible.length ? <View style={styles.empty}>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{detailed ? "No events in this view." : "Updates will appear here as this Proof progresses."}</Text>
    </View> : visible.map((group, index) => {
      const { entry } = group;
      const expanded = expandedGroups.has(group.key);
      const toggleGroup = () => setExpandedGroups(current => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; });
      const preserved = entry.eventType === "PROOF_FINALIZED";
      const afterCore = isShipmentAfterFinalization(entry.occurredAt, finalizedAt, entry.category);
      const title = group.access ? `${group.entries.length} access ${group.entries.length === 1 ? "event" : "events"}` : humanChronologyTitle(entry.eventType, entry.title);
      const previous = visible[index - 1]?.entry;
      const newDay = !previous || new Date(previous.occurredAt).toDateString() !== new Date(entry.occurredAt).toDateString();
      const tone = preserved ? colors.success : entry.category === "COMMERCE" ? colors.accent : colors.textSecondary;
      return <View key={group.key} style={styles.entry}>
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
            <PressableScale onPress={() => group.access ? toggleGroup() : onSelect(entry)} accessibilityRole="button" accessibilityState={group.access ? { expanded } : undefined} accessibilityLabel={`${title}. ${formatDate(entry.occurredAt)}, ${formatTime(entry.occurredAt)}. View event details.`} style={[styles.card, { borderColor: preserved ? colors.successSoftBorder : colors.border, backgroundColor: preserved ? colors.successSoft : colors.surface }]}>
              {detailed ? <View style={styles.cardTop}>
                <Text style={[styles.source, { color: colors.textSecondary }]}>{chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType)}</Text>
                {preserved ? <View style={styles.preserved}><Ionicons name="shield-checkmark-outline" size={13} color={colors.successText} /><Text style={[styles.time, { color: colors.successText }]}>Preserved</Text></View> : <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />}
              </View> : null}
              <View style={styles.cardTop}><Text style={[styles.title, { color: colors.textPrimary, flex: 1 }]}>{title}</Text>{!detailed ? <Ionicons name="chevron-forward" size={14} color={colors.textMuted} /> : null}</View>
              {detailed && entry.description ? <Text style={[styles.body, { color: colors.textSecondary }]}>{entry.description}</Text> : null}
              {detailed && afterCore ? <Text style={[styles.time, { color: colors.textSecondary }]}>Shipment update · recorded separately from the frozen core</Text> : null}
            </PressableScale>
            {group.access && expanded ? <View style={[styles.accessDetails, { borderColor: colors.divider }]}>{group.entries.map(access => <PressableScale key={access.id} accessibilityRole="button" accessibilityLabel={`Access event at ${access.occurredAt}. View exact details.`} onPress={() => onSelect(access)} style={styles.accessRow}><View style={{ flex: 1, gap: 4 }}><Text style={[styles.body, { color: colors.textPrimary }]}>{humanChronologyTitle(access.eventType, access.title)}</Text><Text style={[styles.time, { color: colors.textSecondary }]}>{formatDate(access.occurredAt)} · {formatTime(access.occurredAt)}</Text></View><Ionicons name="chevron-forward" size={16} color={colors.textSecondary} /></PressableScale>)}</View> : null}
          </View>
        </View>
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 0 }, groupNote: { ...typography.caption, marginBottom: 16 }, accessDetails: { borderLeftWidth: 1, marginLeft: 12, paddingLeft: 12 }, accessRow: { minHeight: 48, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 }, modeRow: { flexDirection: "row", flexWrap: "wrap", gap: 20, marginBottom: 16 }, modeButton: { minHeight: 48, justifyContent: "center" }, filters: { flexDirection: "row", gap: 8, paddingBottom: 16 },
  filter: { paddingHorizontal: 10, paddingVertical: 12, borderWidth: 1, borderRadius: 10, minHeight: 48, justifyContent: "center" },
  filterLabel: { ...typography.secondary }, empty: { gap: 12, paddingVertical: 24 },
  entry: { gap: 10 }, dateRow: { marginLeft: 48, flexDirection: "row", gap: 8, flexWrap: "wrap" },
  date: { ...typography.caption }, time: { ...typography.caption }, eventRow: { flexDirection: "row", gap: 12 },
  rail: { width: 36, alignItems: "center" }, node: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  line: { width: 1, flex: 1, minHeight: 22, marginTop: 5 }, cardColumn: { flex: 1, paddingBottom: 16 },
  card: { borderRadius: 10, padding: 10, gap: 8, minHeight: 48 }, cardTop: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
  source: { ...typography.caption, flex: 1 }, preserved: { flexDirection: "row", gap: 4, alignItems: "center" }, title: { ...typography.bodyStrong },
  body: { ...typography.body }, end: { flexDirection: "row", gap: 10, alignItems: "center", paddingTop: 8 }, endDot: { width: 6, height: 6, borderRadius: 3 },
});
