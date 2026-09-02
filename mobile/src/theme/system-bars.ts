import { Platform } from "react-native";
import type { ColorScheme } from "./tokens";
import { systemBarBackground, systemBarContent } from "./appearance";

export async function applySystemBars(input: {
  scheme: ColorScheme;
  immersive: boolean;
  background: string;
  scanBackground: string;
}): Promise<void> {
  const background = systemBarBackground(
    { background: input.background, scanBackground: input.scanBackground },
    input.immersive,
  );
  const content = systemBarContent(input.scheme, input.immersive);
  try {
    const SystemUI = await import("expo-system-ui");
    await SystemUI.setBackgroundColorAsync(background);
  } catch {
    // Optional on web / Expo Go mismatches.
  }
  if (Platform.OS !== "android") {
    return;
  }
  try {
    const NavigationBar = await import("expo-navigation-bar");
    await NavigationBar.setBackgroundColorAsync(background);
    await NavigationBar.setButtonStyleAsync(content);
    if (typeof NavigationBar.setBorderColorAsync === "function") {
      await NavigationBar.setBorderColorAsync(background);
    }
  } catch {
    // Navigation bar APIs are Android-only and may be unavailable in some runtimes.
  }
}
