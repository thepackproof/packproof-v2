import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import type { AccountSection, AppRouteName } from "../app/navigation";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { IconButton, Button } from "./Button";
import { BottomSheet } from "./Sheets";
import { PressableScale } from "./motion";

type Destination = { label: string; icon: keyof typeof Ionicons.glyphMap; route: AppRouteName; section?: AccountSection };
const destinations: Destination[] = [
  { label: "Home", icon: "home-outline", route: "home" },
  { label: "Proofs", icon: "document-text-outline", route: "proofs" },
  { label: "Packing Station", icon: "videocam-outline", route: "station" },
  { label: "Orders", icon: "cube-outline", route: "orders" },
  { label: "Integrations", icon: "extension-puzzle-outline", route: "account", section: "channels" },
  { label: "Uploads", icon: "cloud-upload-outline", route: "account", section: "recordings" },
  { label: "Notifications", icon: "notifications-outline", route: "account", section: "notifications" },
  { label: "Settings", icon: "settings-outline", route: "account" },
];

/** A phone-sized counterpart to the workstation sidebar. */
export function WorkspaceHeader({ section }: { section: string }) {
  const app = usePackProof();
  const { colors, scheme, setPreference } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  function navigate(destination: Destination) {
    setMenuOpen(false);
    app.go(destination.route, destination.section ? { accountSection: destination.section } : undefined);
  }
  return <>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <View style={styles.top}>
        <IconButton label="Open workspace menu" onPress={() => setMenuOpen(true)}><Ionicons name="menu-outline" size={24} color={colors.textPrimary} /></IconButton>
        <PressableScale accessibilityRole="button" accessibilityLabel="PackProof Home" onPress={() => app.go("home")} style={styles.brand}>
          <View style={styles.mark}><Ionicons name="shield-outline" size={26} color={colors.logoBlue} /><View style={[styles.markDot, { backgroundColor: colors.logoGreen, borderColor: colors.background }]} /></View>
          <Text style={[styles.wordmark, { color: colors.textPrimary }]}>PackProof</Text>
        </PressableScale>
        <IconButton label="Open settings" onPress={() => app.go("account")}><Ionicons name="person-circle-outline" size={28} color={colors.textSecondary} /></IconButton>
      </View>
      <View style={styles.breadcrumb}><Text style={[styles.eyebrow, { color: colors.textSecondary }]}>WORKSPACE</Text><Text style={[styles.section, { color: colors.textSecondary }]}>/  {section}</Text></View>
    </View>
    <BottomSheet visible={menuOpen} title="Your workspace" onClose={() => setMenuOpen(false)}>
      <View style={styles.menu}>
        {destinations.map(destination => {
          const selected = destination.label === section;
          return <PressableScale key={destination.label} accessibilityRole="button" accessibilityLabel={destination.label} accessibilityState={{ selected }} onPress={() => navigate(destination)} style={[styles.menuRow, { backgroundColor: selected ? colors.accentSoft : "transparent" }]}>
            <Ionicons name={destination.icon} size={21} color={selected ? colors.accentText : colors.textSecondary} />
            <Text style={[styles.menuText, { color: selected ? colors.accentText : colors.textPrimary }]}>{destination.label}</Text>
          </PressableScale>;
        })}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Button label={scheme === "dark" ? "Light appearance" : "Dark appearance"} variant="tertiary" icon={scheme === "dark" ? "sunny-outline" : "moon-outline"} onPress={() => { void setPreference(scheme === "dark" ? "light" : "dark").catch(() => app.setError("Appearance changed for this session but could not be saved.")); }} />
          <View style={styles.connection}><View style={[styles.dot, { backgroundColor: app.offline ? colors.warningText : colors.successText }]} /><Text style={[typography.finePrint, { color: colors.textSecondary }]}>{app.offline ? "Offline · saved records available" : "Device online"}</Text></View>
          <Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{app.session?.displayName || app.session?.username || "Your account"}</Text>
          <Button label="Close menu" variant="secondary" onPress={() => setMenuOpen(false)} />
        </View>
      </View>
    </BottomSheet>
  </>;
}

const styles = StyleSheet.create({
  header: { gap: 12, paddingBottom: 14, borderBottomWidth: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 4 },
  brand: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9 },
  mark: { width: 28, height: 28 },
  markDot: { position: "absolute", width: 7, height: 7, borderRadius: 4, borderWidth: 2, right: 1, bottom: 3 },
  wordmark: { ...typography.sectionTitle, fontSize: 21, lineHeight: 28 },
  breadcrumb: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  eyebrow: { ...typography.finePrint, fontFamily: "Inter-SemiBold", fontWeight: "600", fontSize: 10, letterSpacing: 1 },
  section: { ...typography.finePrint },
  menu: { gap: 4, paddingBottom: 8 },
  menuRow: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 14 },
  menuText: { ...typography.secondaryStrong, flex: 1 },
  footer: { gap: 10, borderTopWidth: 1, marginTop: 12, paddingTop: 12 },
  connection: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
