import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterProofInvitations } from "@packproof/copy/presentation";
import { ApiError, type PublicProofView } from "../api/types";
import { withRequestTimeout } from "../api/timeout";
import { createSessionTokenProvider } from "../auth/token-provider";
import type { WebSession } from "../auth/session";
import { EvidenceViewer } from "../components/EvidenceViewer";
import { HomeScreen } from "../screens/HomeScreen";
import { PublicProofScreen } from "../screens/PublicProofScreen";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("session recovery", () => {
  const original: WebSession = { userId: "seller", apiBaseUrl: "", authMode: "cognito", token: "old",
    refreshToken: "refresh", accessExpiresAt: 1, username: "seller", displayName: "Seller", subject: "seller" };

  it("refreshes once for concurrent requests and uses the new token", async () => {
    let session: WebSession | null = { ...original };
    const refresh = vi.fn(async () => ({ accessToken: "new", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }));
    const getToken = createSessionTokenProvider({ getSession: () => session, onSession: (next) => { session = next; }, refresh });
    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual(["new", "new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await getToken()).toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("cannot resurrect an account after sign-out during refresh", async () => {
    let session: WebSession | null = { ...original };
    let finish!: (value: { accessToken: string; refreshToken: string; expiresAt: number }) => void;
    const refresh = () => new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>((resolve) => { finish = resolve; });
    const onSession = vi.fn();
    const getToken = createSessionTokenProvider({ getSession: () => session, onSession, refresh });
    const pending = getToken();
    session = null;
    finish({ accessToken: "new", refreshToken: "refresh", expiresAt: Date.now() + 100_000 });
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(onSession).not.toHaveBeenCalled();
  });

  it("aborts stalled work without retrying a command", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const operation = vi.fn((value: AbortSignal) => { signal = value; return new Promise<never>(() => {}); });
    const pending = withRequestTimeout(operation, 500);
    const check = expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(501);
    await check;
    expect(signal.aborted).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("Proof experience", () => {
  it("shows invitations with the shared default All filter", () => {
    const invitation = { transaction: { itemTitle: "Card" }, inviter: { username: "seller", displayName: "Seller" } };
    expect(filterProofInvitations([invitation], { view: "in_progress", role: "all" })).toEqual([invitation]);
    expect(filterProofInvitations([invitation], { view: "completed", role: "all" })).toEqual([]);
    expect(filterProofInvitations([invitation], { view: "in_progress", role: "all", query: "missing" })).toEqual([]);
  });

  it("distinguishes an empty search and lets users reset it", () => {
    render(<HomeScreen proofs={[]} invitations={[]} loading={false} error={null} onOpenProof={() => {}} onCreate={() => {}} onOpenInvitation={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search proofs" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching Proofs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset search and filters" }));
    expect(screen.getByRole("textbox", { name: "Search proofs" })).toHaveValue("");
    expect(screen.getByText("No Proofs in progress")).toBeInTheDocument();
  });

  it("loads evidence on demand and releases private media on close", async () => {
    const createUrl = vi.fn(() => "blob:proof-evidence");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
    const load = vi.fn(async () => new Blob(["recording"], { type: "video/mp4" }));
    render(<EvidenceViewer evidenceId="evd_test" contentType="video/mp4" load={load} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Watch recording" }));
    await screen.findByRole("link", { name: "Download original" });
    expect(screen.getByLabelText("Packing evidence recording")).toHaveAttribute("src", "blob:proof-evidence");
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
    expect(revokeUrl).toHaveBeenCalledWith("blob:proof-evidence");
    expect(screen.queryByLabelText("Packing evidence recording")).not.toBeInTheDocument();
  });

  it("clears a previously visible public Proof when its link is revoked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const proof: PublicProofView = { proofId: "proof", status: "READY_FOR_EVIDENCE", workflowType: "COMMERCE_SALE",
      workflowStage: "PACKING", nextAction: { type: "CAPTURE", title: "Private proof status", hint: "" }, scope: "SUMMARY",
      join: { eligible: false, requiresAuthentication: true, message: "" } };
    const load = vi.fn().mockResolvedValueOnce(proof).mockRejectedValue(new ApiError("ACCESS_LINK_REVOKED", "Revoked", 404));
    render(<PublicProofScreen token="token" load={load} onSignIn={() => {}} />);
    await screen.findByText("Private proof status");
    fireEvent(window, new Event("online"));
    await screen.findByText("This viewing link has expired, was revoked, or is no longer available.");
    expect(screen.queryByText("Private proof status")).not.toBeInTheDocument();
  });

  it("retains the last known Proof with a clear warning during a transient outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const proof: PublicProofView = { proofId: "proof", status: "FINALIZED", workflowType: "COMMERCE_SALE",
      workflowStage: "COMPLETE", nextAction: null, scope: "SUMMARY",
      join: { eligible: false, requiresAuthentication: true, message: "" } };
    const load = vi.fn().mockResolvedValueOnce(proof).mockRejectedValue(new TypeError("Network failed"));
    render(<PublicProofScreen token="token" load={load} onSignIn={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading Proof status…")).not.toBeInTheDocument());
    await act(async () => { fireEvent(window, new Event("online")); });
    expect(await screen.findByText(/Live updates are paused/)).toBeInTheDocument();
    expect(screen.getByText("View-only record")).toBeInTheDocument();
  });
});
