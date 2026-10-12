const STAGING_API_BASE_URL = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws";

function env(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}

function isReleaseSafeApiUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port && parsed.port !== "443") {
      return false;
    }
    return host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") &&
      !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host) && host.includes(".");
  } catch {
    return false;
  }
}

const easProfile = env("EAS_BUILD_PROFILE");
const researchPolicyPath = require("node:path").join(__dirname, "../config/rnd/research-build.json");
const researchPolicy = require("node:fs").existsSync(researchPolicyPath) ? JSON.parse(require("node:fs").readFileSync(researchPolicyPath, "utf8")) : null;
if (researchPolicy?.researchOnly && easProfile && easProfile !== "research-local") throw new Error("This R&D branch cannot use distribution profiles; use research-local without submission");
const isResearch = env("EXPO_PUBLIC_PACKPROOF_RND") === "true";
const isProductionResearch = env("EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION") === "true";
const isCameraSpike = env("EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE") === "true";
const isProductionRelease = easProfile === "production";
const isPlayRelease = ["internal-staging", "shipping-integration", "production"].includes(easProfile);
const isMobileUxReview = easProfile === "mobile-ux-review";
const isIosSimulatorReview = easProfile === "ios-simulator";
const isAndroidRelease = isPlayRelease || isMobileUxReview;
const isIosRelease = ["ios-simulator", "ios-device", "ios-testflight"].includes(easProfile);
const isRelease = isAndroidRelease || isIosRelease;
// Match the native default theme before JavaScript restores a saved preference.
const mobileTaskUxEnabled = env("EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX", "true") !== "false";
// expo-constants packages this public config as Android assets/app.config.
// Use worker source metadata, never a persistent public environment value.
const sourceBoundProfile = isAndroidRelease || isIosSimulatorReview;
const buildSourceSha = sourceBoundProfile ? env("EAS_BUILD_GIT_COMMIT_HASH") : "";
if (sourceBoundProfile && (env("EAS_BUILD") === "true" || buildSourceSha) && !/^[a-f0-9]{40}$/.test(buildSourceSha)) {
  throw new Error("Source-bound build requires a valid EAS source commit for its packaged config");
}
const apiBaseUrl = env("EXPO_PUBLIC_PACKPROOF_API_BASE_URL");
const authMode = env("EXPO_PUBLIC_PACKPROOF_AUTH_MODE", isRelease ? "cognito" : "dev");
const iosBuildNumber = env("PACKPROOF_IOS_BUILD_NUMBER", "1");
if (!/^[1-9]\d*$/.test(iosBuildNumber)) throw new Error("PACKPROOF_IOS_BUILD_NUMBER must be a positive integer");
const androidVersionCode = Number(env("PACKPROOF_ANDROID_VERSION_CODE", "56"));
if (!Number.isSafeInteger(androidVersionCode) || androidVersionCode < 53 || androidVersionCode > 2100000000)
  throw new Error("PACKPROOF_ANDROID_VERSION_CODE must exceed the verified Play baseline 52");
if (isProductionRelease) {
  // Build 61 is live on Play; this release includes the bounded capture-receipt integration.
  if (androidVersionCode < 62) throw new Error("Production Android versionCode must be at least 62");
  if (env("EAS_BUILD_PLATFORM") && env("EAS_BUILD_PLATFORM") !== "android") {
    throw new Error("The production profile is for Android only");
  }
}

if (isProductionResearch) {
  if (isResearch || isCameraSpike || !isProductionRelease || authMode !== "cognito" ||
      !isReleaseSafeApiUrl(apiBaseUrl) || researchPolicy?.researchOnly !== false ||
      researchPolicy?.distributionAllowed !== true ||
      !researchPolicy?.productionProfiles?.includes("capture-receipts-v1")) {
    throw new Error("Production capture receipts require the authorized Android production profile and HTTPS/Cognito configuration");
  }
}

if (isResearch) {
  if (easProfile && easProfile !== "research-local") throw new Error("R&D requires the isolated research-local profile");
  if (isRelease || isCameraSpike) throw new Error("R&D cannot use release or camera-spike profiles");
  const target = new URL(apiBaseUrl || "http://127.0.0.1:3000");
  if (!["localhost", "127.0.0.1", "10.0.2.2", "[::1]"].includes(target.hostname))
    throw new Error("R&D builds only connect to loopback or the Android host bridge; use a local tunnel for private labs");
}

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
    name: isResearch ? "PackProof Research" : isCameraSpike ? "PackProof Camera Test" : "PackProof",
    slug: "packproof",
    owner: "packproof-llc",
    version: "1.0.1",
    // Keep the existing bridge while upgrading the native runtime for 16 KB pages.
    newArchEnabled: false,
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    androidStatusBar: {
      backgroundColor: mobileTaskUxEnabled ? "#141D2A" : "#E9EEF4",
      barStyle: mobileTaskUxEnabled ? "light-content" : "dark-content",
      translucent: false,
    },
    androidNavigationBar: {
      backgroundColor: mobileTaskUxEnabled ? "#141D2A" : "#E9EEF4",
      barStyle: mobileTaskUxEnabled ? "light-content" : "dark-content",
    },
    icon: "./assets/icon.png",
    scheme: isResearch ? "packproof-research" : isCameraSpike ? "packproof-camera-test" : ["packproof-v2", "packproof"],
    ios: {
      bundleIdentifier: isResearch ? "com.packproof.mobile.research" : isCameraSpike ? "com.packproof.mobile.cameraspike" : "com.packproof.mobile",
      buildNumber: iosBuildNumber,
      supportsTablet: false,
      ...(isResearch ? { entitlements: { "com.apple.developer.devicecheck.appattest-environment": "development" } } : {}),
      associatedDomains: isResearch ? [] : ["applinks:thepackproof.com", "applinks:www.thepackproof.com"],
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
      package: isResearch ? "com.packproof.mobile.research" : isCameraSpike ? "com.packproof.mobile.cameraspike" : "com.packproof.mobile",
      versionCode: androidVersionCode,
      allowBackup: false,
      usesCleartextTraffic: !isAndroidRelease,
      ...(process.env.GOOGLE_SERVICES_JSON ? {googleServicesFile:process.env.GOOGLE_SERVICES_JSON} : {}),
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#E9EEF4",
      },
      permissions: isCameraSpike ? ["CAMERA", "RECORD_AUDIO"] : ["CAMERA"],
      intentFilters: (isCameraSpike || isResearch) ? [] : [{
        action: "VIEW", autoVerify: true, category: ["BROWSABLE", "DEFAULT"],
        data: ["thepackproof.com", "www.thepackproof.com"].flatMap(host =>
          ["/app/packing", "/app/proofs/", "/app/capture/"].map(pathPrefix => ({scheme:"https",host,pathPrefix}))),
      }],
    },
    plugins: [
      ...(!isCameraSpike && !isResearch ? ["./plugins/with-order-share"] : []),
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
      packproofResearch: isResearch,
      packproofResearchProduction: isProductionResearch,
      packproofResearchProfile: isProductionResearch ? "capture-receipts-v1" : null,
      packproofApiBaseUrl: apiBaseUrl || (isRelease ? STAGING_API_BASE_URL : ""),
      packproofFirstProofExperience: env("EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE") === "true",
      ...(buildSourceSha ? { packproofBuildSha: buildSourceSha } : {}),
      ...(isProductionRelease ? { packproofMobileTaskUx: mobileTaskUxEnabled } : {}),
      ...(isMobileUxReview || isIosSimulatorReview ? { packproofInternalReview: true, packproofMobileTaskUx: env("EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX") === "true" } : {}),
    },
  },
};
