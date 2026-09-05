import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { reportedCoordinates, mapUrls, ShipmentTracking } from "../components/ShipmentTracking";
import { ProofTimeline, sortedChronology } from "../components/ProofTimeline";
import { proofActivity } from "../components/DashboardActivity";
import { EvidencePlayer } from "../components/EvidencePlayer";
import { PublicMedia } from "../components/PublicMedia";
import { useEvidenceBlob } from "../components/EvidencePreview";
import { sampleChronology, sampleTracking } from "../site/sampleData";
import { canonicalProof } from "./fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe("reported shipment locations", () => {
  it("accepts explicit bounded coordinate pairs and rejects fabricated defaults", () => {
    expect(reportedCoordinates({ latitude: "39.96", longitude: -82.99 })).toEqual({ latitude: 39.96, longitude: -82.99 });
    expect(reportedCoordinates({ coordinates: { lat: 0, lng: 0 } })).toEqual({ latitude: 0, longitude: 0 });
    for (const invalid of [{ location: "Columbus, OH" }, { latitude: "", longitude: "" }, { latitude: null, longitude: null }, { latitude: true, longitude: false }, { latitude: 91, longitude: 0 }, { latitude: 45, longitude: 181 }, { latitude: Infinity, longitude: 0 }, { coordinates: [1, 2] }]) expect(reportedCoordinates(invalid)).toBeNull();
  });
  it("keeps map requests on the fixed provider and bounding boxes inside valid bounds", () => {
    const url = new URL(mapUrls({ latitude: 85, longitude: 180 }).embed);
    expect(url.origin).toBe("https://www.openstreetmap.org");
    expect(url.searchParams.get("bbox")!.split(",").map(Number)).toEqual([179.94, 84.965, 180, 85]);
    expect(url.searchParams.get("marker")).toBe("85,180");
    expect([...url.searchParams.keys()].sort()).toEqual(["bbox", "layer", "marker"]);
  });
  it("selects the newest scan and updates the map to the selected observation", async () => {
    render(<ShipmentTracking events={[...sampleTracking].reverse()} carrier="Example" />);
    expect(screen.getByTitle(/Map of reported location: Columbus/)).toHaveAttribute("src", expect.stringContaining("39.9612"));
    await userEvent.click(screen.getByRole("button", { name: /In transit Cincinnati/ }));
    expect(screen.getByTitle(/Map of reported location: Cincinnati/)).toHaveAttribute("src", expect.stringContaining("39.1031"));
    expect(screen.getByText("Selected observation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand map" }));
    expect(screen.getByRole("button", { name: "Reduce map" })).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps text-only and polar observations honest without inventing a map pin", () => {
    const { rerender } = render(<ShipmentTracking events={[{ ...sampleTracking[0], eventData: {} }]} />);
    expect(screen.queryByTitle(/Map of reported location/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find reported location on map" })).toHaveAttribute("href", expect.stringContaining("query=Columbus"));
    rerender(<ShipmentTracking events={[{ ...sampleTracking[0], eventData: { latitude: 89, longitude: 0 } }]} />);
    expect(screen.queryByTitle(/Map of reported location/)).not.toBeInTheDocument();
    expect(screen.getByText("Reported observations · not live GPS")).toBeInTheDocument();
  });
});

describe("Proof chronology and dashboard totals", () => {
  it("sorts events without changing the source and retains frozen-core context after filtering", async () => {
    const source = [...sampleChronology].reverse();
    const ordered = sortedChronology(source);
    expect(ordered.map(entry => entry.id)).toEqual(sampleChronology.map(entry => entry.id));
    expect(source[0].id).toBe("sample-scan");
    const select = vi.fn();
    render(<ProofTimeline entries={source} finalizedAt="2026-09-01T09:46:00Z" onSelect={select} />);
    expect(screen.getByText("Integrity event")).toBeInTheDocument();
    expect(screen.getByText("Evidence event")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Shipment 1" }));
    expect(screen.queryByText("Proof finalized")).not.toBeInTheDocument();
    expect(screen.getByText(/recorded separately from the frozen core/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Carrier observation Arrived at facility/ }));
    expect(select).toHaveBeenCalledWith(sampleChronology[3]);
  });
  it("counts created and finalized dates independently using local-day boundaries", () => {
    const now = new Date(2026, 8, 5, 12);
    const today = new Date(2026, 8, 5, 0).toISOString();
    const yesterday = new Date(2026, 8, 4, 23, 59).toISOString();
    const old = new Date(2026, 7, 1).toISOString();
    const future = new Date(2026, 8, 5, 13).toISOString();
    const data = proofActivity([{ createdAt: today, finalizedAt: null }, { createdAt: yesterday, finalizedAt: today }, { createdAt: old, finalizedAt: yesterday }, { createdAt: future, finalizedAt: null }, { createdAt: "invalid", finalizedAt: null }], 7, now);
    expect(data).toHaveLength(7);
    expect(data[6]).toMatchObject({ created: 1, finalized: 1 });
    expect(data[5]).toMatchObject({ created: 1, finalized: 1 });
    expect(data.reduce((sum, day) => sum + day.created, 0)).toBe(2);
  });
});

describe("original evidence previews", () => {
  beforeEach(() => {
    let index = 0;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => `blob:evidence-${++index}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  });
  it("opens a committed PDF through the authenticated loader with a PDF download", async () => {
    const load = vi.fn(async () => new Blob(["%PDF-1.7 original bytes"], { type: "application/pdf" }));
    const evidence = { ...canonicalProof.evidence[0], evidenceId: "doc", contentType: "Application/PDF; charset=binary" };
    const { unmount } = render(<EvidencePlayer proof={{ ...canonicalProof, evidence: [evidence] }} load={load} />);
    await userEvent.click(screen.getByRole("button", { name: "View document" }));
    expect(await screen.findByTitle("Document evidence PDF preview")).toHaveAttribute("src", "blob:evidence-1");
    expect(load).toHaveBeenCalledWith("doc");
    expect(screen.getByRole("link", { name: "Download original evidence" })).toHaveAttribute("download", "packproof-doc.pdf");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:evidence-1");
  });
  it("uses returned PDF MIME when public metadata is absent and never renders it as an image", async () => {
    render(<PublicMedia media={{ evidenceId: "public-doc", slot: "INVOICE", committed: true }} load={async () => new Blob(["%PDF"], { type: "application/pdf" })} />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(await screen.findByTitle("INVOICE evidence PDF preview")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download original evidence" })).toHaveAttribute("download", "packproof-public-doc.pdf");
  });
  it("rejects a stale load after moving to another Proof", async () => {
    const pending = deferred<Blob>();
    const { result, rerender } = renderHook(({ id }) => useEvidenceBlob(id), { initialProps: { id: "first-proof" } });
    let completion!: Promise<void>;
    act(() => { completion = result.current.open("old-doc", "application/pdf", () => pending.promise); });
    rerender({ id: "second-proof" });
    await act(async () => { pending.resolve(new Blob(["old bytes"])); await completion; });
    expect(result.current.url).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });
  it("keeps only the most recently selected file and releases prior URLs", async () => {
    const first = deferred<Blob>();
    const { result, unmount } = renderHook(() => useEvidenceBlob("proof"));
    let oldCompletion!: Promise<void>;
    act(() => { oldCompletion = result.current.open("old", "image/png", () => first.promise); });
    await act(async () => { await result.current.open("new", "application/pdf", async () => new Blob(["new"])); });
    await act(async () => { first.resolve(new Blob(["old"])); await oldCompletion; });
    expect(result.current.selectedId).toBe("new");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.open("third", "video/mp4", async () => new Blob(["third"])); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:evidence-1");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:evidence-2");
  });
  it("reports a verification failure and can retry without retaining the error", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Evidence digest does not match")).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    render(<PublicMedia media={{ evidenceId: "image", slot: "SEAL", committed: true, contentType: "image/png" }} load={load} />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Evidence digest does not match");
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
