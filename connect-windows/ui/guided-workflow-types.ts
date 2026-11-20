export interface FacilityStep {
  id: string;
  name: string;
  scope: "order" | "line" | "carton" | "shipment";
  system: string;
  device: string;
  optional: boolean;
  after: string[];
  record?: {identifier: string; timeField: string; unit: string; format: string};
}
export interface FacilityInputs {
  steps: FacilityStep[];
  examples: {
    kind: "ordinary" | "split" | "reprint";
    reference: string;
    cartons: number | null;
    labelCount: number | null;
  }[];
  rules: {sourceId: string; shippedAt: "label" | "handoff" | "unknown"}[];
  excludedSourceIds: string[];
  timing?: {sourceId:string; expectedCheckIntervalSeconds?:number; expectedDeliveryAfterLabelSeconds?:number}[];
  packing?: {sourceId:string; orderSourceId:string; schema:string; cartonField:string; weightField?:string;
    unitField?:string; unitValue?:string; unit?:"kg"|"g"|"lb"|"oz"}[];
  recordEdits?: {sourceId:string; recordHash:string; fromSpace:string; fromId:string; toSpace:string; toId:string}[];
}
export interface FacilityDraft extends FacilityInputs {
  id: string;
  revision: number;
  scopeKey: string;
  replay: {
    passed: boolean;
    digest: string;
    checks: {kind: string; reference: string; passed: boolean; message: string}[];
    sources: {sourceId: string; readable: boolean; message: string}[];
  } | null;
}
