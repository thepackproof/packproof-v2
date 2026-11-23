import type { ConnectBridge, ConnectStatus } from "../types";
import type { OrderSummary, WorkspaceSource, WorkspaceStep } from "../workspace-types";
import { roles, shortFolder } from "./SetupParts";
import { eventTitle } from "./ProofModel";

export type WorkspaceSection = "home" | "orders" | "attention" | "connections" | "matching" | "integrity" | "exports" | "settings";
export interface WorkspaceProps {
  section: WorkspaceSection;
  status: ConnectStatus;
  bridge: ConnectBridge;
  onSection: (section: WorkspaceSection) => void;
  onStatus: (status: ConnectStatus) => void;
  onProof: (proofId: string, revision: number) => void;
  onEditStep?: (step: WorkspaceStep) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onLegacy?: () => void;
}
export type RunAction = (action: () => Promise<unknown>, success?: string) => Promise<void>;

/** Cached workspace pages are not authorization. Only current positive facility
 * permission, a live collector and compatible hosted transport permit inspection. */
export function canReadWorkspace(status: ConnectStatus): boolean {
  return status.health.serviceOnline &&
    status.workspace?.canReadOrders === true &&
    status.transport?.state === "compatible";
}
export function sourceTitle(source: WorkspaceSource) {
  return source.displayName && source.displayName !== source.folder
    ? source.displayName
    : shortFolder(source.folder) || "Order software";
}
export function sourceIcon(source: WorkspaceSource) {
  return roles[source.roles[0]]?.icon || "folder";
}
export function sourceIssue(source: WorkspaceSource) {
  if (source.state === "paused") return "";
  if (source.issue === "IDENTITY_UNRESOLVED") return "A record needs an order reference.";
  if (source.issue === "COVERAGE_GAP" || source.coverageGap)
    return "Some records may have been missed. Review the source coverage.";
  if (source.issue === "RELATED_SOURCE_CHANGED")
    return "A related source changed. Check the order references.";
  if (source.issue === "NETWORK_UNAVAILABLE") return "The source could not reach PackProof.";
  if (/ACCESS_DENIED|UNREADABLE|READ_FAILED|FOLDER_UNAVAILABLE/.test(source.issue || ""))
    return "PackProof could not read this folder.";
  if (source.issue === "MEDIA_READER_UNAVAILABLE") return "A reader is needed for the attached evidence.";
  if (source.issue === "MEDIA_STORAGE_PENDING") return "The original is waiting for storage.";
  if (source.issue === "WORKSPACE_SCOPE_CHANGED") return "Review the updated source access.";
  if (["unavailable", "ambiguous", "unsupported", "incomplete"].includes(source.recognition.state))
    return source.recognition.message || "Check this source.";
  return source.state === "needs_attention" || source.issue
    ? "Review the latest records from this source."
    : "";
}
export function sourceState(source: WorkspaceSource) {
  if (source.state === "paused") return "Paused";
  if (sourceIssue(source)) return "Needs attention";
  return source.state === "active" ? "Connected" : "Awaiting approval";
}
export function orderUpdate(order: OrderSummary) {
  return (
    order.issue || (order.latestKind ? eventTitle(order.latestKind) : "Saved revision " + order.revision)
  );
}
export function reportError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
