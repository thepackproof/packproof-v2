const { withAndroidManifest, withMainActivity, AndroidConfig } = require("expo/config-plugins");

/** Persist Android's explicit text share before routing an opaque local locator. */
function transformMainActivity(source) {
  if (source.includes("packproofOrderShare")) {
    if (source.includes("OrderShareStore.receive(this, incoming)") && !source.includes('appendQueryParameter("text"')) return source;
    // Upgrade the previously generated raw-query handler once, preserving its single
    // onCreate/onNewIntent integration instead of adding a competing receiver.
    const legacy = /  private fun packproofOrderShare\(incoming: android\.content\.Intent\): android\.content\.Intent \{[\s\S]*?\n  \}\n\n  override fun onNewIntent/;
    if (source.includes('appendQueryParameter("text"') && legacy.test(source)) {
      return source.replace(legacy, '  private fun packproofOrderShare(incoming: android.content.Intent): android.content.Intent {\n    return com.packproof.ordershare.OrderShareStore.receive(this, incoming)\n  }\n\n  override fun onNewIntent');
    }
    throw new Error("PackProof share plugin: unsupported existing share handler; inspect MainActivity before prebuild");
  }
  if (!source.includes("super.onCreate(null)"))
    throw new Error(
      "PackProof share plugin: unsupported MainActivity; inspect the generated Kotlin activity",
    );
  source = source.replace(
    "super.onCreate(null)",
    "setIntent(packproofOrderShare(intent))\n    super.onCreate(null)",
  );
  const addition = `
  private fun packproofOrderShare(incoming: android.content.Intent): android.content.Intent {
    return com.packproof.ordershare.OrderShareStore.receive(this, incoming)
  }

  override fun onNewIntent(intent: android.content.Intent) {
    val normalized = packproofOrderShare(intent)
    setIntent(normalized)
    super.onNewIntent(normalized)
  }
`;
  if (/override fun onNewIntent/.test(source))
    throw new Error("PackProof share plugin: merge existing onNewIntent handling explicitly");
  const end = source.lastIndexOf("}");
  if (end < 0) throw new Error("PackProof share plugin: invalid Kotlin activity");
  return source.slice(0, end) + addition + source.slice(end);
}
module.exports = function withOrderShare(config) {
  config = withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    activity.$["android:launchMode"] = "singleTask";
    activity["intent-filter"] ??= [];
    if (
      !activity["intent-filter"].some((f) =>
        f.action?.some((a) => a.$["android:name"] === "android.intent.action.SEND"),
      )
    ) {
      activity["intent-filter"].push({
        action: [{ $: { "android:name": "android.intent.action.SEND" } }],
        category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
        data: [
          { $: { "android:mimeType": "text/plain" } },
          { $: { "android:mimeType": "text/html" } },
        ],
      });
    }
    return mod;
  });
  config = withMainActivity(config, (mod) => {
    if (mod.modResults.language !== "kt")
      throw new Error("PackProof share plugin expects Kotlin MainActivity");
    mod.modResults.contents = transformMainActivity(mod.modResults.contents);
    return mod;
  });
  return require('./with-ios-order-share')(config);
};
module.exports.transformMainActivity = transformMainActivity;
