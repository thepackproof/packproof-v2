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
const isCameraSpike = env("EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE") === "true";
const isPlayRelease = ["internal-staging", "shipping-integration"].includes(easProfile);
const isIosRelease = ["ios-simulator", "ios-device", "ios-testflight"].includes(easProfile);
const isRelease = isPlayRelease || isIosRelease;
const apiBaseUrl = env("EXPO_PUBLIC_PACKPROOF_API_BASE_URL");
const authMode = env("EXPO_PUBLIC_PACKPROOF_AUTH_MODE", isRelease ? "cognito" : "dev");
const iosBuildNumber = env("PACKPROOF_IOS_BUILD_NUMBER", "1");
if (!/^[1-9]\d*$/.test(iosBuildNumber)) throw new Error("PACKPROOF_IOS_BUILD_NUMBER must be a positive integer");
const androidVersionCode = Number(env("PACKPROOF_ANDROID_VERSION_CODE", "54"));
if (!Number.isSafeInteger(androidVersionCode) || androidVersionCode < 54 || androidVersionCode > 2100000000)
  throw new Error("PACKPROOF_ANDROID_VERSION_CODE must exceed the previously used version code 53");

if (isRelease) {
  if (isCameraSpike) throw new Error("Camera spike builds cannot use a release profile");
  if (apiBaseUrl && !isReleaseSafeApiUrl(apiBaseUrl)) {
    throw new Error(
      "Release builds must target a public HTTPS API, not localhost or a private development host",
    );
  }
  if (authMode !== "cognito") {
    throw new Error("Release builds must use Cognito authentication");
  }
}

module.exports = {
  expo: {
    name: isCameraSpike ? "PackProof Camera Test" : "PackProof",
    slug: "packproof",
    owner: "packproof-llc",
    version: "1.0.1",
    // Keep the existing bridge while upgrading the native runtime for 16 KB pages.
    newArchEnabled: false,
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    // System-bar backgrounds are drawn by the inset-aware app surfaces.
    androidStatusBar: { barStyle: "dark-content" },
    androidNavigationBar: { barStyle: "dark-content" },
    icon: "./assets/icon.png",
    scheme: isCameraSpike ? "packproof-camera-test" : ["packproof-v2", "packproof"],
    ios: {
      bundleIdentifier: isCameraSpike ? "com.packproof.mobile.cameraspike" : "com.packproof.mobile",
      buildNumber: iosBuildNumber,
      supportsTablet: false,
      associatedDomains: ["applinks:thepackproof.com", "applinks:www.thepackproof.com"],
      config: { usesNonExemptEncryption: false },
      infoPlist: {
        NSCameraUsageDescription:
          "Record packing evidence and read shipping labels during your recording.",
        NSFaceIDUsageDescription:
          "Use Face ID to confirm that the item shown in this Proof is the item you are shipping.",
        UIBackgroundModes: ["remote-notification"],
        // Evidence stays in the private app container and is never shared through Files.
        UIFileSharingEnabled: false,
        LSSupportsOpeningDocumentsInPlace: false,
      },
    },
    android: {
      package: isCameraSpike ? "com.packproof.mobile.cameraspike" : "com.packproof.mobile",
      versionCode: androidVersionCode,
      edgeToEdgeEnabled: true,
      allowBackup: false,
      usesCleartextTraffic: !isPlayRelease,
      ...(process.env.GOOGLE_SERVICES_JSON ? {googleServicesFile:process.env.GOOGLE_SERVICES_JSON} : {}),
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#E9EEF4",
      },
      permissions: isCameraSpike ? ["CAMERA", "RECORD_AUDIO"] : ["CAMERA"],
      intentFilters: isCameraSpike ? [] : [{
        action: "VIEW", autoVerify: true, category: ["BROWSABLE", "DEFAULT"],
        data: ["thepackproof.com", "www.thepackproof.com"].flatMap(host =>
          ["/app/packing", "/app/proofs/", "/app/capture/"].map(pathPrefix => ({scheme:"https",host,pathPrefix}))),
      }],
    },
    plugins: [
      ...(!isCameraSpike ? ["./plugins/with-order-share"] : []),
      "./plugins/with-android-back-compat",
      "./plugins/with-android-release-optimization",
      "expo-video",
      "expo-notifications",
      [
        "expo-camera",
        {
          cameraPermission: "Scan shipping labels and record evidence with the camera for this Proof.",
          microphonePermission: isCameraSpike ? "Record audio during the optional camera hardware test." : false,
          recordAudioAndroid: isCameraSpike,
        },
      ],
      [
        "expo-image-picker",
        {
          cameraPermission: "Take evidence photos with the camera for this Proof’s grading workflow.",
          microphonePermission: isCameraSpike ? "Record audio during the optional camera hardware test." : false,
          photosPermission: false,
        },
      ],
      "expo-asset",
      "expo-font",
      [
        "expo-build-properties",
        {
          ios: { deploymentTarget: "15.1" },
          android: {
            compileSdkVersion: 36,
            targetSdkVersion: 36,
            buildToolsVersion: "36.0.0",
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            useLegacyPackaging: false,
            // WorkManager persists this class name and recreates it by reflection.
            // Keep only the worker identity and constructor, including pending work
            // from pre-R8 installations. Library consumer rules cover Expo/JNI.
            extraProguardRules: `-keep,allowoptimization class com.packproof.ordershare.OrderShareWorker {
  public <init>(android.content.Context, androidx.work.WorkerParameters);
}`,
          },
        },
      ],
    ],
    extra: {
      eas: {
        projectId: "0196c3f7-cb3a-472c-99be-825558f227e8",
      },
      packproofApiBaseUrl: apiBaseUrl || (isRelease ? STAGING_API_BASE_URL : ""),
    },
  },
};
