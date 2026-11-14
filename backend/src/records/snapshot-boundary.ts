import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';
import {explicitInstant} from './csv-semantics.js';
import {parseTypedCsvRecords} from './typed-csv.js';
import type {TypedSourceBatch,TypedSourceCompleteness} from './source-contracts.js';

export const CSV_SNAPSHOT_BOUNDARY_SCHEMA='packproof.csv-snapshot-boundary/v1' as const;
export interface CsvSnapshotBoundary {
 schema:typeof CSV_SNAPSHOT_BOUNDARY_SCHEMA;markerColumn:string;asOfColumn:string;rowCountColumn:string;
}
const invalid=(message:string):never=>{throw new DomainError('SOURCE_SNAPSHOT_BOUNDARY_INVALID',message,400);};
export function parseCsvSnapshotBoundary(input:unknown,headers:readonly string[]):CsvSnapshotBoundary {
 const b=strictBody(input,['schema','markerColumn','asOfColumn','rowCountColumn']);
 if(b.schema!==CSV_SNAPSHOT_BOUNDARY_SCHEMA)invalid('Use the supported CSV snapshot control schema.');
 const column=(value:unknown,name:string)=>{if(typeof value!=='string'||!value.trim()||value.length>200||!headers.includes(value))invalid(`${name} must name an exact approved source header.`);return value as string;};
 const markerColumn=column(b.markerColumn,'markerColumn'),asOfColumn=column(b.asOfColumn,'asOfColumn'),rowCountColumn=column(b.rowCountColumn,'rowCountColumn');
 if(new Set([markerColumn,asOfColumn,rowCountColumn]).size!==3)invalid('Snapshot marker, boundary and control total require three distinct source columns.');
 return {schema:CSV_SNAPSHOT_BOUNDARY_SCHEMA,markerColumn,asOfColumn,rowCountColumn};
}
/** Controls are claims made by the exporter in every original business row.
 * Counting retained rows verifies its supplied total; it never creates one. */
export function csvSnapshotCompleteness(original:{mediaType:string;content:string},binding:CsvSnapshotBoundary):TypedSourceCompleteness {
 if(original.mediaType!=='text/csv')invalid('Approved CSV snapshot controls require the complete original CSV.');
 if(!original.content||Buffer.byteLength(original.content,'utf8')>2097152||Buffer.from(original.content,'utf8').toString('utf8')!==original.content)invalid('Snapshot controls require a bounded exact UTF-8 CSV original.');
 let records:string[][]=[];try{records=parseTypedCsvRecords(original.content);}catch{invalid('The exact original CSV could not be parsed for snapshot controls.');}
 const headers=records[0]??[];
 if(records.length<2||records.length>1001||headers.some(h=>!h.trim()||h.length>200)||new Set(headers).size!==headers.length)invalid('Include exact unique headers and one to 1,000 raw business rows.');
 const approved=parseCsvSnapshotBoundary(binding,headers),markerAt=headers.indexOf(approved.markerColumn),asOfAt=headers.indexOf(approved.asOfColumn),countAt=headers.indexOf(approved.rowCountColumn),rows=records.slice(1);
 let marker:string|undefined,asOf:string|undefined,reportedCount:string|undefined;
 for(const cells of rows){
  if(cells.length!==headers.length)invalid('Every snapshot row must have exactly the approved source columns.');
  const m=cells[markerAt],a=cells[asOfAt],c=cells[countAt];
  if(!m||!m.trim()||m.length>200)invalid('Every business row must carry a nonempty exact source snapshot marker.');
  if(explicitInstant(a)===null||a.startsWith('0000-'))invalid('Every business row must carry a valid snapshot boundary with an explicit UTC offset.');
  if(!/^(?:0|[1-9][0-9]*)$/.test(c)||!Number.isSafeInteger(Number(c))||Number(c)>1000)invalid('Every business row must carry a canonical nonnegative integer source control total.');
  if(marker!==undefined&&(m!==marker||a!==asOf||c!==reportedCount))invalid('Snapshot controls must repeat exactly in every raw business row.');
  marker=m;asOf=a;reportedCount=c;
 }
 if(Number(reportedCount)!==rows.length)invalid('The exporter control total does not match the complete original business-row count.');
 return {kind:'snapshot',asOf:asOf!,marker:marker!};
}
export function assertSourceSnapshotBoundary(config:{completenessPolicy:{kind:string;sourceOwnerQualified:boolean;qualificationReference?:string|null;fileBoundary?:CsvSnapshotBoundary}},batch:TypedSourceBatch){
 const policy=config.completenessPolicy,binding=policy.fileBoundary;if(!binding)return null;
 if(batch.schema!=='packproof.typed-source-batch/v2'||policy.kind!=='snapshot'||!policy.sourceOwnerQualified||!policy.qualificationReference?.trim())invalid('CSV snapshot controls require an explicitly qualified version two snapshot source policy.');
 const actual=csvSnapshotCompleteness(batch.original,binding),claim=batch.completeness;
 if(claim.kind!==actual.kind||claim.marker!==actual.marker||claim.asOf!==actual.asOf)invalid('The requested completeness must match the source snapshot controls in the exact original CSV.');
 return actual;
}
