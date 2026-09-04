import { describe, expect, it } from "vitest";
import {
  CURRENT_WORKFLOW_VERSION,
  currentWorkflowDefinition,
  isSupportedWorkflowVersion,
  listWorkflowDefinitions,
  workflowDefinitionFor,
} from "../src/domain/workflow-registry.js";

describe("workflow protocol registry", () => {
  it("registers the existing workflows as stable v1 protocols", () => {
    const commerce = currentWorkflowDefinition("COMMERCE_SALE");
    const grading = currentWorkflowDefinition("GRADING_SUBMISSION");

    expect(commerce).toMatchObject({
      workflowType: "COMMERCE_SALE",
      version: 1,
      protocolId: "packproof:commerce-sale:v1",
    });
    expect(commerce.observationTypes).toEqual(["PACKED", "RELEASED", "RECEIVED"]);

    expect(grading).toMatchObject({
      workflowType: "GRADING_SUBMISSION",
      version: 1,
      protocolId: "packproof:grading-submission:v1",
    });
    expect(grading.observationTypes).toContain("ORIGIN_CAPTURE");
    expect(grading.observationTypes).toContain("FINAL_RECEIPT");
  });

  it("fails closed instead of silently interpreting an unknown protocol version", () => {
    expect(CURRENT_WORKFLOW_VERSION).toBe(1);
    expect(isSupportedWorkflowVersion("COMMERCE_SALE", 2)).toBe(false);
    expect(() => workflowDefinitionFor("COMMERCE_SALE", 2)).toThrow(/Unsupported workflow protocol/);
  });

  it("keeps protocol ids unique", () => {
    const definitions = listWorkflowDefinitions();
    expect(new Set(definitions.map((definition) => definition.protocolId)).size).toBe(
      definitions.length,
    );
  });
});
