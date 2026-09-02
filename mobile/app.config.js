const STAGING_API_BASE_URL =
  "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws";

function env(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}

function isReleaseSafeApiUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") {
      return false;
    }
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

const easProfile = env("EAS_BUILD_PROFILE");
const isPlayRelease = easProfile === "internal-staging";
const apiBaseUrl = env("EXPO_PUBLIC_PACKPROOF_API_BASE_URL");
const authMode = env("EXPO_PUBLIC_PACKPROOF_AUTH_MODE", isPlayRelease ? "cognito" : "dev");

if (isPlayRelease) {
  if (apiBaseUrl && !isReleaseSafeApiUrl(apiBaseUrl)) {
    throw new Error(
      "internal-staging builds must target a public HTTPS API, not localhost or a private development host",
    );
  }
  if (authMode !== "cognito") {
    throw new Error("internal-staging builds must use Cognito authentication");
  }
}

module.exports = {
  expo: {
    name: "PackProof",
    slug: "packproof",
    owner: "packproof-llc",
    version: "0.2.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    androidStatusBar: {
      backgroundColor: "#F4F6F8",
      barStyle: "dark-content",
      translucent: false,
    },
    androidNavigationBar: {
      backgroundColor: "#F4F6F8",
      barStyle: "dark-content",
    },
    icon: "./assets/icon.png",
    scheme: "packproof-v2",
    ios: {
      supportsTablet: false,
      infoPlist: {
        NSCameraUsageDescription: "Scan shipping labels and record packing evidence for this Proof.",
        NSPhotoLibraryUsageDescription: "Select captured evidence if the camera is unavailable.",
      },
    },
    android: {
      package: "com.packproof.mobile",
      versionCode: 25,
      usesCleartextTraffic: !isPlayRelease,
      adaptiveIcon: {
        foregroundImage: "./assets/icon.png",
        backgroundColor: "#F4F6F8",
      },
      permissions: ["CAMERA", "RECORD_AUDIO"],
    },
    plugins: [
      [
        "expo-camera",
        {
          cameraPermission: "Scan shipping labels and record packing evidence for this Proof.",
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      [
        "expo-image-picker",
        {
          cameraPermission: "Record packing evidence for this Proof.",
          microphonePermission: "Record packing evidence audio with the camera.",
          photosPermission: "Access a captured video if the camera app stores it in the library.",
        },
      ],
      "expo-asset",
      "expo-font",
      [
        "expo-build-properties",
        {
          android: {
            compileSdkVersion: 36,
            targetSdkVersion: 36,
            buildToolsVersion: "36.0.0",
          },
        },
      ],
    ],
    extra: {
      eas: {
        projectId: "0196c3f7-cb3a-472c-99be-825558f227e8",
      },
      packproofApiBaseUrl: apiBaseUrl || (isPlayRelease ? STAGING_API_BASE_URL : ""),
    },
  },
};
