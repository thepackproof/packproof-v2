import { Platform } from "react-native";

/**
 * Android presentation rollout only. Rebuild with the flag set to `false` to
 * restore the previous composition; capture journals and domain owners are shared.
 * iOS and web always keep their existing composition.
 */
export const ANDROID_TASK_FIRST_REBUILD = Platform.OS === "android"
  && process.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST !== "false";
