import { describe, expect, it } from "vitest";
import {
  formatCognitoError,
  CognitoAuthError,
} from "../../mobile/src/cognito.ts";
import {
  isAuthenticationFailure,
  isInternalErrorText,
  toUserFacingError,
} from "../../mobile/src/copy/errors.ts";
import { deriveNextAction } from "../../mobile/src/copy/next-action.ts";
import { captureStatusLabel } from "../../mobile/src/copy/status.ts";
import { ACCOUNT_DELETION_COPY, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../../mobile/src/copy/legal.ts";
import {
  parseAppearancePreference,
  resolveColorScheme,
  systemBarBackground,
  systemBarContent,
} from "../../mobile/src/theme/appearance.ts";
import { APPEARANCE_STORAGE_KEY } from "../../mobile/src/theme/appearance.ts";
import { colorsForScheme, darkColors, lightColors, sizes, typography } from "../../mobile/src/theme/tokens.ts";
import { motionDuration, shouldUseLargeMotion } from "../../mobile/src/theme/motion.ts";
import { shouldRestoreCachedSession } from "../../mobile/src/runtime-config.ts";

const luminance = (hex: string) => {
  const channels = hex.slice(1).match(/.{2}/g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe("mobile appearance and theme tokens", () => {
  it("defaults unselected or invalid appearance to light and preserves explicit choices", () => {
    expect(parseAppearancePreference(null)).toBe("light");
    expect(parseAppearancePreference(undefined)).toBe("light");
    expect(parseAppearancePreference("sepia")).toBe("light");
    expect(parseAppearancePreference("dark")).toBe("dark");
    expect(parseAppearancePreference("light")).toBe("light");
    expect(parseAppearancePreference("system")).toBe("system");
    expect(resolveColorScheme(parseAppearancePreference(null), "dark")).toBe("light");
  });

  it("resolves system, light, and dark without mixing them", () => {
    expect(resolveColorScheme("system", "dark")).toBe("dark");
    expect(resolveColorScheme("system", "light")).toBe("light");
    expect(resolveColorScheme("light", "dark")).toBe("light");
    expect(resolveColorScheme("dark", "light")).toBe("dark");
  });

  it("keeps light cards above the canvas and separates actions from success", () => {
    const colors = colorsForScheme("light");
    expect(luminance(colors.surface)).toBeGreaterThan(luminance(colors.background));
    expect(luminance(colors.background)).toBeGreaterThan(0.8);
    expect(colors.primary).not.toBe(colors.success);
    expect(colors.accentText).not.toBe(colors.successText);
    expect(colors).toEqual(lightColors);
  });

  it("keeps dark cards above the navy canvas and separates actions from success", () => {
    const colors = colorsForScheme("dark");
    expect(luminance(colors.surface)).toBeGreaterThan(luminance(colors.background));
    expect(luminance(colors.background)).toBeLessThan(0.05);
    expect(colors.primary).not.toBe(colors.success);
    expect(colors.accentText).not.toBe(colors.successText);
    expect(colors).toEqual(darkColors);
  });

  it("keeps body text and primary button labels readable in both appearances", () => {
    for (const colors of [lightColors, darkColors]) {
      for (const surface of [colors.background, colors.surface, colors.surfaceElevated, colors.surfacePressed]) {
        expect(contrast(colors.textPrimary, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.textSecondary, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.textOnPrimary, colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.textOnPrimary, colors.primaryPressed)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.controlBorder, colors.inputBackground)).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps selected tabs, badges, and source labels readable", () => {
    for (const colors of [lightColors, darkColors]) {
      for (const [foreground, background] of [
        [colors.accentText, colors.accentSoft],
        [colors.successText, colors.successSoft],
        [colors.warningText, colors.warningSoft],
        [colors.error, colors.errorSoft],
        [colors.shipmentText, colors.shipmentSoft],
        [colors.integrityText, colors.integritySoft],
      ]) expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
      for (const source of [colors.proof, colors.commerce, colors.shipment, colors.evidence, colors.integrity]) {
        expect(contrast(source, colors.surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(sizes.touch).toBeGreaterThanOrEqual(48);
    expect(typography.body.fontSize).toBeGreaterThanOrEqual(16);
    expect(typography.secondary.fontSize).toBeGreaterThanOrEqual(14);
  });

  it("stores appearance separately from the authenticated session", () => {
    expect(APPEARANCE_STORAGE_KEY).toBe("packproof-v2.appearance");
    expect(APPEARANCE_STORAGE_KEY).not.toContain("session");
  });

  it("uses matching system-bar colors and inverted icons for each scheme", () => {
    expect(systemBarBackground(lightColors, false)).toBe(lightColors.background);
    expect(systemBarContent("light", false)).toBe("dark");
    expect(systemBarBackground(darkColors, false)).toBe(darkColors.background);
    expect(systemBarContent("dark", false)).toBe("light");
    expect(systemBarBackground(lightColors, true)).toBe(lightColors.scanBackground);
    expect(systemBarContent("light", true)).toBe("light");
  });
});

describe("reduced motion helpers", () => {
  it("keeps functionality but shortens large motion", () => {
    expect(shouldUseLargeMotion(true)).toBe(false);
    expect(shouldUseLargeMotion(false)).toBe(true);
    expect(motionDuration(true, 360)).toBe(120);
    expect(motionDuration(false, 360)).toBe(360);
  });
});

describe("auth session restore and user-facing errors", () => {
  it("restores a cognito session in release builds and rejects a missing token", () => {
    expect(shouldRestoreCachedSession({ authMode: "cognito", token: "access" }, true)).toBe(true);
    expect(shouldRestoreCachedSession({ authMode: "dev", token: "access" }, true)).toBe(false);
    expect(shouldRestoreCachedSession({ authMode: "cognito", token: null }, true)).toBe(false);
    expect(shouldRestoreCachedSession({ authMode: "dev", token: "access" }, false)).toBe(true);
  });

  it("treats expired refresh and 401 responses as authentication failure", () => {
    expect(isAuthenticationFailure({ status: 401 })).toBe(true);
    expect(
      isAuthenticationFailure(new CognitoAuthError("NotAuthorizedException", "Invalid Refresh Token")),
    ).toBe(true);
    expect(isAuthenticationFailure({ status: 500 })).toBe(false);
  });

  it("does not expose Cognito or AWS exception text to ordinary users", () => {
    expect(formatCognitoError(new CognitoAuthError("NotAuthorizedException", "Incorrect username or password."))).toBe(
      "Incorrect email or password.",
    );
    expect(formatCognitoError(new CognitoAuthError("NotAuthorizedException", "Invalid Refresh Token"))).toBe(
      "Your session expired. Sign in again.",
    );
    expect(formatCognitoError(new CognitoAuthError("ResourceNotFoundException", "User pool does not exist"))).toBe(
      "We couldn’t complete that account step. Try again.",
    );
    expect(formatCognitoError(new CognitoAuthError("InvalidPasswordException", "Password did not conform with policy"))).toBe(
      "Password does not meet the account requirements.",
    );
  });

  it("hides internal exception strings in generic API errors", () => {
    expect(isInternalErrorText("UserNotConfirmedException")).toBe(true);
    expect(isInternalErrorText("postgres: relation does not exist")).toBe(true);
    const mapped = toUserFacingError({ code: "HTTP_ERROR", message: "AWSCognitoIdentityProviderService.NotAuthorizedException" });
    expect(mapped.title).toBe("Something went wrong.");
    expect(mapped.message.toLowerCase()).not.toContain("exception");
    expect(mapped.technical).toContain("AWSCognitoIdentityProviderService");
  });
});

describe("capture progress labels and invitation legal URLs", () => {
  it("describes local progress without calling an uploaded recording a completed Proof", () => {
    expect(captureStatusLabel("preparing")).toBe("Preparing");
    expect(captureStatusLabel("uploading")).toBe("Uploading recording");
    expect(captureStatusLabel("uploaded")).toBe("Finishing your Proof");
    expect(captureStatusLabel("committed")).toBe("Finish saving");
    const preparing = deriveNextAction({
      role: "SELLER",
      proofStatus: "READY_FOR_EVIDENCE",
      committedEvidenceCount: 0,
      captureStatus: "preparing",
      hasLocalCapture: true,
      captureBelongsToProof: true,
      uploadPercent: null,
      offline: false,
    });
    expect(preparing.label).toBe("Preparing…");
    expect(preparing.enabled).toBe(false);
  });

  it("keeps public legal URLs and does not invent in-app account deletion", () => {
    expect(TERMS_OF_SERVICE_URL).toContain("/new/terms");
    expect(PRIVACY_POLICY_URL).toContain("/new/privacy");
    expect(ACCOUNT_DELETION_COPY.toLowerCase()).toContain("privacy policy");
    expect(ACCOUNT_DELETION_COPY.toLowerCase()).not.toContain("sign out to delete");
  });
});
