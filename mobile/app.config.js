const STAGING_API_BASE_URL = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws";

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
    version: "0.3.0",
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
        NSCameraUsageDescription:
          "Scan shipping labels and record evidence with the camera for this Proof.",
      },
    },
    android: {
      package: "com.packproof.mobile",
      versionCode: 29,
      usesCleartextTraffic: !isPlayRelease,
      adaptiveIcon: {
        foregroundImage: "./assets/icon.png",
        backgroundColor: "#F4F6F8",
      },
      permissions: ["CAMERA"],
    },
    plugins: [
      "./plugins/with-order-share",
      "expo-video",
      [
        "expo-camera",
        {
          cameraPermission: "Scan shipping labels and record evidence with the camera for this Proof.",
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      [
        "expo-image-picker",
        {
          cameraPermission: "Take evidence photos with the camera for this Proof’s grading workflow.",
          microphonePermission: false,
          photosPermission: false,
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
