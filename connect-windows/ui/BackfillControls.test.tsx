// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { BackfillControls } from "./BackfillControls";
import { SourceControls } from "./SourceControls";
import { bridgeFor, selected } from "./test-fixtures";
import type { BackfillInspection, BackfillJob, SourceSubscriptionStatus } from "./types";

afterEach(cleanup);
const inspection: BackfillInspection = { configurationRevision: 2, configurationSha256: "e".repeat(64), grantRevision: 3, inspectionSha256: "a".repeat(64), historyFrom: "2026-10-01T00:00:00Z", historyTo: "2026-10-31T23:59:59Z", semantics: "cumulative_snapshot", originals: [{ name: "october-orders.csv", sha256: "b".repeat(64), byteSize: 456, mediaType: "text/csv" }], originalCount: 1, totalBytes: 456, inspectedAt: "2026-11-14T10:00:00Z" };
const source: SourceSubscriptionStatus = { id: "source_one", sourceProfile: "packproof.order-lines/v1", displayName: "Order exports", state: "active", localPaused: false, configurationRevision: 2, grantRevision: 3, backfillAvailable: true, queue: {}, folder: "C:\\approved-reports" };
const job: BackfillJob = { schema: "packproof.source-backfill/v1", id: "backfill_one", organizationId: "workspace-fixture", environment: "sandbox", subscriptionId: source.id, installationId: selected.installationId!, configurationRevision: 2, grantRevision: 3, manifestSha256: "c".repeat(64), historyFrom: inspection.historyFrom, historyTo: inspection.historyTo, semantics: inspection.semantics, state: "approved", approvalExpiresAt: "2026-11-15T10:00:00Z", blockReason: null, createdAt: "2026-11-14T10:00:00Z", approvalPath: "/app/records/connect/approve", originals: [{ ...inspection.originals[0], id: "original_one", batchId: "batch_one", receiptState: "partially_succeeded", counts: { processing: 0, acceptedLinked: 4, acceptedUnlinked: 1, duplicate: 2, conflict: 1, quarantined: 1, rejected: 1 } }, { id: "original_two", name: "october-events.csv", sha256: "d".repeat(64), byteSize: 789, mediaType: "text/csv", batchId: null, receiptState: null, counts: null }], progress: { files: { total: 2, received: 1, pending: 1, processing: 0, succeeded: 0, failed: 1 }, rows: { processing: 0, acceptedLinked: 4, acceptedUnlinked: 1, duplicate: 2, conflict: 1, quarantined: 1, rejected: 1 }, receivedRows: 10 }, capabilities: { approve: false, pause: true, resume: false, collect: true } };
const run = async (_message: string, operation: () => Promise<unknown>) => { await operation(); };
function setup(value: SourceSubscriptionStatus = source, available = true) {
  const bridge = bridgeFor({ ...selected, sourceSubscriptions: [value] });
  const external = vi.fn((operation: () => Promise<unknown>) => { void operation(); });
  const view = render(<BackfillControls source={value} bridge={bridge} available={available} disabled={false} action={run} external={external}/>);
  return { bridge, external, view };
}

it("offers historical inspection only when the negotiated source capability is present", () => {
  const bridge = bridgeFor(selected);
  const status = { ...selected, sourceSubscriptions: [source], capabilities: { ...selected.capabilities!, typedSourceSubscriptions: true } };
  const view = render(<SourceControls status={status} bridge={bridge} disabled={false} action={run} external={() => {}}/>);
  expect(screen.queryByRole("region", { name: "Historical reports" })).toBeNull();
  view.rerender(<SourceControls status={{ ...status, sourceSubscriptions: [{ ...source, backfillAvailable: false }], capabilities: { ...status.capabilities, sourceBackfillJobs: true } }} bridge={bridge} disabled={false} action={run} external={() => {}}/>);
  expect(screen.queryByRole("region", { name: "Historical reports" })).toBeNull();
  view.rerender(<SourceControls status={{ ...status, capabilities: { ...status.capabilities, sourceBackfillJobs: true } }} bridge={bridge} disabled={false} action={run} external={() => {}}/>);
  expect(screen.getByRole("region", { name: "Historical reports" })).toBeVisible();
});

it("requires an explicit bounded interval and update meaning before the native chooser inspects local files", async () => {
  const { bridge } = setup();
  fireEvent.click(screen.getByText("Choose historical reports"));
  const choose = screen.getByRole("button", { name: "Choose files for local inspection" });
  expect(choose).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Historical interval begins (UTC)"), { target: { value: "2026-10-01T00:00" } });
  fireEvent.change(screen.getByLabelText("Historical interval ends (UTC)"), { target: { value: "2026-10-31T23:59:59" } });
  expect(choose).toBeDisabled();
  fireEvent.change(screen.getByLabelText("How these reports update the source"), { target: { value: "event_delta" } });
  fireEvent.click(choose);
  await waitFor(() => expect(bridge.chooseBackfillFiles).toHaveBeenCalledWith({ id: source.id, historyFrom: "2026-10-01T00:00:00Z", historyTo: "2026-10-31T23:59:59Z", semantics: "event_delta" }));
  expect(bridge.proposeBackfill).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: /JSON|path|digest/i })).toBeNull();
});

it("uses the actual approved source update meaning when the collector supplies it", () => {
  setup({ ...source, backfillSemantics: "event_delta" });
  fireEvent.click(screen.getByText("Choose historical reports"));
  expect(screen.getByLabelText("How these reports update the source")).toHaveValue("event_delta");
  expect(screen.queryByRole("option", { name: "Cumulative snapshots at their source revisions" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose files for local inspection" })).toBeDisabled();
});

it("submits only the exact inspected originals after deliberate whole-file consent", async () => {
  const { bridge } = setup({ ...source, backfillDraft: inspection });
  fireEvent.click(screen.getByText("Choose historical reports"));
  expect(screen.getByText("october-orders.csv · 456 bytes")).toBeVisible();
  const request = screen.getByRole("button", { name: "Request historical import approval" });
  expect(request).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: /Request administrator approval to upload/ }));
  await user.tab();
  expect(request).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(bridge.proposeBackfill).toHaveBeenCalledWith({ id: source.id, inspectionSha256: inspection.inspectionSha256, wholeFileUploadApproved: true });
  expect(bridge.chooseBackfillFiles).not.toHaveBeenCalled();
});

it("invalidates consent when the window or persisted inspection changes", async () => {
  const { bridge, view } = setup({ ...source, backfillDraft: inspection });
  fireEvent.click(screen.getByText("Choose historical reports"));
  fireEvent.click(screen.getByRole("checkbox", { name: /Request administrator approval to upload/ }));
  fireEvent.change(screen.getByLabelText("Historical interval ends (UTC)"), { target: { value: "2026-11-01T00:00" } });
  expect(screen.getByRole("button", { name: "Request historical import approval" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Request administrator approval to upload/ })).not.toBeChecked();
  expect(screen.getByText(/differs from this inspection/)).toBeVisible();
  view.rerender(<BackfillControls source={{ ...source, backfillDraft: { ...inspection, inspectionSha256: "d".repeat(64), historyTo: "2026-11-01T00:00:00Z" } }} bridge={bridge} available disabled={false} action={run} external={() => {}}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Request historical import approval" })).toBeDisabled());
  view.rerender(<BackfillControls source={{ ...source, grantRevision: 4, backfillDraft: { ...inspection, historyTo: "2026-11-01T00:00:00Z" } }} bridge={bridge} available disabled={false} action={run} external={() => {}}/>);
  expect(screen.getByRole("checkbox", { name: /Request administrator approval to upload/ })).toBeDisabled();
  expect(bridge.proposeBackfill).not.toHaveBeenCalled();
});

it("shows server-derived partial file and mutually exclusive row outcomes without claiming successful association", () => {
  setup({ ...source, backfillJobs: [job] });
  const history = within(screen.getByRole("article"));
  expect(history.getByText("1 of 2")).toBeVisible();
  expect(history.getByText("Files requiring attention").nextElementSibling).toHaveTextContent("1");
  expect(history.getByText("Rows received").nextElementSibling).toHaveTextContent("10");
  expect(history.getByText("Accepted and linked").nextElementSibling).toHaveTextContent("4");
  expect(history.getByText("Rejected").nextElementSibling).toHaveTextContent("1");
  expect(history.getByText(/File completion and successful business association are separate/)).toBeVisible();
});

it("identifies the bounded local job inventory and offers the complete authorized browser history", () => {
  const { bridge } = setup({ ...source, backfillJobs: [job], backfillJobTotal: 101, backfillJobsTruncated: true });
  expect(screen.getByText(/Showing 1 of 101 historical jobs retained on this computer/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "View all historical jobs in browser" }));
  expect(bridge.openBackfillApproval).toHaveBeenCalledWith({ id: source.id, jobId: job.id });
});

it("distinguishes the bounded receipt display from complete job accounting and browser review", () => {
  const trimmed: BackfillJob = { ...job, state: "completed", originals: [job.originals[0]], originalsShown: 1, originalsTotal: 2, originalsTruncated: true, progress: { files: { total: 2, received: 2, pending: 0, processing: 0, succeeded: 1, failed: 1 }, rows: { ...job.progress.rows, acceptedLinked: 6 }, receivedRows: 12 }, capabilities: { approve: false, pause: false, resume: false, collect: false } };
  const { bridge } = setup({ ...source, backfillJobs: [trimmed], backfillJobsShown: 1, backfillJobKnownTotal: 2, backfillJobsTruncated: true });
  expect(screen.getByText(/Showing 1 of 2 historical jobs retained on this computer/)).toBeVisible();
  expect(screen.getByText("Showing 1 of 2 original file receipts; full manifest in browser.")).toBeVisible();
  const history = within(screen.getByRole("article"));
  expect(history.getByText("Files received").nextElementSibling).toHaveTextContent("2 of 2");
  expect(history.getByText("Rows received").nextElementSibling).toHaveTextContent("12");
  expect(history.getByText("Accepted and linked").nextElementSibling).toHaveTextContent("6");
  fireEvent.click(history.getByText("Historical file receipts and exact approval"));
  expect(history.getAllByRole("listitem")).toHaveLength(1);
  expect(history.queryByText(/october-events.csv/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View all historical jobs in browser" }));
  expect(bridge.openBackfillApproval).toHaveBeenCalledWith({ id: source.id, jobId: job.id });
});

it("keeps known history totals visible when the shared display budget omits every job", () => {
  const current = { ...source, backfillJobs: [], backfillJobsShown: 0, backfillJobKnownTotal: 4, backfillJobsTruncated: true };
  const { bridge, view } = setup(current, false);
  expect(screen.getByText(/Showing 0 of 4 historical jobs retained on this computer/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review source history in browser" }));
  expect(bridge.openSubscriptionApproval).toHaveBeenCalledWith(source.id);
  expect(bridge.openBackfillApproval).not.toHaveBeenCalled();
  view.rerender(<BackfillControls source={{ ...current, state: "revoked" }} bridge={bridge} available={false} disabled={false} action={run} external={() => {}}/>);
  expect(screen.getByText(/Showing 0 of 4 historical jobs retained on this computer/)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("finishes a terminal file list with failed and unresolved outcomes visibly requiring review", () => {
  const secondCounts = { processing: 0, acceptedLinked: 2, acceptedUnlinked: 0, duplicate: 0, conflict: 0, quarantined: 0, rejected: 0 };
  const completed: BackfillJob = { ...job, state: "completed", originals: [job.originals[0], { ...job.originals[1], batchId: "batch_two", receiptState: "succeeded", counts: secondCounts }], progress: { files: { total: 2, received: 2, pending: 0, processing: 0, succeeded: 1, failed: 1 }, rows: { ...job.progress.rows, acceptedLinked: 6 }, receivedRows: 12 }, capabilities: { approve: false, pause: false, resume: false, collect: false } };
  setup({ ...source, backfillJobs: [completed] });
  expect(screen.getByRole("heading", { name: "Historical processing finished" })).toBeVisible();
  expect(screen.getByText(/File receipts requiring attention: 1. Rows needing association or review: 4/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Resume approved historical import" })).toBeNull();
  expect(screen.queryByText(/source complete|successfully imported all|all file receipts reconciled/i)).toBeNull();
});

it("preserves a changed file's local error after a different original completes", () => {
  const accepted = { processing: 0, acceptedLinked: 2, acceptedUnlinked: 0, duplicate: 0, conflict: 0, quarantined: 0, rejected: 0 };
  const mixed: BackfillJob = { ...job, lastErrorCode: null, localItems: [{ itemId: "original_one", errorCode: "SOURCE_BACKFILL_ORIGINAL_CHANGED" }, { itemId: "original_two", queueId: "queue_two" }], originals: [{ ...job.originals[0], batchId: null, receiptState: null, counts: null }, { ...job.originals[1], batchId: "batch_two", receiptState: "succeeded", counts: accepted }], progress: { files: { total: 2, received: 1, pending: 1, processing: 0, succeeded: 1, failed: 0 }, rows: accepted, receivedRows: 2 } };
  setup({ ...source, backfillJobs: [mixed] });
  expect(screen.getByText(/Displayed originals needing local collection review: 1/)).toBeVisible();
  fireEvent.click(screen.getByText("Historical file receipts and exact approval"));
  expect(screen.getByText(/october-orders.csv: Not received.*source backfill original changed/)).toBeVisible();
  expect(screen.getByText("1 of 2")).toBeVisible();
});

it("keeps retained progress visible and blocks actions after a source grant changes or is revoked", () => {
  const { bridge, view } = setup({ ...source, grantRevision: 4, backfillJobs: [job] });
  expect(screen.getByText(/cannot run under a different source revision or grant/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Pause historical import" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review historical import in browser" })).toBeNull();
  expect(screen.getByRole("button", { name: "View retained historical job in browser" })).toBeEnabled();
  view.rerender(<BackfillControls source={{ ...source, state: "revoked", backfillJobs: [job] }} bridge={bridge} available={false} disabled={false} action={run} external={() => {}}/>);
  expect(screen.getByText("1 of 2")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Resume approved historical import" })).toBeNull();
  expect(screen.getByRole("button", { name: "View retained historical job in browser" })).toBeEnabled();
});

it("separates local pause/resume from human-only permissions and fresh browser approval", () => {
  const collectorJob = { ...job, capabilities: { approve: false, pause: false, resume: false, collect: true } };
  const { bridge, view } = setup({ ...source, backfillJobs: [collectorJob] });
  fireEvent.click(screen.getByRole("button", { name: "Pause historical import" }));
  expect(bridge.pauseBackfill).toHaveBeenCalledWith({ id: source.id, jobId: job.id });
  view.rerender(<BackfillControls source={{ ...source, backfillJobs: [{ ...collectorJob, localPaused: true }] }} bridge={bridge} available disabled={false} action={run} external={() => {}}/>);
  fireEvent.click(screen.getByRole("button", { name: "Resume approved historical import" }));
  expect(bridge.resumeBackfill).toHaveBeenCalledWith({ id: source.id, jobId: job.id });
  view.rerender(<BackfillControls source={{ ...source, backfillJobs: [{ ...collectorJob, state: "paused", capabilities: { ...collectorJob.capabilities, collect: false } }] }} bridge={bridge} available disabled={false} action={run} external={operation => { void operation(); }}/>);
  expect(screen.queryByRole("button", { name: "Resume approved historical import" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review historical import in browser" }));
  expect(bridge.openBackfillApproval).toHaveBeenCalledWith({ id: source.id, jobId: job.id });
});
