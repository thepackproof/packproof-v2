/** Keep Expo 53 on AGP 8 while enabling the integrated code/resource shrinker. */
const ANDROID_GRADLE_PLUGIN = "8.13.2";

function pinAndroidGradlePlugin(contents) {
  const declaration = /classpath\((['"])com\.android\.tools\.build:gradle(?::[\d.]+)?\1\)/g;
  if ((contents.match(declaration) || []).length !== 1) {
    throw new Error("Review the Android build template: expected one Android Gradle Plugin declaration.");
  }
  return contents.replace(declaration, `classpath('com.android.tools.build:gradle:${ANDROID_GRADLE_PLUGIN}')`);
}
function optimizeReleaseGradle(contents) {
  const defaults = /getDefaultProguardFile\((['"])proguard-android(?:-optimize)?\.txt\1\)/g;
  const matches = contents.match(defaults) || [];
  if (matches.length !== 1) {
    throw new Error("Review the Android release template: expected one default ProGuard configuration.");
  }
  return contents.replace(defaults, 'getDefaultProguardFile("proguard-android-optimize.txt")');
}

function withAndroidReleaseOptimization(config) {
  const { withAppBuildGradle, withProjectBuildGradle, withGradleProperties } = require("@expo/config-plugins");
  config = withProjectBuildGradle(config, mod => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("Review Android build tooling for the changed Gradle language.");
    }
    mod.modResults.contents = pinAndroidGradlePlugin(mod.modResults.contents);
    return mod;
  });
  config = withAppBuildGradle(config, mod => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("Review Android release optimization for the changed Gradle language.");
    }
    mod.modResults.contents = optimizeReleaseGradle(mod.modResults.contents);
    return mod;
  });
  return withGradleProperties(config, mod => {
    mod.modResults = mod.modResults.filter(item => !["android.enableR8.fullMode", "android.r8.optimizedResourceShrinking"].includes(item.key));
    mod.modResults.push({ type: "property", key: "android.enableR8.fullMode", value: "true" });
    mod.modResults.push({ type: "property", key: "android.r8.optimizedResourceShrinking", value: "true" });
    return mod;
  });
}

module.exports = withAndroidReleaseOptimization;
module.exports.optimizeReleaseGradle = optimizeReleaseGradle;
module.exports.pinAndroidGradlePlugin = pinAndroidGradlePlugin;
