import type { ObservationType, WorkflowType } from "./workflow.js";
import { DomainError } from "./errors.js";

export const CURRENT_WORKFLOW_VERSION = 1 as const;
export type WorkflowVersion = typeof CURRENT_WORKFLOW_VERSION;

export interface WorkflowDefinition {
  readonly workflowType: WorkflowType;
  readonly version: WorkflowVersion;
  readonly protocolId: string;
  readonly title: string;
  readonly description: string;
  readonly participantRoles: readonly ["SELLER"] | readonly ["SELLER", "BUYER"];
  readonly observationTypes: readonly ObservationType[];
  readonly captureRecipes: readonly string[];
  readonly semantics: {
    readonly originRole: string;
    readonly receivingRole: string | null;
    readonly purpose: string;
  };
}

const COMMERCE_SALE_V1: WorkflowDefinition = Object.freeze({
  workflowType: "COMMERCE_SALE",
  version: CURRENT_WORKFLOW_VERSION,
  protocolId: "packproof:commerce-sale:v1",
  title: "Commerce sale",
  description:
    "Evidence protocol for documenting seller fulfillment of a commerce transaction without changing the underlying transaction or adjudicating a dispute.",
  participantRoles: ["SELLER", "BUYER"],
  observationTypes: ["PACKED", "RELEASED", "RECEIVED"],
  captureRecipes: ["PACKING_STANDARD_V1", "RECEIPT_STANDARD_V1"],
  semantics: {
    originRole: "Seller",
    receivingRole: "Buyer",
    purpose: "Document transaction-bound packing, release, receipt, and supporting evidence.",
  },
});

const GRADING_SUBMISSION_V1: WorkflowDefinition = Object.freeze({
  workflowType: "GRADING_SUBMISSION",
  version: CURRENT_WORKFLOW_VERSION,
  protocolId: "packproof:grading-submission:v1",
  title: "Grading submission",
  description:
    "Evidence protocol for documenting identified assets across origin capture, outbound custody, processing, return, and final receipt.",
  participantRoles: ["SELLER", "BUYER"],
  observationTypes: [
    "ORIGIN_CAPTURE",
    "PACKED",
    "RELEASED",
    "RECEIVED",
    "INTAKE_CAPTURE",
    "PROCESS_OUTPUT",
    "RETURN_PACKED",
    "FINAL_RECEIPT",
  ],
  captureRecipes: ["CARD_STANDARD_V1", "PACKING_STANDARD_V1", "RECEIPT_STANDARD_V1"],
  semantics: {
    originRole: "Originator",
    receivingRole: "Receiving participant",
    purpose: "Document the continuity of identified assets through a round-trip custody workflow.",
  },
});

const REGISTRY: ReadonlyMap<string, WorkflowDefinition> = new Map([
  [keyFor(COMMERCE_SALE_V1.workflowType, COMMERCE_SALE_V1.version), COMMERCE_SALE_V1],
  [
    keyFor(GRADING_SUBMISSION_V1.workflowType, GRADING_SUBMISSION_V1.version),
    GRADING_SUBMISSION_V1,
  ],
]);

export function workflowDefinitionFor(
  workflowType: WorkflowType,
  version: number = CURRENT_WORKFLOW_VERSION,
): WorkflowDefinition {
  const definition = REGISTRY.get(keyFor(workflowType, version));
  if (!definition) {
    throw new DomainError(
      "UNSUPPORTED_WORKFLOW_VERSION",
      `Unsupported workflow protocol ${workflowType} v${version}`,
      422,
    );
  }
  return definition;
}

export function currentWorkflowDefinition(workflowType: WorkflowType): WorkflowDefinition {
  return workflowDefinitionFor(workflowType, CURRENT_WORKFLOW_VERSION);
}

export function listWorkflowDefinitions(): WorkflowDefinition[] {
  return Array.from(REGISTRY.values());
}

export function isSupportedWorkflowVersion(workflowType: WorkflowType, version: number): boolean {
  return REGISTRY.has(keyFor(workflowType, version));
}

function keyFor(workflowType: WorkflowType, version: number): string {
  return `${workflowType}:${version}`;
}
