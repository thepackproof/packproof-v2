import {
  providerAuthFailed,
  providerRateLimited,
  providerResponseInvalid,
  providerTemporarilyUnavailable,
} from "../../domain/integration-errors.js";

export type FetchLike = typeof fetch;

export function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function mapOAuthHttpError(status: number): never {
  if (status === 401 || status === 403) {
    throw providerAuthFailed();
  }
  if (status === 429) {
    throw providerRateLimited();
  }
  if (status >= 500) {
    throw providerTemporarilyUnavailable();
  }
  throw providerResponseInvalid();
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerResponseInvalid();
  }
}

export async function oauthJson(
  fetchImpl: FetchLike,
  input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<unknown> {
  const response = await fetchImpl(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    body: input.body,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    mapOAuthHttpError(response.status);
  }
  return payload;
}

export function splitScopes(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}
