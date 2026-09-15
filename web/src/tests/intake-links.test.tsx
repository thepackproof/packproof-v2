import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canonicalWorkspacePath } from "../proof-list-state";
import { IntakeLinkFallback } from "../screens/IntakeLinkFallback";

afterEach(cleanup);
describe("owned intake links", () => {
  it.each([
    ["/app/packing?order=private#token=secret", "/proofs?filter=attention"],
    ["/app/proofs", "/proofs?filter=attention"],
    ["/app/proofs/proof_safe?owner=someone#secret", "/proofs/proof_safe"],
    ["/app/capture/handoff_safe?payload=private#token=secret", "/app/capture/handoff_safe"],
    ["/app/proofs/%2Foutside", "/proofs"],
    ["/app/capture/intent_id.secret", "/proofs"],
    ["/p/public-token?view=timeline", "/p/public-token?view=timeline"],
  ])("normalizes %s without changing the public share contract", (input, expected) => {
    expect(canonicalWorkspacePath(input)).toBe(expected);
  });
  it("does nothing on link preview and recovers through an explicit queue action", async () => {
    const onQueue = vi.fn();
    render(<IntakeLinkFallback onQueue={onQueue} />);
    expect(onQueue).not.toHaveBeenCalled();
    expect(screen.getByText(/If PackProof is not installed/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Continue to packing queue" }));
    expect(onQueue).toHaveBeenCalledTimes(1);
  });
});
