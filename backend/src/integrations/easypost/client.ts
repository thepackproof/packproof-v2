import {
  providerAuthFailed,
  providerRateLimited,
  providerResponseInvalid,
  providerTemporarilyUnavailable,
  trackingNotFound,
} from "../../domain/integration-errors.js";
import type { EasyPostTracker } from "./types.js";

const DEFAULT_BASE_URL = "https://api.easypost.com/v2";
const REQUEST_TIMEOUT_MS = 20_000;

export interface EasyPostHttpRequest {
  method: "GET" | "POST";
  path: string;
  apiKey: string;
  body?: unknown;
}

export interface EasyPostHttpResponse {
  status: number;
  json: unknown;
}

export interface EasyPostHttp {
  request(input: EasyPostHttpRequest): Promise<EasyPostHttpResponse>;
}

export interface EasyPostTrackerClient {
  createTracker(input: {
    trackingCode: string;
    carrier?: string | null;
    apiKey: string;
  }): Promise<EasyPostTracker>;
  getTracker(input: { trackerId: string; apiKey: string }): Promise<EasyPostTracker>;
}

export class FetchEasyPostHttp implements EasyPostHttp {
  constructor(private readonly baseUrl = DEFAULT_BASE_URL) {}

  async request(input: EasyPostHttpRequest): Promise<EasyPostHttpResponse> {
    const url = `${this.baseUrl}${input.path}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${input.apiKey}:`).toString("base64")}`,
      Accept: "application/json",
      "User-Agent": "PackProof-V2/easypost-tracker",
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw providerTemporarilyUnavailable();
    }
    let json: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        if (response.status >= 500) {
          throw providerTemporarilyUnavailable();
        }
        throw providerResponseInvalid();
      }
    }
    return { status: response.status, json };
  }
}

export function createEasyPostTrackerClient(http: EasyPostHttp = new FetchEasyPostHttp()): EasyPostTrackerClient {
  return {
    async createTracker(input) {
      const tracker: Record<string, string> = { tracking_code: input.trackingCode };
      const carrier = input.carrier?.trim();
      if (carrier) {
        tracker.carrier = carrier;
      }
      const response = await http.request({
        method: "POST",
        path: "/trackers",
        apiKey: input.apiKey,
        body: { tracker },
      });
      return requireTracker(response);
    },
    async getTracker(input) {
      const response = await http.request({
        method: "GET",
        path: `/trackers/${encodeURIComponent(input.trackerId)}`,
        apiKey: input.apiKey,
      });
      return requireTracker(response);
    },
  };
}

export function requireTracker(response: EasyPostHttpResponse): EasyPostTracker {
  if (response.status === 401 || response.status === 403) {
    throw providerAuthFailed();
  }
  if (response.status === 404) {
    throw trackingNotFound();
  }
  if (response.status === 429) {
    throw providerRateLimited();
  }
  if (response.status >= 500 || response.status === 408) {
    throw providerTemporarilyUnavailable();
  }
  if (response.status >= 400) {
    const code = easypostErrorCode(response.json);
    if (code.includes("NOT_FOUND") || code.includes("NOTFOUND")) {
      throw trackingNotFound();
    }
    throw providerResponseInvalid();
  }
  const tracker = asTracker(response.json);
  if (!tracker) {
    throw providerResponseInvalid();
  }
  return tracker;
}

export function asTracker(value: unknown): EasyPostTracker | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.object != null && record.object !== "Tracker") {
    return null;
  }
  if (typeof record.tracking_code !== "string" && typeof record.id !== "string") {
    return null;
  }
  return record as EasyPostTracker;
}

function easypostErrorCode(json: unknown): string {
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    return "";
  }
  const error = (json as Record<string, unknown>).error;
  if (error == null || typeof error !== "object" || Array.isArray(error)) {
    return "";
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code.toUpperCase() : "";
}
