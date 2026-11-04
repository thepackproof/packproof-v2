export type RecordEnvironment = 'sandbox' | 'live';
export interface RecordSummary {
  id:string; proofId:string; organizationId:string; environment:RecordEnvironment;
  reference:string|null; title:string|null; trackingNumber:string|null; carrier:string|null;
  createdAt:string; updatedAt:string; revision:number; lifecycle:'open'|'closed';
  sample:false; locationId:string|null; sourceName:string;
  entityCounts:Partial<Record<'shipment'|'stop'|'package'|'pallet'|'item'|'return',number>>;
  coverage:{satisfied:number;total:number;waived:number;missing:number;notYetDue:number};
  integrity:'not_sealed'|'sealed'; review:'needs_attention'|'reviewed'|'unreviewed'; issueCount:number;
}
export interface RecordTimelineEvent {
  id:string; type:string; reportedAt:string|null; receivedAt:string; source:string;
  actorId:string|null; subjectId:string; data:Record<string,unknown>;
}
export interface RecordEvidence {
  id:string; type:string; contentType:string; byteSize:number|null; sha256:string|null;
  state:'available'|'pending'|'rejected'; receivedAt:string; reportedAt:string|null;
  source:string; subjectIds:string[]; original:true;
}
export interface RecordRequirement {
  id:string; subjectId:string; stage:string; title:string; templateVersion:string;
  acceptedEvidenceTypes:string[]; dueAt:string|null; gracePeriodMs:number;
  status:'satisfied'|'missing'|'not_yet_due'|'waived'; evidenceIds:string[];
  waiver:null|{id:string;reason:string;actorId:string;createdAt:string};
}
export interface RecordIssue {
  id:string; proofId:string; category:string; severity:'info'|'warning'|'critical';
  title:string; subjectId:string; ruleVersion:string; comparedSources:unknown;
  status:'open'|'acknowledged'|'resolved'; createdAt:string; updatedAt:string;
  actions:Array<{id:string;action:string;reason:string;actorId:string;createdAt:string}>;
}
