/**
 * Expo 52 / React Native 0.76 dispatch system Back through the legacy bridge.
 * API 36 otherwise bypasses onBackPressed/KEYCODE_BACK on Android 16.
 * Keep this explicit until the native runtime is upgraded and predictive Back
 * is verified on both three-button and gesture navigation.
 * https://developer.android.com/about/versions/16/behavior-changes-16#predictive-back
 */
function applyAndroidBackCompatibility(manifest) {
  const applications = manifest.manifest?.application;
  if (!Array.isArray(applications) || applications.length === 0) {
    throw new Error("Android Back compatibility requires an application manifest.");
  }
  for (const application of applications) {
    application.$ = application.$ || {};
    application.$["android:enableOnBackInvokedCallback"] = "false";
    // An activity-level attribute takes precedence over the application value.
    for (const activity of application.activity || []) {
      if (activity.$?.["android:name"] === ".MainActivity" ||
          activity.$?.["android:name"]?.endsWith(".MainActivity")) {
        activity.$["android:enableOnBackInvokedCallback"] = "false";
      }
    }
  }
  return manifest;
}

function withAndroidBackCompatibility(config) {
  const { withAndroidManifest } = require("@expo/config-plugins");
  return withAndroidManifest(config, (mod) => {
    mod.modResults = applyAndroidBackCompatibility(mod.modResults);
    return mod;
  });
}

module.exports = withAndroidBackCompatibility;
module.exports.applyAndroidBackCompatibility = applyAndroidBackCompatibility;
