import { useState, type ReactNode } from "react";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { CasePreview } from "../signature";
import { useTheme } from "../theme/ThemeProvider";
import { spacing, typography } from "../theme/tokens";
import { Button } from "./Button";
import { FadeSlideIn, PressableScale } from "./motion";

type PacketObject = Record<string, unknown>;
const object = (value: unknown): PacketObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as PacketObject
    : null;
const rows = (value: unknown): PacketObject[] =>
  Array.isArray(value) ? value.map(object).filter((row): row is PacketObject => row !== null) : [];
const copy = (value: unknown, fallback = "Not recorded") =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const fieldLabel = (value: string) => value.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase());

function savedDate(value: unknown): string {
  if (typeof value !== "string") return "Save time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function readablePreview(value: unknown): string {
  if (value === null || value === undefined) return "Not included";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(readablePreview).join("\n\n") : "None included";
  return Object.entries(value as PacketObject)
    .map(([key, item]) => `${fieldLabel(key)}: ${readablePreview(item)}`)
    .join("\n");
}

/** Presentation only: every displayed fact comes from the exact packet awaiting approval. */
export function CasePacketPreview({ packet }: { packet: CasePreview }) {
  const { colors } = useTheme();
  const [showAppendix, setShowAppendix] = useState(false);
  const [showPacketData, setShowPacketData] = useState(false);
  const preview = packet.preview;
  const order = object(preview.order), shipping = object(preview.shipping);
  const evidence = rows(preview.evidence), statements = rows(preview.statements);
  const carrierEvents = rows(shipping?.events), anchors = rows(preview.anchors);
  const observations = rows(preview.observations);
  const limitations = Array.isArray(preview.limitations) ? preview.limitations : [];
  const finalized = preview.status === "FINALIZED";
  const bodyStyle = [typography.secondary, { color: colors.textSecondary }];
  const titleStyle = [typography.cardTitle, { color: colors.textPrimary }];

  function section(title: string, children: ReactNode) {
    return <View style={styles.section}>
      <Text accessibilityRole="header" style={titleStyle}>{title}</Text>
      {children}
    </View>;
  }

  function badge(label: string, foreground: string, background: string, icon: keyof typeof Ionicons.glyphMap) {
    return <View style={[styles.badge, { backgroundColor: background }]}>
      <Ionicons name={icon} size={16} color={foreground} />
      <Text style={[typography.finePrint, { color: foreground, fontWeight: "600", flexShrink: 1 }]}>{label}</Text>
    </View>;
  }

  function evidenceRow(key: string, title: string, detail: string, icon: keyof typeof Ionicons.glyphMap, foreground: string, background: string) {
    return <View key={key} style={[styles.evidenceRow, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <View style={[styles.icon, { backgroundColor: background }]}>
        <Ionicons name={icon} size={18} color={foreground} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={titleStyle}>{title}</Text>
        <Text style={bodyStyle}>{detail}</Text>
      </View>
    </View>;
  }

  return <View style={styles.packet}>
    <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border, borderTopColor: colors.accent }]}>
      <Text style={[typography.finePrint, styles.eyebrow, { color: colors.accentText }]}>PACKPROOF / CASE PACKET</Text>
      <Text accessibilityRole="header" style={[typography.bodyStrong, styles.title, { color: colors.textPrimary }]}>{preview.title}</Text>
      <Text style={bodyStyle}>{preview.summary}</Text>

      <View style={[styles.status, { borderColor: colors.border, backgroundColor: colors.background }]}>
        <Text style={[typography.finePrint, styles.eyebrow, { color: colors.textSecondary }]}>CASE STATUS</Text>
        <View style={styles.badges}>
          {badge(finalized ? "Proof finalized" : preview.status ? "Proof not finalized" : "Status not included", finalized ? colors.successText : colors.warningText, finalized ? colors.successSoft : colors.warningSoft, finalized ? "checkmark" : "alert-circle-outline")}
          {typeof preview.coreManifestSha256 === "string" && preview.coreManifestSha256
            ? badge("Integrity metadata included", colors.integrityText, colors.integritySoft, "information-circle-outline")
            : null}
          {badge(!shipping ? "Shipping not included" : carrierEvents.length ? "Carrier events included" : "No carrier event", carrierEvents.length ? colors.shipmentText : colors.warningText, carrierEvents.length ? colors.shipmentSoft : colors.warningSoft, carrierEvents.length ? "arrow-up-outline" : "alert-circle-outline")}
        </View>
      </View>

      {section("Order context", order ? <>
        <Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{copy(order.itemTitle, "Item not recorded")}</Text>
        <Text style={bodyStyle}>{order.quantity == null ? "Quantity not recorded" : `Quantity: ${copy(order.quantity)}`}</Text>
        <Text style={bodyStyle}>{copy(order.itemDescription, "Description not recorded")}</Text>
        {order.externalReference ? <Text style={bodyStyle}>Order reference: {copy(order.externalReference)}</Text> : null}
      </> : <Text style={bodyStyle}>Order context is not included in this packet.</Text>)}

      {section("Evidence included", <>
        {evidence.map((media, index) => {
          const isVideo = typeof media.contentType === "string" && media.contentType.startsWith("video/");
          const title = isVideo ? media.stageId ? "Receipt / return recording" : "Packing recording" : "Saved evidence";
          return evidenceRow(copy(media.evidenceId, String(index)), title, `${isVideo ? "Video" : copy(media.contentType, "Media")} · Saved ${savedDate(media.committedAt)}`, isVideo ? "play" : "document-outline", colors.accentText, colors.accentSoft);
        })}
        {statements.map((statement, index) => evidenceRow(copy(statement.attestationId, `statement-${index}`), "Participant attestation", statement.statement === "PACKED_DESCRIBED_ITEM" ? "Item packed as described · Participant statement" : copy(statement.statement), "checkmark", colors.integrityText, colors.integritySoft))}
        {!evidence.length && !statements.length ? <Text style={bodyStyle}>No media or participant statements are included.</Text> : null}
      </>)}

      {anchors.length ? section("Marked moments", anchors.map((anchor, index) => <View key={copy(anchor.anchorId, String(index))} style={styles.rowCopy}>
        <Text style={titleStyle}>{copy(anchor.label)}</Text>
        <Text style={bodyStyle}>{copy(anchor.startMs)}–{copy(anchor.endMs)} ms in the original · {copy(anchor.sourceCategory)}</Text>
      </View>)) : null}

      {shipping ? section("Reported shipping events", <>
        {shipping.carrier ? <Text style={bodyStyle}>Carrier: {copy(shipping.carrier)}</Text> : null}
        {shipping.trackingNumber ? <Text selectable style={bodyStyle}>Tracking: {copy(shipping.trackingNumber)}</Text> : null}
        {carrierEvents.length ? carrierEvents.map((event, index) => <View key={copy(event.eventId, String(index))} style={styles.timelineRow}>
          <View style={[styles.timelineRail, { borderColor: colors.divider }]}>
            <View style={[styles.timelineDot, { backgroundColor: colors.shipmentSoft, borderColor: colors.shipmentText }]} />
          </View>
          <View style={styles.rowCopy}>
            <Text style={[typography.finePrint, { color: colors.textSecondary }]}>{savedDate(event.occurredAt)}</Text>
            <Text style={titleStyle}>{copy(event.title)}</Text>
            <Text style={bodyStyle}>Source: {copy(event.source)}{event.provider ? ` / ${copy(event.provider)}` : ""}</Text>
          </View>
        </View>) : <Text style={bodyStyle}>No carrier event was included in this snapshot.</Text>}
      </>) : null}

      {observations.length ? section("Comparison observations and corrections", observations.map((observation, index) => <View key={copy(observation.comparisonId, String(index))} style={styles.rowCopy}>
        <Text style={titleStyle}>{copy(observation.state).replace(/_/g, " ")}</Text>
        <Text style={bodyStyle}>{copy(observation.note)}</Text>
        <Text style={bodyStyle}>Source: {copy(observation.source)}{observation.supersedesId ? ` · Corrects ${copy(observation.supersedesId)}` : ""}</Text>
      </View>)) : null}

      {preview.notes ? section("Your factual notes", <>
        <Text selectable style={bodyStyle}>{preview.notes.text}</Text>
        <Text style={[typography.finePrint, { color: colors.textSecondary }]}>Source: {preview.notes.source}</Text>
      </>) : null}

      {preview.gaps.length ? section("Gaps and limits", preview.gaps.map((gap, index) => <View key={index} style={styles.limitRow}>
        <Text style={[bodyStyle, { color: colors.warningText }]}>•</Text>
        <Text style={[bodyStyle, styles.rowCopy]}>{gap}</Text>
      </View>)) : null}

      <View style={[styles.finePrint, { borderColor: colors.divider }]}>
        <Text style={[typography.finePrint, styles.eyebrow, { color: colors.textSecondary }]}>IMPORTANT</Text>
        {limitations.map((limitation, index) => <Text key={index} style={[typography.finePrint, { color: colors.textSecondary }]}>{readablePreview(limitation)}</Text>)}
        <Text style={[typography.finePrint, { color: colors.textSecondary }]}>Complete identifiers, hashes, source references and the exact packet data appear in the Technical Integrity Appendix below.</Text>
      </View>
    </View>

    <View style={[styles.appendix, { borderColor: colors.border, borderTopColor: colors.integrity, backgroundColor: colors.surface }]}>
      <PressableScale accessibilityRole="button" accessibilityLabel="Technical Integrity Appendix" accessibilityState={{ expanded: showAppendix }} onPress={() => setShowAppendix(!showAppendix)} style={styles.appendixToggle}>
        <View style={styles.rowCopy}>
          <Text style={[typography.cardTitle, { color: colors.integrityText }]}>Technical Integrity Appendix</Text>
          <Text style={bodyStyle}>Complete fields, source identifiers and hashes</Text>
        </View>
        <Ionicons name={showAppendix ? "chevron-up" : "chevron-down"} size={20} color={colors.integrityText} />
      </PressableScale>
      {showAppendix ? <FadeSlideIn style={styles.appendixContent}>
        <Text style={bodyStyle}>Review the complete packet fields below. These values belong to this exact preview.</Text>
        {Object.entries(preview).filter(([key]) => !["title", "summary", "gaps", "limitations"].includes(key)).map(([key, value]) => <View key={key} style={[styles.exactField, { borderColor: colors.divider }]}>
          <Text style={titleStyle}>{fieldLabel(key)}</Text>
          <Text selectable style={[typography.finePrint, { color: colors.textSecondary }]}>{readablePreview(value)}</Text>
        </View>)}
        <Text style={titleStyle}>Packet SHA-256</Text>
        <Text selectable style={[typography.finePrint, { color: colors.textSecondary }]}>{packet.sha256}</Text>
        <Button label={showPacketData ? "Hide exact packet data" : "Inspect exact packet data"} variant="tertiary" onPress={() => setShowPacketData(!showPacketData)} />
        {showPacketData ? <Text selectable style={[typography.finePrint, { color: colors.textSecondary, fontFamily: "monospace" }]}>{JSON.stringify(preview, null, 2)}</Text> : null}
      </FadeSlideIn> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  packet: { gap: spacing.lg },
  summary: { borderWidth: 1, borderTopWidth: 5, borderRadius: 12, padding: spacing.xl, gap: spacing.md },
  title: { fontSize: 25, lineHeight: 33 },
  eyebrow: { fontWeight: "700", letterSpacing: 0.4 },
  section: { gap: spacing.sm, marginTop: spacing.lg },
  status: { borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: spacing.sm, marginTop: spacing.sm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, maxWidth: "100%" },
  evidenceRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: spacing.md },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  rowCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  timelineRow: { flexDirection: "row", gap: spacing.md, paddingBottom: spacing.sm },
  timelineRail: { width: 2, borderLeftWidth: 2, marginHorizontal: 7 },
  timelineDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, marginLeft: -8, marginTop: 3 },
  limitRow: { flexDirection: "row", gap: spacing.sm },
  finePrint: { borderTopWidth: 1, marginTop: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  appendix: { borderWidth: 1, borderTopWidth: 4, borderRadius: 12 },
  appendixToggle: { flexDirection: "row", alignItems: "center", minHeight: 64, padding: spacing.lg, gap: spacing.sm },
  appendixContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },
  exactField: { borderBottomWidth: 1, paddingBottom: spacing.md, gap: spacing.xs },
});
