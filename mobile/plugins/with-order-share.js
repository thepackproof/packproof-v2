const { withAndroidManifest, withMainActivity, AndroidConfig } = require("expo/config-plugins");

/** Convert Android's explicit text share into a bounded app link for RN Linking. */
function transformMainActivity(source) {
  if (source.includes("packproofOrderShare")) return source;
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
    if (incoming.action == android.content.Intent.ACTION_SEND && (incoming.type == "text/plain" || incoming.type == "text/html")) {
      val text = incoming.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT)?.toString()
      if (text != null && text.isNotBlank() && text.length <= 20000) {
        return android.content.Intent(incoming).apply {
          action = android.content.Intent.ACTION_VIEW
          data = android.net.Uri.Builder().scheme("packproof-v2").authority("intake").appendQueryParameter("text", text).build()
          removeExtra(android.content.Intent.EXTRA_TEXT)
        }
      }
    }
    return incoming
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
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== "kt")
      throw new Error("PackProof share plugin expects Kotlin MainActivity");
    mod.modResults.contents = transformMainActivity(mod.modResults.contents);
    return mod;
  });
};
module.exports.transformMainActivity = transformMainActivity;
