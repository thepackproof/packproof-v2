export interface ClientVersion {
  platform: "ANDROID" | "IOS";
  version: string;
  build?: string;
}

/** Only installed native identifiers count; app config and package.json may describe a different build. */
export function installedClientVersion(input: {
  platform: string;
  development: boolean;
  executionEnvironment: string;
  nativeApplicationVersion: unknown;
  nativeBuildVersion: unknown;
}): ClientVersion | null {
  if (input.development || !["bare", "standalone"].includes(input.executionEnvironment)) return null;
  if (input.platform !== "android" && input.platform !== "ios") return null;
  const version = input.nativeApplicationVersion;
  if (typeof version !== "string" || version.length > 48 ||
    !/^\d{1,4}(?:\.\d{1,4}){1,3}(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,24})?$/.test(version)) return null;
  const build = input.nativeBuildVersion;
  return {
    platform: input.platform === "android" ? "ANDROID" : "IOS",
    version,
    ...(typeof build === "string" && /^\d{1,10}(?:\.\d{1,10}){0,2}$/.test(build) ? { build } : {}),
  };
}

interface AuthenticatedSession {
  userId: string;
  apiBaseUrl: string;
  token: string;
  needsReauthentication?: boolean;
  accessExpiresAt?: number | null;
}

interface VersionClient {
  apiBaseUrl: string;
  assertCaptureAccount(userId: string, apiBaseUrl: string): void;
  reportClientVersion(version: ClientVersion): Promise<void>;
}

/** One best-effort attempt per signed-in app session; token refresh and capture updates do not retry. */
export function createClientVersionReporter(readVersion: () => ClientVersion | null) {
  let attemptedAccount: string | null = null;
  return {
    update(session: AuthenticatedSession | null, client: VersionClient): void {
      if (!session || !session.token || !session.userId || session.needsReauthentication) {
        attemptedAccount = null;
        return;
      }
      if (session.accessExpiresAt && session.accessExpiresAt <= Date.now()) return;
      const apiBaseUrl = session.apiBaseUrl.replace(/\/+$/, "");
      if (client.apiBaseUrl !== apiBaseUrl) return;
      const accountKey = JSON.stringify([apiBaseUrl, session.userId]);
      if (attemptedAccount === accountKey) return;
      try {
        client.assertCaptureAccount(session.userId, apiBaseUrl);
        attemptedAccount = accountKey;
        const version = readVersion();
        if (version) void client.reportClientVersion(version).catch(() => undefined);
      } catch {
        // Version telemetry must never interrupt authentication or evidence work.
      }
    },
  };
}
