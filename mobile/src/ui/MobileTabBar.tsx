import {SIGNAL_ENABLED} from "../experience/signal";
import { Ionicons } from "@expo/vector-icons";
import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { typography, taskFirstTypography } from "../theme/tokens";
import { PressableScale } from "./motion";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";

const tabs = [
  { route: "home", label: "Home", icon: "home-outline" },
  { route: "proofs", label: "Proofs", icon: "document-text-outline" },
  { route: "station", label: "Capture", icon: "videocam-outline" },
  { route: "activity", label: "Updates", icon: "pulse-outline" },
] as const;

export function MobileTabBar() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const {fontScale}=useWindowDimensions();
  return <View accessibilityRole="tablist" accessibilityLabel="Main navigation" style={[styles.bar, SIGNAL_ENABLED && {minHeight:80,paddingTop:8}, fontScale>1.6 && {flexWrap:"wrap"}, { backgroundColor: ANDROID_TASK_FIRST_REBUILD ? colors.surface : colors.background, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, 6), paddingLeft: insets.left + (ANDROID_TASK_FIRST_REBUILD ? 4 : 0), paddingRight: insets.right + (ANDROID_TASK_FIRST_REBUILD ? 4 : 0) }]}>
    {tabs.filter(tab=>!SIGNAL_ENABLED || tab.route!=="station").map(tab => {
      const selected = app.route.name === tab.route;
      return <View key={tab.route} style={[styles.tabSlot,fontScale>1.6 && {flexBasis:"48%",flexGrow:1}]}><PressableScale accessibilityRole="tab" accessibilityLabel={SIGNAL_ENABLED && tab.route==="activity"?"Activity":tab.label} accessibilityState={{ selected, disabled: app.busy }} disabled={app.busy} onPress={() => { if (!selected) app.go(tab.route); }} style={[styles.tab, selected && { backgroundColor: SIGNAL_ENABLED ? "transparent" : colors.accentSoft }]}>
        {SIGNAL_ENABLED ? <Image source={tab.route==="home"?require("../../assets/signal/home.png"):tab.route==="proofs"?require("../../assets/signal/proofs.png"):require("../../assets/signal/activity.png")} style={{width:24,height:24,tintColor:selected?colors.primary:colors.textSecondary}}/> : <Ionicons name={ANDROID_TASK_FIRST_REBUILD && tab.route === "activity" ? "notifications-outline" : tab.icon} size={22} color={selected ? colors.accentText : colors.textSecondary} />}
        <Text style={[styles.label, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.caption, { color: selected ? colors.accentText : colors.textSecondary }]}>{SIGNAL_ENABLED && tab.route==="activity"?"Activity":tab.label}</Text>
        {SIGNAL_ENABLED && <View style={{height:4,width:4,borderRadius:2,backgroundColor:selected?colors.primary:"transparent"}}/>}
      </PressableScale></View>;
    })}
  </View>;
}
const styles = StyleSheet.create({ bar: { flexDirection: "row", borderTopWidth: 1, paddingTop: 5, gap: 2 }, tabSlot: { flex: 1 }, tab: { minHeight: 58, minWidth: 48, alignItems: "center", justifyContent: "center", paddingVertical: 8, paddingHorizontal: 3, gap: 3, borderRadius: 10 }, label: { ...typography.caption, fontSize: 12, lineHeight: 17, textAlign: "center", flexShrink: 1 } });
