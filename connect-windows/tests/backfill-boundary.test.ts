import { expect, it } from "vitest";
import { backfillFileNames } from "../main/backfill-files";
import { currentBackfillApprovalPath } from "../main/approval-target";
import { argumentsByMethod } from "../main/security";
import type { BackfillJob, ConnectStatus } from "../ui/types";

it("accepts native chooser files only from the exact approved folder without renderer path input", () => {
  expect(backfillFileNames("C:\\Approved\\Orders", ["c:\\approved\\orders\\001.csv", "C:\\Approved\\Orders\\002.CSV"])).toEqual(["001.csv", "002.CSV"]);
  for (const paths of [["C:\\Approved\\Orders-other\\001.csv"], ["C:\\Approved\\Orders\\nested\\001.csv"], ["D:\\Approved\\Orders\\001.csv"], ["https://evil.com/001.csv"], ["001.csv"], ["\\\\server\\share\\001.csv"], ["C:\\Approved\\Orders\\001.json"], ["C:\\Approved\\Orders\\001.csv", "c:\\approved\\orders\\001.CSV"]]) expect(() => backfillFileNames("C:\\Approved\\Orders", paths)).toThrow();
  expect(() => backfillFileNames("C:\\Approved\\Orders", Array.from({ length: 101 }, (_, i) => `C:\\Approved\\Orders\\${i}.csv`))).toThrow();
});

it("requires a source ID, explicit history semantics and exact inspection consent at the IPC boundary", () => {
  const inspection = { id: "source_one", historyFrom: "2026-10-01T00:00:00Z", historyTo: "2026-10-31T23:59:59Z", semantics: "cumulative_snapshot" };
  expect(argumentsByMethod.chooseBackfillFiles.safeParse([inspection]).success).toBe(true);
  for (const extra of [{ folder: "C:\\private" }, { fileNames: ["unapproved.csv"] }, { semantics: "guess_latest" }, { historyTo: "2026-09-01T00:00:00Z" }, { historyFrom: "2026-10-01" }]) expect(argumentsByMethod.chooseBackfillFiles.safeParse([{ ...inspection, ...extra }]).success).toBe(false);
  const proposal = { id: "source_one", inspectionSha256: "a".repeat(64), wholeFileUploadApproved: true };
  expect(argumentsByMethod.proposeBackfill.safeParse([proposal]).success).toBe(true);
  for (const extra of [{ wholeFileUploadApproved: false }, { inspectionSha256: "changed" }, { originals: [{ name: "fake.csv" }] }, { folder: "C:\\private" }]) expect(argumentsByMethod.proposeBackfill.safeParse([{ ...proposal, ...extra }]).success).toBe(false);
  expect(argumentsByMethod.openBackfillApproval.safeParse([{ id: "source_one", jobId: "job_one", approvalPath: "https://evil.com" }]).success).toBe(false);
});

it("reconstructs the exact manifest browser locator from current source and job state", () => {
  const job: BackfillJob = { schema: "packproof.source-backfill/v1", id: "backfill_one", organizationId: "workspace_one", environment: "sandbox", subscriptionId: "source_one", installationId: "install_one", configurationRevision: 2, grantRevision: 3, manifestSha256: "b".repeat(64), historyFrom: "2026-10-01T00:00:00Z", historyTo: "2026-10-31T23:59:59Z", semantics: "cumulative_snapshot", state: "proposed", approvalExpiresAt: null, originals: [{ id: "original_one", name: "orders.csv", sha256: "c".repeat(64), byteSize: 100, mediaType: "text/csv", batchId: null, receiptState: null, counts: null }], progress: { files: { total: 1, received: 0, pending: 1, processing: 0, succeeded: 0, failed: 0 }, rows: { processing: 0, acceptedLinked: 0, acceptedUnlinked: 0, duplicate: 0, conflict: 0, quarantined: 0, rejected: 0 }, receivedRows: 0 }, capabilities: { approve: false, pause: false, resume: false, collect: false }, blockReason: null, createdAt: "2026-11-14T10:00:00Z", approvalPath: "https://evil.com/ignored" };
  const status: ConnectStatus = { state: "active", installationId: "install_one", environment: "sandbox", health: { serviceOnline: true, queueCount: 0 }, sourceSubscriptions: [{ id: "source_one", sourceProfile: "packproof.order-lines/v1", displayName: "Orders", state: "active", localPaused: false, configurationRevision: 2, grantRevision: 3, queue: {}, backfillJobs: [job] }] };
  const target = currentBackfillApprovalPath(status, "source_one", "backfill_one");
  expect(target).toBe(`/app/records/connect/approve?installationId=install_one&organizationId=workspace_one&environment=sandbox&subscriptionId=source_one&configurationRevision=2&backfillJobId=backfill_one&manifestSha256=${"b".repeat(64)}`);
  expect(target).not.toContain("evil");
  expect(() => currentBackfillApprovalPath(status, "source_one", "unseen_job")).toThrow();
  expect(currentBackfillApprovalPath({ ...status, state: "revoked" }, "source_one", "backfill_one")).toBe(target);
  for (const change of [{ grantRevision: 4 }, { configurationRevision: 3 }, { state: "revoked" }]) expect(currentBackfillApprovalPath({ ...status, sourceSubscriptions: status.sourceSubscriptions!.map(source => ({ ...source, ...change })) }, "source_one", "backfill_one")).toBe(target);
  expect(() => currentBackfillApprovalPath({ ...status, sourceSubscriptions: status.sourceSubscriptions!.map(source => ({ ...source, backfillJobs: [{ ...job, subscriptionId: "other_source" }] })) }, "source_one", "backfill_one")).toThrow();
});
