import { Glyph } from "./Brand";

export type ProofDiagramKind = "order" | "capture" | "share" | "review" | "export" | "integrity";

const descriptions: Record<ProofDiagramKind, string> = {
  order: "Order details and evidence stay connected in one Proof.",
  capture: "Record the item, packing, and seal as evidence for the order.",
  share: "Share a read-only view of selected evidence from your Proof.",
  review: "Review the order, evidence, and timeline together in one record.",
  export: "Export the Proof as a portable archive for local review.",
  integrity: "Compare exported files with their recorded hashes to check digital integrity.",
};

function Chip({ icon, children, accent = false }: { icon?: string; children: string; accent?: boolean }) {
  return <span className={`proof-diagram-chip${accent ? " is-accent" : ""}`}>
    {icon && <Glyph name={icon} size={18} />}{children}
  </span>;
}

/** Concept diagrams only: never used to represent a customer's evidence or verification status. */
export function ProofDiagram({ kind = "order" }: { kind?: ProofDiagramKind }) {
  return <div className={`proof-diagram proof-diagram--${kind}`} role="img" aria-label={descriptions[kind]}>
    <div className="proof-diagram-content" aria-hidden="true">
      {kind === "order" || kind === "review" ? <>
        <span className="proof-diagram-orbit" />
        <span className="proof-diagram-core"><Glyph name={kind === "order" ? "box" : "file"} size={52} /></span>
        <div className="diagram-north"><Chip icon={kind === "order" ? "store" : "box"}>ORDER</Chip></div>
        <div className="diagram-east"><Chip icon={kind === "order" ? "film" : "clock"}>{kind === "order" ? "EVIDENCE" : "TIMELINE"}</Chip></div>
        <div className="diagram-south"><Chip accent>{kind === "order" ? "PROOF" : "EVIDENCE"}</Chip></div>
      </> : kind === "capture" ? <>
        <div className="diagram-capture-frame">
          {[{icon:"box", label:"ITEM"}, {icon:"film", label:"PACK"}, {icon:"shield", label:"SEAL"}].map(step =>
            <span className="diagram-capture-step" key={step.label}><Glyph name={step.icon} size={30}/><span>{step.label}</span></span>)}
        </div>
        <span className="diagram-stem" />
        <div className="diagram-caption"><Chip icon="film" accent>ONE RECORDING</Chip></div>
      </> : <>
        <div className="diagram-pair">
          <span className="diagram-endpoint"><Glyph name={kind === "integrity" ? "file" : "shield"} size={36}/><span>{kind === "integrity" ? "FILES" : "PROOF"}</span></span>
          <span className="diagram-connection"><Glyph name={kind === "share" ? "link" : kind === "export" ? "download" : "code"} size={23}/></span>
          <span className="diagram-endpoint is-accent"><Glyph name={kind === "share" ? "file" : kind === "export" ? "download" : "code"} size={36}/><span>{kind === "share" ? "VIEW" : kind === "export" ? "ARCHIVE" : "HASHES"}</span></span>
        </div>
        <div className="diagram-caption"><Chip accent>{kind === "share" ? "READ-ONLY LINK" : kind === "export" ? "TAKE IT WITH YOU" : "COMPARE LOCALLY"}</Chip></div>
      </>}
    </div>
  </div>;
}
