import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PackProofApi } from "../api/client";
import { useDeveloperAccess } from "../auth/useDeveloperAccess";

it("hides developer controls until confirmed and never carries permission across accounts", async () => {
  const first = { getDeveloperAccess: vi.fn().mockResolvedValue({ allowed: true }) } as unknown as PackProofApi;
  let resolve!: (value: { allowed: boolean }) => void;
  const second = { getDeveloperAccess: vi.fn(() => new Promise(r => { resolve = r; })) } as unknown as PackProofApi;
  const { result, rerender } = renderHook(({ api, user }) => useDeveloperAccess(api, user, true), { initialProps: { api: first, user: "owner" } });
  expect(result.current).toBeFalsy();
  await waitFor(() => expect(result.current).toBe(true));
  rerender({ api: second, user: "someone-else" });
  expect(result.current).toBeFalsy();
  await act(async () => resolve({ allowed: false }));
  expect(result.current).toBeFalsy();
});

it("ignores a delayed grant for an account that signed out and fails closed on errors", async () => {
  let resolve!: (value: { allowed: boolean }) => void;
  const api = { getDeveloperAccess: vi.fn(() => new Promise(r => { resolve = r; })) } as unknown as PackProofApi;
  const { result, rerender } = renderHook(({ user }) => useDeveloperAccess(api, user, true), { initialProps: { user: "owner" } });
  rerender({ user: "" });
  await act(async () => resolve({ allowed: true }));
  expect(result.current).toBeFalsy();
  vi.mocked(api.getDeveloperAccess).mockRejectedValue(new Error("Offline"));
  rerender({ user: "owner" });
  await act(async () => {});
  expect(result.current).toBeFalsy();
});

it("uses refreshed verified identity claims for capability and developer requests", async () => {
  let identity = "expired";
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ allowed: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const api = new PackProofApi({ baseUrl: "https://api.example.com", getToken: async () => { identity = "fresh-id-token"; return "access-token"; }, getIdentityToken: () => identity });
    await api.getDeveloperAccess();
    expect(fetcher.mock.calls[0][0]).toBe("https://api.example.com/me/developer-access");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-id-token");
    fetcher.mockResolvedValue(new Response("{}", { status: 200 }));
    await api.developerRequest("/workspace/keys");
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-id-token");
  } finally { vi.unstubAllGlobals(); }
});
