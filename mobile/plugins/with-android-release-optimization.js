/** Expo SDK 53 enables R8 separately from its optimized default configuration. */
function optimizeReleaseGradle(contents) {
  const defaults = /getDefaultProguardFile\((['"])proguard-android(?:-optimize)?\.txt\1\)/g;
  const matches = contents.match(defaults) || [];
  if (matches.length !== 1) {
    throw new Error("Review the Android release template: expected one default ProGuard configuration.");
  }
  return contents.replace(defaults, 'getDefaultProguardFile("proguard-android-optimize.txt")');
}

function withAndroidReleaseOptimization(config) {
  const { withAppBuildGradle, withGradleProperties } = require("@expo/config-plugins");
  config = withAppBuildGradle(config, mod => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("Review Android release optimization for the changed Gradle language.");
    }
    mod.modResults.contents = optimizeReleaseGradle(mod.modResults.contents);
    return mod;
  });
  return withGradleProperties(config, mod => {
    mod.modResults = mod.modResults.filter(item => item.key !== "android.enableR8.fullMode");
    mod.modResults.push({ type: "property", key: "android.enableR8.fullMode", value: "true" });
    return mod;
  });
}

module.exports = withAndroidReleaseOptimization;
module.exports.optimizeReleaseGradle = optimizeReleaseGradle;
