import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBackRoute } from "../../mobile/src/app/navigation.js";

const require = createRequire(import.meta.url);
const { applyAndroidBackCompatibility } = require("../../mobile/plugins/with-android-back-compat.js");

describe("Android 16 system Back compatibility", () => {
  it("opts the application and MainActivity out of bypassing the RN 0.76 bridge", () => {
    const manifest = { manifest: { application: [{ $: { "android:label": "PackProof" }, activity: [
      { $: { "android:name": ".MainActivity", "android:enableOnBackInvokedCallback": "true" } },
      { $: { "android:name": "example.OtherActivity", "android:exported": "false" } },
    ] }] } };
    const result = applyAndroidBackCompatibility(manifest);
    expect(result.manifest.application[0].$["android:enableOnBackInvokedCallback"]).toBe("false");
    expect(result.manifest.application[0].activity[0].$["android:enableOnBackInvokedCallback"]).toBe("false");
    expect(result.manifest.application[0].activity[1].$["android:exported"]).toBe("false");
    expect(applyAndroidBackCompatibility(result)).toEqual(result);
  });

  it("covers a fully qualified MainActivity and fails closed on missing application", () => {
    const m = { manifest: { application: [{ activity: [{ $: { "android:name": "com.packproof.mobile.MainActivity" } }] }] } };
    expect(applyAndroidBackCompatibility(m).manifest.application[0].activity[0].$["android:enableOnBackInvokedCallback"]).toBe("false");
    expect(() => applyAndroidBackCompatibility({ manifest: {} })).toThrow("application manifest");
  });

  it("is wired into the release configuration without lowering the target SDK", () => {
    const source = readFileSync(new URL("../../mobile/app.config.js", import.meta.url), "utf8");
    expect(source).toContain('"./plugins/with-android-back-compat"');
    expect(source).toContain("targetSdkVersion: 36");
  });

  it.each([
    ["proof", "home"], ["account", "home"], ["create", "home"],
    ["event", "proof"], ["capture", "proof"], ["editShipping", "proof"],
    ["editPurchase", "proof"], ["finalize", "proof"], ["sharing", "proof"],
    ["manual", "home"], ["scan", "create"], ["review", "create"],
  ] as const)("routes %s Back to %s, rather than exiting", (route, parent) => {
    expect(resolveBackRoute(route)).toBe(parent);
  });

  it.each(["orders", "station"] as const)("returns minimal manual creation from retired %s origins to Proofs", (origin) => {
    expect(resolveBackRoute("manual", origin)).toBe("home");
  });
});
