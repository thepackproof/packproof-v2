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
import { colorsForScheme, darkColors, lightColors } from "../../mobile/src/theme/tokens.ts";
import { motionDuration, shouldUseLargeMotion } from "../../mobile/src/theme/motion.ts";
import { shouldRestoreCachedSession } from "../../mobile/src/runtime-config.ts";

describe("mobile appearance and theme tokens", () => {
  it("defaults an unknown preference to system", () => {
    expect(parseAppearancePreference(null)).toBe("system");
    expect(parseAppearancePreference("sepia")).toBe("system");
    expect(parseAppearancePreference("dark")).toBe("dark");
  });

  it("resolves system, light, and dark without mixing them", () => {
    expect(resolveColorScheme("system", "dark")).toBe("dark");
    expect(resolveColorScheme("system", "light")).toBe("light");
    expect(resolveColorScheme("light", "dark")).toBe("light");
    expect(resolveColorScheme("dark", "light")).toBe("dark");
  });

  it("keeps the existing light PackProof surfaces", () => {
    const colors = colorsForScheme("light");
    expect(colors.background).toBe("#F4F6F8");
    expect(colors.surface).toBe("#FFFFFF");
    expect(colors.textPrimary).toBe("#142735");
    expect(colors.accent).toBe("#13A8E8");
    expect(colors.primary).toBe("#142735");
    expect(colors.success).toBe("#0DCE70");
    expect(colors).toEqual(lightColors);
  });

  it("uses the specified navy PackProof dark palette rather than inverted white", () => {
    const colors = colorsForScheme("dark");
    expect(colors.background).toBe("#0B1220");
    expect(colors.surfaceElevated).toBe("#111B2E");
    expect(colors.surface).toBe("#16243A");
    expect(colors.textPrimary).toBe("#F3F7FC");
    expect(colors.textSecondary).toBe("#9FB0C6");
    expect(colors.border).toBe("#24354D");
    expect(colors.accent).toBe("#27B4F3");
    expect(colors.accentPressed).toBe("#0F8FD1");
    expect(colors.success).toBe("#43D17A");
    expect(colors.warning).toBe("#F5B942");
    expect(colors.error).toBe("#F26D6D");
    expect(colors.background).not.toBe("#000000");
    expect(colors).toEqual(darkColors);
  });

  it("stores appearance separately from the authenticated session", () => {
    expect(APPEARANCE_STORAGE_KEY).toBe("packproof-v2.appearance");
    expect(APPEARANCE_STORAGE_KEY).not.toContain("session");
  });

  it("uses matching system-bar colors and inverted icons for each scheme", () => {
    expect(systemBarBackground(lightColors, false)).toBe("#F4F6F8");
    expect(systemBarContent("light", false)).toBe("dark");
    expect(systemBarBackground(darkColors, false)).toBe("#0B1220");
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
  it("exposes preparing, uploading, securing, and committed labels", () => {
    expect(captureStatusLabel("preparing")).toBe("Preparing");
    expect(captureStatusLabel("uploading")).toBe("Uploading evidence");
    expect(captureStatusLabel("uploaded")).toBe("Securing evidence");
    expect(captureStatusLabel("committed")).toBe("Committed");
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
