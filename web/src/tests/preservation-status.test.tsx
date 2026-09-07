import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { preservationMessage, type RecoveryView } from "../components/PreservationStatus";
import { CompletionScreen } from "../screens/CompletionScreen";
import type { PackProofApi } from "../api/client";
afterEach(cleanup);
const view = (status:string,receipt:unknown=null):RecoveryView=>({proofId:"proof",evidence:[{evidenceId:"evidence",status:"COMMITTED_PENDING_DURABILITY",receipt:null}],declarations:[],finalization:{status,receipt}});
it("does not represent an HTTP commit or unreceipted status as preservation",()=>{
  expect(preservationMessage(view("COMMITTED_PENDING_DURABILITY"))).toContain("Preservation in progress");
  expect(preservationMessage(view("PRESERVED"))).not.toContain("Proof finalized");
  expect(preservationMessage(view("PRESERVED",{version:1}))).toBe("Proof finalized and available.");
  expect(preservationMessage(null)).toContain("Keep your local recording");
});
it("labels a compatibility submission without claiming durable preservation",()=>{
  expect(preservationMessage(view("COMMITTED_PENDING_DURABILITY"),false,true)).toBe("Proof submitted. Keep your local original until preservation is confirmed.");
  expect(preservationMessage(view("COMMITTED_PENDING_DURABILITY"),true,true)).toContain("Preservation in progress");
  expect(preservationMessage(view("COMMITTED_PENDING_DURABILITY"),false,false)).not.toContain("Proof submitted");
});
it("checks preservation when the completion URL is opened directly",async()=>{
  const api={getRecoveryStatus:vi.fn().mockResolvedValue(view("COMMITTED_PENDING_DURABILITY"))};
  render(<CompletionScreen api={api as unknown as PackProofApi} proofId="proof" onViewProof={()=>{}} onGoHome={()=>{}}/>);
  expect(await screen.findByText("Recording received. Preservation in progress.")).toBeInTheDocument();
  expect(screen.queryByText("Your evidence record has been sealed.")).not.toBeInTheDocument();
});
