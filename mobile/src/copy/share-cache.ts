import type { AccessLinkView } from "../v2-api";

export interface ShareCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

const PURPOSE = "SHARED_PROOF";
const VERSION = 1;

function accountPrefix(apiBaseUrl: string, userId: string): string {
  return `packproof.shared-link:${encodeURIComponent(apiBaseUrl.replace(/\/+$/, ""))}:${encodeURIComponent(userId)}:`;
}

function cacheKey(apiBaseUrl: string, userId: string, proofId: string): string {
  return `${accountPrefix(apiBaseUrl, userId)}${encodeURIComponent(proofId)}:${PURPOSE}`;
}

/** A cached URL is an earlier server grant, never evidence of current server access. */
export function reusableSharedLink(link: AccessLinkView | null | undefined, proofId: string, now = Date.now()): link is AccessLinkView & { token: string; url: string } {
  if (!link || link.proofId !== proofId || link.scope !== "EVIDENCE_VIEW" || link.revokedAt || typeof link.accessLinkId !== "string" || !link.accessLinkId || typeof link.url !== "string" || !link.url || typeof link.token !== "string" || !link.token) return false;
  if (!Number.isFinite(Date.parse(link.createdAt))) return false;
  if (link.expiresAt !== null && (!Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= now)) return false;
  try {
    const url = new URL(link.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.pathname === `/p/${link.token}` && !url.search && !url.hash;
  } catch { return false; }
}

export async function loadSharedLink(storage: ShareCacheStorage, apiBaseUrl: string, userId: string, proofId: string, now = Date.now()): Promise<AccessLinkView | null> {
  const key = cacheKey(apiBaseUrl, userId, proofId);
  const raw = await storage.getItem(key);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw);
    if (cached.version === VERSION && cached.purpose === PURPOSE && reusableSharedLink(cached.link, proofId, now)) return cached.link;
  } catch { /* An incomplete write cannot become a usable grant. */ }
  await storage.removeItem(key);
  return null;
}

export async function saveSharedLink(storage: ShareCacheStorage, apiBaseUrl: string, userId: string, proofId: string, link: AccessLinkView): Promise<void> {
  if (!reusableSharedLink(link, proofId)) throw new Error("This share link is unavailable. Connect and try again.");
  // Deliberately omit any projection or API-response extras from the private cache.
  const { accessLinkId, scope, url, token, createdAt, expiresAt, revokedAt } = link;
  await storage.setItem(cacheKey(apiBaseUrl, userId, proofId), JSON.stringify({ version: VERSION, purpose: PURPOSE, link: { accessLinkId, proofId, scope, url, token, createdAt, expiresAt, revokedAt } }));
}

export async function removeSharedLink(storage: ShareCacheStorage, apiBaseUrl: string, userId: string, proofId: string): Promise<void> {
  await storage.removeItem(cacheKey(apiBaseUrl, userId, proofId));
}

/** Call when leaving an account, including explicit sign-out. */
export async function clearSharedLinkCache(storage: ShareCacheStorage, apiBaseUrl: string, userId: string): Promise<void> {
  const prefix = accountPrefix(apiBaseUrl, userId);
  const keys = await storage.getAllKeys();
  await Promise.all(keys.filter(key => key.startsWith(prefix)).map(key => storage.removeItem(key)));
}

/** Only transport failures permit offline fallback; access failures never do. */
export function isShareTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; status?: number; code?: string; message?: string };
  if (value.name === "RequestTimeoutError" && value.code === "REQUEST_TIMEOUT") return true;
  if (typeof value.status === "number" && value.status > 0) return false;
  return value.name === "AbortError" || value.code === "REQUEST_TIMEOUT" || value.code === "NETWORK_ERROR" ||
    (value.name === "TypeError" && /network|fetch|connection/i.test(value.message ?? ""));
}
