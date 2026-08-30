import type { AuthMode, CognitoConfig } from "./cognito";

export const STAGING_API_BASE_URL =
  "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws";

export const STAGING_COGNITO: CognitoConfig = {
  userPoolId: "us-east-1_GdgTeYaOO",
  clientId: "34pnucunllka2jcs8hsq762m5e",
  region: "us-east-1",
};

export const DEV_DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

export interface RuntimeEnv {
  EXPO_PUBLIC_PACKPROOF_API_BASE_URL?: string;
  EXPO_PUBLIC_PACKPROOF_AUTH_MODE?: string;
  EXPO_PUBLIC_COGNITO_USER_POOL_ID?: string;
  EXPO_PUBLIC_COGNITO_CLIENT_ID?: string;
  EXPO_PUBLIC_COGNITO_REGION?: string;
}

export interface CachedRuntimeOverrides {
  apiBaseUrl?: string | null;
  authMode?: AuthMode | null;
  cognitoUserPoolId?: string | null;
  cognitoClientId?: string | null;
  cognitoRegion?: string | null;
}

export interface ResolvedRuntimeConfig {
  apiBaseUrl: string;
  authMode: AuthMode;
  cognito: CognitoConfig;
  allowsApiOverride: boolean;
  allowsDevAuth: boolean;
}

export function normalizeApiBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isPrivateOrLocalDevelopmentHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "10.0.2.2" ||
    host === "10.0.3.2"
  ) {
    return true;
  }
  if (host.endsWith(".local") || host.endsWith(".localhost")) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

export function isReleaseSafeApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !isPrivateOrLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

function compiledApiBaseUrl(env: RuntimeEnv, isRelease: boolean): string {
  const fromEnv = env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL?.trim();
  if (isRelease) {
    if (fromEnv && isReleaseSafeApiUrl(fromEnv)) {
      return normalizeApiBaseUrl(fromEnv);
    }
    return STAGING_API_BASE_URL;
  }
  if (fromEnv) {
    return normalizeApiBaseUrl(fromEnv);
  }
  return DEV_DEFAULT_API_BASE_URL;
}

function compiledAuthMode(env: RuntimeEnv, isRelease: boolean): AuthMode {
  if (isRelease) {
    return "cognito";
  }
  return env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE?.trim().toLowerCase() === "cognito"
    ? "cognito"
    : "dev";
}

function compiledCognito(env: RuntimeEnv, isRelease: boolean): CognitoConfig {
  const fromEnv: CognitoConfig = {
    userPoolId: env.EXPO_PUBLIC_COGNITO_USER_POOL_ID?.trim() ?? "",
    clientId: env.EXPO_PUBLIC_COGNITO_CLIENT_ID?.trim() ?? "",
    region: env.EXPO_PUBLIC_COGNITO_REGION?.trim() || "us-east-1",
  };
  if (isRelease && (!fromEnv.userPoolId || !fromEnv.clientId)) {
    return STAGING_COGNITO;
  }
  if (isRelease) {
    return fromEnv;
  }
  return fromEnv;
}

export function resolveRuntimeConfig(input: {
  env: RuntimeEnv;
  isRelease: boolean;
  cached?: CachedRuntimeOverrides | null;
}): ResolvedRuntimeConfig {
  const compiledApi = compiledApiBaseUrl(input.env, input.isRelease);
  const compiledAuth = compiledAuthMode(input.env, input.isRelease);
  const compiledCognitoConfig = compiledCognito(input.env, input.isRelease);

  if (input.isRelease) {
    return {
      apiBaseUrl: compiledApi,
      authMode: "cognito",
      cognito: compiledCognitoConfig,
      allowsApiOverride: false,
      allowsDevAuth: false,
    };
  }

  const cachedApi = input.cached?.apiBaseUrl?.trim();
  const cachedAuth = input.cached?.authMode;
  return {
    apiBaseUrl: cachedApi ? normalizeApiBaseUrl(cachedApi) : compiledApi,
    authMode: cachedAuth === "cognito" || cachedAuth === "dev" ? cachedAuth : compiledAuth,
    cognito: {
      userPoolId: input.cached?.cognitoUserPoolId?.trim() || compiledCognitoConfig.userPoolId,
      clientId: input.cached?.cognitoClientId?.trim() || compiledCognitoConfig.clientId,
      region: input.cached?.cognitoRegion?.trim() || compiledCognitoConfig.region,
    },
    allowsApiOverride: true,
    allowsDevAuth: true,
  };
}

export function shouldRestoreCachedSession(
  cached: { authMode?: string | null; token?: string | null } | null,
  isRelease: boolean,
): boolean {
  if (!cached?.token) {
    return false;
  }
  if (!isRelease) {
    return true;
  }
  return cached.authMode === "cognito";
}
