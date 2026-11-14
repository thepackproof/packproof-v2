import { describe, expect, it } from "vitest";
import { currentSubscriptionApprovalPath } from "../main/approval-target";
import { argumentsByMethod } from "../main/security";
import type { ConnectStatus } from "../ui/types";
const state: ConnectStatus = { state: "active", environment: "sandbox", installationId: "install_one", health: { serviceOnline: true, queueCount: 0 }, sourceSubscriptions: [{ id: "source_one", sourceProfile: "packproof.order-lines/v1", displayName: "Orders", state: "approved", localPaused: true, configurationRevision: 3, grantRevision: 4, queue: {}, verifiedCaseId: "case_one", receipt: { id: "batch_one", state: "succeeded", counts: {} } }] };
describe("source privileged boundary", () => {
  it("derives the exact source review and first receipt from live state", () => {
    const target = currentSubscriptionApprovalPath(state, "source_one");
    expect(target).toContain("subscriptionId=source_one");
    expect(target).toContain("configurationRevision=3");
    expect(target).toContain("initialBatchId=batch_one");
    expect(() => currentSubscriptionApprovalPath(state, "other_source")).toThrow();
    expect(() => currentSubscriptionApprovalPath({ ...state, state: "revoked" }, "source_one")).toThrow();
    expect(() => currentSubscriptionApprovalPath(state, "//evil.com")).toThrow();
  });
  it("does not offer recurring approval from an unverified receipt", () => {
    expect(currentSubscriptionApprovalPath({ ...state, sourceSubscriptions: state.sourceSubscriptions!.map(s => ({ ...s, verifiedCaseId: undefined })) }, "source_one")).not.toContain("initialBatchId");
  });
  it("rejects renderer paths, traversal, URLs and omitted original/batch consent", () => {
    expect(argumentsByMethod.chooseSubscriptionFolder.safeParse(["source_one", "C:\\unapproved"]).success).toBe(false);
    expect(argumentsByMethod.chooseNewSubscriptionFolder.safeParse(["C:\\unapproved"]).success).toBe(false);
    for (const fileName of ["../orders.csv", "C:\\orders.csv", "https://evil.com/a.csv", "a.json"]) expect(argumentsByMethod.inspectSubscriptionFile.safeParse([{ id: "source_one", fileName }]).success).toBe(false);
    expect(argumentsByMethod.previewSubscription.safeParse([{ id: "source_one", fileName: "orders.csv", wholeFileUploadApproved: false }]).success).toBe(false);
    expect(argumentsByMethod.commitSubscription.safeParse([{ id: "source_one", wholeBatchApproved: false }]).success).toBe(false);
  });
  it("bounds a proposal without accepting raw paths, unknown profiles or invented business constants", () => {
    const proposal = { displayName: "Orders", sourceProfile: "packproof.order-lines/v1", sourceNamespace: "site-a", mappingVersion: "mapping/v1", mapping: { sourceEventId: "ID", sourceRevision: "Revision", observationKind: "Kind", property: "Property", timeQuality: "Time meaning" }, constants: {}, historyFrom: "2026-11-14T00:00:00-05:00", wholeFileUploadApproved: true };
    expect(argumentsByMethod.proposeSubscription.safeParse([proposal]).success).toBe(true);
    expect(argumentsByMethod.proposeSubscription.safeParse([{ ...proposal, unknownTimePolicy: 'retain_unknown' }]).success).toBe(true);
    for (const extra of [{ folder: "C:\\private" }, { sourceProfile: "unqualified/v1" }, { constants: { amount: "10" } }, { wholeFileUploadApproved: false }, { unknownTimePolicy: 'invent_time' }]) expect(argumentsByMethod.proposeSubscription.safeParse([{ ...proposal, ...extra }]).success).toBe(false);
  });
});
it("accepts only explicitly paired versioned policies with bounded actual identity fields", () => {
  const proposal = { displayName: "Orders", sourceProfile: "packproof.order-lines/v1", sourceNamespace: "site-a", mappingVersion: "mapping/v2", mapping: { orderId: "Order", orderLineId: "Line", sourceAsOf: "AsOf" }, constants: { observationKind: "snapshot", property: "orderedQuantity", timeQuality: "snapshot_time_only" }, historyFrom: "2026-11-14T00:00:00Z", wholeFileUploadApproved: true, batchSchema: "packproof.typed-source-batch/v2", identityPolicy: { schema: "packproof.source-identity-policy/v1", eventKey: { kind: "composite", fields: ["orderId", "orderLineId", "property"] }, revision: { kind: "source_as_of" } } };
  expect(argumentsByMethod.proposeSubscription.safeParse([proposal]).success).toBe(true);
  expect(argumentsByMethod.proposeSubscription.safeParse([{ ...proposal, batchSchema: undefined }]).success).toBe(false);
  expect(argumentsByMethod.proposeSubscription.safeParse([{ ...proposal, identityPolicy: undefined }]).success).toBe(false);
  for (const fields of [["orderId", "fileSha256"], ["orderId", "amount"], ["orderId", "sourceAsOf"], ["orderId", "orderId"], ["orderId"]]) expect(argumentsByMethod.proposeSubscription.safeParse([{ ...proposal, identityPolicy: { ...proposal.identityPolicy, eventKey: { kind: "composite", fields } } }]).success).toBe(false);
});
