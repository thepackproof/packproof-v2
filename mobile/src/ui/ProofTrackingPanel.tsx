import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as FileSystem from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ShipmentEventView } from "../v2-api";
import { formatDateTime } from "../copy/format";
import {
  MAP_DEFAULT_ZOOM, MAP_MAX_ZOOM, MAP_MIN_ZOOM, MAP_TILE_SIZE,
  canMapCoordinates, isHistoricalReport, isMapTileCacheFresh, reportedCoordinates, shipmentEventLabel,
  trackingLocationSearchUrl, trackingMapTiles, trackingMapUrl, type MapTile, type ReportedCoordinates,
} from "../copy/tracking";
import { useTheme } from "../theme/ThemeProvider";
import { radii, spacing, typography } from "../theme/tokens";
import { PressableScale } from "./motion";

const tileDownloads = new Map<string, Promise<string>>();

/** Seven-day OSM policy fallback cache. Called only by a tile in the visible viewport. */
function visibleTileFile(uri: string): Promise<string> {
  const existing = tileDownloads.get(uri);
  if (existing) return existing;
  const download = (async () => {
    const tilePath = /^https:\/\/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(uri);
    if (!tilePath || !FileSystem.cacheDirectory) throw new Error("Map tile cache is unavailable");
    const directory = `${FileSystem.cacheDirectory}packproof-map-tiles/`;
    const destination = `${directory}${tilePath[1]}_${tilePath[2]}_${tilePath[3]}.png`;
    const info = await FileSystem.getInfoAsync(destination);
    if (info.exists && !info.isDirectory && info.size > 0 && isMapTileCacheFresh(info.modificationTime)) return destination;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    // Expired tiles are removed only when naturally requested again; there is no background sweep or prefetch.
    await FileSystem.deleteAsync(destination, { idempotent: true });
    const temporary = `${destination}.part`;
    await FileSystem.deleteAsync(temporary, { idempotent: true });
    try {
      const result = await FileSystem.downloadAsync(uri, temporary, {
        headers: { "User-Agent": "PackProof-Mobile/1.0 (+https://thepackproof.com)" },
        sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      });
      if (result.status !== 200) throw new Error("Map tile could not be downloaded");
      await FileSystem.moveAsync({ from: temporary, to: destination });
      return destination;
    } catch (error) {
      await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
      throw error;
    }
  })();
  tileDownloads.set(uri, download);
  void download.then(() => tileDownloads.delete(uri), () => tileDownloads.delete(uri));
  return download;
}

function CachedMapTile({ tile, onError }: { tile: MapTile; onError: () => void }) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    let active = true;
    setLocalUri(null);
    void visibleTileFile(tile.uri).then((uri) => { if (active) setLocalUri(uri); }, () => { if (active) errorHandler.current(); });
    return () => { active = false; };
  }, [tile.uri]);
  if (!localUri) return null;
  return <Image accessible={false} fadeDuration={0} source={{ uri: localUri }} onError={() => errorHandler.current()}
    style={{ position: "absolute", left: tile.left, top: tile.top, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE }} />;
}

function ScanMap({ point, zoom, onZoom, height, onOpenLink }: {
  point: ReportedCoordinates;
  zoom: number;
  onZoom: (zoom: number) => void;
  height: number;
  onOpenLink: (url: string) => void;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const tiles = useMemo(() => trackingMapTiles(point, zoom, width, height), [point.latitude, point.longitude, zoom, width, height]);
  useEffect(() => setFailed(false), [point.latitude, point.longitude, zoom]);
  return <View style={[styles.map, { height, backgroundColor: colors.surfacePressed }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
    {tiles.map((tile) => <CachedMapTile key={tile.key} tile={tile} onError={() => setFailed(true)} />)}
    {!failed && <View pointerEvents="none" style={styles.marker} accessibilityLabel={`Reported scan: ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}>
      <Ionicons name="location" size={48} color={colors.success} style={styles.markerShadow} />
    </View>}
    {failed && <View style={[styles.mapFailure, { backgroundColor: colors.surfaceElevated }]}>
      <Ionicons name="map-outline" size={32} color={colors.textSecondary} />
      <Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>Map unavailable</Text>
      <Text style={[styles.note, { color: colors.textSecondary }]}>The reported coordinates and shipment scans are still available below.</Text>
    </View>}
    <View pointerEvents="none" style={[styles.coordinateChip, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
      <Text style={[styles.caption, { color: colors.textPrimary }]}>Reported scan · {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}</Text>
    </View>
    <View style={[styles.zoomControls, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
      <PressableScale accessibilityRole="button" accessibilityLabel="Zoom in on reported location" accessibilityState={{ disabled: zoom >= MAP_MAX_ZOOM }} disabled={zoom >= MAP_MAX_ZOOM} onPress={() => onZoom(Math.min(MAP_MAX_ZOOM, zoom + 1))} style={styles.mapControl}>
        <Ionicons name="add" size={25} color={zoom >= MAP_MAX_ZOOM ? colors.disabledText : colors.textPrimary} />
      </PressableScale>
      <View style={{ borderBottomWidth: 1, borderColor: colors.border }} />
      <PressableScale accessibilityRole="button" accessibilityLabel="Zoom out from reported location" accessibilityState={{ disabled: zoom <= MAP_MIN_ZOOM }} disabled={zoom <= MAP_MIN_ZOOM} onPress={() => onZoom(Math.max(MAP_MIN_ZOOM, zoom - 1))} style={styles.mapControl}>
        <Ionicons name="remove" size={25} color={zoom <= MAP_MIN_ZOOM ? colors.disabledText : colors.textPrimary} />
      </PressableScale>
    </View>
    <View style={[styles.attribution, { backgroundColor: colors.surfaceElevated }]}>
      <PressableScale accessibilityRole="link" accessibilityLabel="OpenStreetMap copyright and attribution" onPress={() => onOpenLink("https://www.openstreetmap.org/copyright")} style={styles.attributionLink}>
        <Text style={[styles.caption, { color: colors.textSecondary }]}>© OpenStreetMap contributors</Text>
      </PressableScale>
    </View>
  </View>;
}

export function ProofTrackingPanel({ events, carrier, trackingNumber, refreshError, selectedId: controlledSelectedId, onSelect }: {
  events: ShipmentEventView[];
  carrier?: string | null;
  trackingNumber?: string | null;
  refreshError?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { colors, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = controlledSelectedId === undefined ? localSelectedId : controlledSelectedId;
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM);
  const [linkError, setLinkError] = useState<string | null>(null);
  const ordered = useMemo(() => [...events].sort((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0)), [events]);
  const selected = ordered.find((event) => event.id === selectedId) ?? ordered[0];
  const point = selected ? reportedCoordinates(selected.eventData) : null;
  const canMap = canMapCoordinates(point);
  const location = selected?.location || (point ? `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}` : "Location not reported");
  const searchUrl = trackingLocationSearchUrl(selected?.location);
  const testData = events.some((event) => event.eventData.test === true);
  const stale = selected && isHistoricalReport(selected.occurredAt);
  const source = selected ? [...new Set([selected.provider, selected.source].filter(Boolean))].join(" · ") || "Not provided" : "Awaiting update";
  useEffect(() => { setZoom(MAP_DEFAULT_ZOOM); setLinkError(null); }, [selected?.id]);
  useEffect(() => { if (!canMap) setExpanded(false); }, [canMap]);

  function selectEvent(id: string) {
    setLocalSelectedId(id);
    onSelect?.(id);
  }

  async function openLink(url: string) {
    setLinkError(null);
    try { await Linking.openURL(url); }
    catch { setLinkError("The map link could not be opened. Your recorded shipment details remain available here."); }
  }

  if (!selected) return <View style={styles.panel}>
    <Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{trackingNumber ? "Waiting for the first carrier update." : "Add shipping information to track this package."}</Text>
    {carrier || trackingNumber ? <View style={styles.emptyIdentity}>
      {carrier ? <Text style={[styles.note, { color: colors.textSecondary }]}>{carrier}</Text> : null}
      {trackingNumber ? <Text selectable style={[styles.note, { color: colors.textPrimary }]}>{trackingNumber}</Text> : null}
    </View> : null}
    {refreshError ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.error }]}>{refreshError}</Text> : null}
  </View>;

  return <View style={styles.panel}>
    <View style={styles.heading}>
      <View style={[styles.status, { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder }]}><View style={[styles.statusDot, { backgroundColor: colors.accent }]} /><Text style={[styles.note, { color: colors.accentText }]}>{selected ? shipmentEventLabel(selected.eventType) : "Awaiting updates"}</Text></View>
    </View>
    {refreshError && <Text accessibilityRole="alert" style={[styles.notice, { backgroundColor: colors.warningSoft, color: colors.warningText }]}>Tracking refresh failed. Previously recorded observations remain visible. {refreshError}</Text>}
    {testData && <Text style={[styles.notice, { backgroundColor: colors.warningSoft, color: colors.warningText }]}>Test tracking data · simulated shipment events, not real carrier evidence.</Text>}
    {stale && <Text style={[styles.note, { color: colors.textSecondary }]}>This selected report is more than 48 hours old. It is historical context, not a current location.</Text>}
    <View style={[styles.mapCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.mapHeading}>
        <View style={[styles.locationIcon, { backgroundColor: colors.accentSoft }]}><Ionicons name="location-outline" size={26} color={colors.accentText} /></View>
        <View style={styles.locationText}><Text style={[styles.note, { color: colors.textSecondary }]}>{selected?.id === ordered[0]?.id ? "Last reported location" : "Selected observation"}</Text><Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{selected ? location : "Your journey will appear here"}</Text></View>
        {canMap && <PressableScale accessibilityRole="button" accessibilityLabel="Expand shipment map" onPress={() => setExpanded(true)} style={[styles.expandButton, { borderColor: colors.border }]}><Ionicons name="expand-outline" size={22} color={colors.textPrimary} /></PressableScale>}
      </View>
      {canMap && !expanded ? <ScanMap key={selected?.id} point={point!} zoom={zoom} onZoom={setZoom} height={300} onOpenLink={(url) => void openLink(url)} /> : canMap ? <View style={{ height: 300 }} /> : <View style={styles.unmapped}>
        {point ? <Text selectable style={[styles.note, { color: colors.textSecondary }]}>Reported coordinates: {point.latitude}, {point.longitude}</Text> : null}
        {searchUrl ? <PressableScale accessibilityRole="link" onPress={() => void openLink(searchUrl)} style={styles.textButton}><Text style={[styles.link, { color: colors.accentText }]}>Find location on map ↗</Text></PressableScale> : null}
      </View>}
      <View style={[styles.mapFooter, { borderTopColor: colors.border }]}><Text style={[styles.caption, { color: colors.textSecondary }]}>Reported observations · not live GPS</Text>{canMap && <PressableScale accessibilityRole="link" onPress={() => void openLink(trackingMapUrl(point!, zoom))} style={styles.textButton}><Text style={[styles.link, { color: colors.accentText }]}>Open map ↗</Text></PressableScale>}</View>
    </View>
    {linkError && <Text accessibilityRole="alert" style={[styles.note, { color: colors.error }]}>{linkError}</Text>}
    <View style={styles.details}>
      {[{ label: "Carrier", value: carrier || selected?.carrier || "Not provided" }, { label: "Tracking number", value: trackingNumber || "Not provided" }, { label: "Source", value: source }].map((row) => <View key={row.label} style={styles.detailRow}><Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{row.label}</Text><Text selectable style={[styles.detailValue, { color: colors.textPrimary }]}>{row.value}</Text></View>)}
    </View>
    <View style={styles.scans}>
      <View style={styles.scanHeading}><Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textPrimary }]}>Carrier updates</Text><Text style={[styles.caption, { color: colors.textSecondary }]}>{ordered.length}</Text></View>
      {selected?.id !== ordered[0]?.id && ordered[0] && <PressableScale accessibilityRole="button" onPress={() => selectEvent(ordered[0].id)} style={styles.textButton}><Text style={[styles.link, { color: colors.accentText }]}>Show newest report</Text></PressableScale>}
      {ordered.length ? ordered.map((event) => {
        const active = selected?.id === event.id;
        return <PressableScale key={event.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => selectEvent(event.id)} style={[styles.scan, { borderColor: active ? colors.accentSoftBorder : colors.border, backgroundColor: active ? colors.accentSoft : colors.surface }]}>
          <View style={[styles.scanDot, { backgroundColor: active ? colors.accent : colors.textMuted }]} /><View style={styles.scanText}><Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{shipmentEventLabel(event.eventType)}</Text><Text style={[styles.note, { color: colors.textSecondary }]}>{event.location || "Location not provided"}</Text><Text style={[styles.caption, { color: colors.textSecondary }]}>{formatDateTime(event.occurredAt) || "Time not provided"}</Text></View>
        </PressableScale>;
      }) : <Text style={[styles.note, { color: colors.textSecondary }]}>No shipment observations recorded yet.</Text>}
    </View>
    <Modal visible={expanded && canMap} animationType={reducedMotion ? "none" : "slide"} onRequestClose={() => setExpanded(false)} presentationStyle="fullScreen">
      <View style={[styles.modal, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.modalHeading}><Text accessibilityRole="header" style={[styles.sectionTitle, { flex: 1, color: colors.textPrimary }]}>Reported shipment location</Text><PressableScale accessibilityRole="button" accessibilityLabel="Close shipment map" onPress={() => setExpanded(false)} style={styles.mapControl}><Ionicons name="close" size={26} color={colors.textPrimary} /></PressableScale></View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          <Text style={[styles.bodyStrong, { color: colors.textPrimary }]}>{location}</Text>
          {canMap && expanded && <View style={[styles.mapCard, { borderColor: colors.border }]}><ScanMap point={point!} zoom={zoom} onZoom={setZoom} height={Math.max(280, Math.min(600, dimensions.height - insets.top - insets.bottom - 240))} onOpenLink={(url) => void openLink(url)} /></View>}
          <Text style={[styles.note, { color: colors.textSecondary }]}>Reported observations · not live GPS</Text>
          {point && <PressableScale accessibilityRole="link" onPress={() => void openLink(trackingMapUrl(point, zoom))} style={styles.textButton}><Text style={[styles.link, { color: colors.accentText }]}>Open map ↗</Text></PressableScale>}
          {linkError && <Text accessibilityRole="alert" style={[styles.note, { color: colors.error }]}>{linkError}</Text>}
        </ScrollView>
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: spacing.lg }, emptyIdentity: { gap: spacing.xs }, unmapped: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm }, heading: { gap: spacing.sm },
  eyebrow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  eyebrowText: { ...typography.caption, letterSpacing: 1.3, fontWeight: "700" },
  title: { ...typography.sectionTitle, fontSize: 23, lineHeight: 30 },
  status: { flexDirection: "row", alignSelf: "flex-start", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderRadius: radii.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  bodyStrong: { ...typography.bodyStrong }, note: { ...typography.secondary }, caption: { ...typography.caption },
  notice: { ...typography.secondary, padding: spacing.md, borderRadius: radii.md },
  mapCard: { borderWidth: 1, borderRadius: radii.lg, overflow: "hidden" },
  mapHeading: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  locationIcon: { width: 44, height: 44, borderRadius: radii.md, alignItems: "center", justifyContent: "center" },
  locationText: { flex: 1, gap: spacing.xs },
  expandButton: { borderWidth: 1, borderRadius: radii.md, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  map: { overflow: "hidden", position: "relative" },
  marker: { position: "absolute", left: "50%", top: "50%", width: 48, height: 48, marginLeft: -24, marginTop: -45 },
  markerShadow: { textShadowColor: "rgba(0,0,0,0.3)", textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 3 },
  coordinateChip: { position: "absolute", top: spacing.sm, left: spacing.sm, right: 64, padding: spacing.sm, borderWidth: 1, borderRadius: radii.sm },
  zoomControls: { position: "absolute", top: spacing.sm, right: spacing.sm, borderWidth: 1, borderRadius: radii.sm, overflow: "hidden" },
  mapControl: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  attribution: { position: "absolute", bottom: 0, right: 0, borderTopLeftRadius: radii.sm },
  attributionLink: { minHeight: 36, justifyContent: "center", paddingHorizontal: spacing.sm },
  mapFailure: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: spacing.xxl, gap: spacing.sm },
  mapEmpty: { alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.xxxl },
  centered: { textAlign: "center" },
  mapFooter: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1 },
  textButton: { minHeight: 44, justifyContent: "center" }, link: { ...typography.secondaryStrong },
  details: { gap: spacing.lg, marginTop: spacing.sm },
  detailRow: { flexDirection: "row", gap: spacing.md }, detailLabel: { ...typography.secondary, flex: 0.8 }, detailValue: { ...typography.secondaryStrong, flex: 1.2 },
  scans: { gap: spacing.sm }, scanHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  sectionTitle: { ...typography.sectionTitle },
  scan: { flexDirection: "row", gap: spacing.md, padding: spacing.md, borderWidth: 1, borderRadius: radii.md },
  scanDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 }, scanText: { flex: 1, gap: spacing.xs },
  modal: { flex: 1 }, modalHeading: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  modalContent: { gap: spacing.lg, padding: spacing.lg },
});
