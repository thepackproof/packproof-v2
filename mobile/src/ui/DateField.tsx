import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";

function parseIso(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(value: string): string {
  const date = parseIso(value);
  return date
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)
    : "Select date";
}

export function DateField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = parseIso(props.value);
  const [cursor, setCursor] = useState(() => {
    const base = selected ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  useEffect(() => {
    if (!open) return;
    const base = parseIso(props.value) ?? new Date();
    setCursor(new Date(base.getFullYear(), base.getMonth(), 1));
  }, [open, props.value]);

  const cells = useMemo(() => {
    const firstWeekday = cursor.getDay();
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const values: Array<number | null> = Array(firstWeekday).fill(null);
    for (let day = 1; day <= days; day += 1) values.push(day);
    while (values.length % 7) values.push(null);
    return values;
  }, [cursor]);

  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(cursor);
  const today = new Date();

  function choose(day: number) {
    props.onChange(toIso(new Date(cursor.getFullYear(), cursor.getMonth(), day)));
    setOpen(false);
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textPrimary }]}>{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}. ${props.value ? displayDate(props.value) : "No date selected"}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.field,
          {
            borderColor: colors.border,
            backgroundColor: colors.inputBackground,
            opacity: pressed ? 0.82 : 1,
          },
        ]}
      >
        <Text style={[styles.value, { color: props.value ? colors.textPrimary : colors.textMuted }]}>{displayDate(props.value)}</Text>
        <Ionicons name="calendar-outline" size={20} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            accessibilityViewIsModal
            onPress={(event) => event.stopPropagation()}
            style={[styles.modal, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={styles.monthHeader}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                hitSlop={10}
                onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
                style={styles.iconButton}
              >
                <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
              </Pressable>
              <Text style={[styles.monthTitle, { color: colors.textPrimary }]}>{monthLabel}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Next month"
                hitSlop={10}
                onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
                style={styles.iconButton}
              >
                <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
              </Pressable>
            </View>
            <View style={styles.weekRow}>
              {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
                <Text key={`${day}-${index}`} style={[styles.weekday, { color: colors.textSecondary }]}>{day}</Text>
              ))}
            </View>
            <View style={styles.grid}>
              {cells.map((day, index) => {
                if (!day) return <View key={`blank-${index}`} style={styles.dayCell} />;
                const isSelected = selected?.getFullYear() === cursor.getFullYear() && selected?.getMonth() === cursor.getMonth() && selected?.getDate() === day;
                const isToday = today.getFullYear() === cursor.getFullYear() && today.getMonth() === cursor.getMonth() && today.getDate() === day;
                return (
                  <Pressable
                    key={day}
                    accessibilityRole="button"
                    accessibilityLabel={new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(cursor.getFullYear(), cursor.getMonth(), day))}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => choose(day)}
                    style={[
                      styles.dayCell,
                      isSelected ? { backgroundColor: colors.accent } : null,
                      isToday && !isSelected ? { borderColor: colors.accent, borderWidth: 1 } : null,
                    ]}
                  >
                    <Text style={[styles.dayText, { color: isSelected ? "#FFFFFF" : colors.textPrimary }]}>{day}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.actions}>
              {props.optional ? (
                <Pressable accessibilityRole="button" onPress={() => { props.onChange(""); setOpen(false); }} style={styles.actionButton}>
                  <Text style={[styles.actionText, { color: colors.textSecondary }]}>Clear</Text>
                </Pressable>
              ) : <View />}
              <Pressable accessibilityRole="button" onPress={() => { props.onChange(toIso(today)); setOpen(false); }} style={styles.actionButton}>
                <Text style={[styles.actionText, { color: colors.accentText }]}>Today</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...typography.secondaryStrong },
  field: { minHeight: 48, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  value: { ...typography.body },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  modal: { width: "100%", maxWidth: 420, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md },
  monthHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  monthTitle: { ...typography.cardTitle },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  weekRow: { flexDirection: "row" },
  weekday: { width: "14.2857%", textAlign: "center", ...typography.caption },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  dayCell: { width: "14.2857%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 999 },
  dayText: { ...typography.secondaryStrong },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.sm },
  actionButton: { minHeight: 44, minWidth: 72, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md },
  actionText: { ...typography.secondaryStrong },
});
