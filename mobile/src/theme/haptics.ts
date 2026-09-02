import { Platform } from "react-native";

export type HapticKind = "none" | "selection" | "light" | "medium" | "success" | "error";

async function nativeHaptics(): Promise<typeof import("expo-haptics") | null> {
  if (Platform.OS === "web") {
    return null;
  }
  try {
    return await import("expo-haptics");
  } catch {
    return null;
  }
}

export async function haptic(kind: HapticKind): Promise<void> {
  if (kind === "none") {
    return;
  }
  const Haptics = await nativeHaptics();
  if (!Haptics) {
    return;
  }
  try {
    switch (kind) {
      case "selection":
        await Haptics.selectionAsync();
        return;
      case "light":
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      case "medium":
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      case "success":
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      case "error":
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      default:
        return;
    }
  } catch {
    // Haptics are optional on emulators and devices without vibrator support.
  }
}
