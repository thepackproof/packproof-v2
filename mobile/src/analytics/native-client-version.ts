import Constants from "expo-constants";
import { Platform } from "react-native";
import { installedClientVersion, type ClientVersion } from "./client-version";

export function readInstalledClientVersion(): ClientVersion | null {
  try {
    // Lazy loading keeps older binaries without this native module fully usable.
    const application = require("expo-application") as typeof import("expo-application");
    return installedClientVersion({
      platform: Platform.OS,
      development: __DEV__,
      executionEnvironment: Constants.executionEnvironment,
      nativeApplicationVersion: application.nativeApplicationVersion,
      nativeBuildVersion: application.nativeBuildVersion,
    });
  } catch {
    return null;
  }
}
