import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {RecordWorkspace} from './access.js';
import {caseScopeSql,requireCaseWorkspace,requireCaseAccess,currentCaseObservationSql,caseObservationSupersededSql} from './cases.js';
import {reconstructionFeatureEnabled} from './reconstruction-features.js';

/** A visible group is a projection of currently authorized endpoints. Restricted
 * neighbors contribute one opaque boolean, never an identifier or hidden count. */
export async function readCaseLinks(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,limit=100,offset=0){
 if(!reconstructionFeatureEnabled('crossCase'))return {caseLinks:[],restrictedCaseLinks:false,caseLinksTotal:0};
 const current=await requireCaseWorkspace(db,clock,w);await requireCaseAccess(db,clock,current,caseId);const scope=caseScopeSql(current,'neighbor',2);
 const from=`FROM record_case_links link JOIN record_typed_rows source ON source.id=link.observation_id JOIN record_cases neighbor ON neighbor.id=CASE WHEN link.left_case_id=$1 THEN link.right_case_id ELSE link.left_case_id END WHERE (link.left_case_id=$1 OR link.right_case_id=$1) AND link.state='linked' AND ${currentCaseObservationSql('source','link.left_case_id')} AND ${currentCaseObservationSql('source','link.right_case_id')} AND NOT ${caseObservationSupersededSql('source.id','$1')} AND NOT EXISTS(SELECT 1 FROM record_case_links successor WHERE successor.supersedes_id=link.id)`;
 const [rows,counts]=await Promise.all([
  db.query<{id:string;relation_type:string;shared_reference:unknown;basis:unknown;observation_id:string;neighbor_id:string;root_external_id:string;root_type:string;location_id:string}>(`SELECT link.*,neighbor.id neighbor_id,neighbor.root_external_id,neighbor.root_type,neighbor.location_id ${from} AND ${scope.sql} ORDER BY link.id LIMIT $7 OFFSET $8`,[caseId,...scope.params,limit,offset]),
  db.query<{n:number;restricted:boolean}>(`SELECT (SELECT COUNT(*)::integer ${from} AND ${scope.sql}) n,EXISTS(SELECT 1 ${from} AND NOT (${scope.sql})) restricted`,[caseId,...scope.params])
 ]);
 await requireCaseAccess(db,clock,current,caseId);
 return {caseLinks:rows.rows.map(row=>({id:row.id,type:row.relation_type,sharedReference:row.shared_reference,neighbor:{id:row.neighbor_id,reference:row.root_external_id,type:row.root_type,locationId:row.location_id},basis:row.basis,sourceObservationId:row.observation_id,restricted:false})),restrictedCaseLinks:counts.rows[0].restricted,caseLinksTotal:Number(counts.rows[0].n)};
}

export async function hasRestrictedCaseAliases(db:Database,clock:Clock,w:RecordWorkspace,caseId:string){
 if(!reconstructionFeatureEnabled('crossCase'))return false;
 const current=await requireCaseWorkspace(db,clock,w);await requireCaseAccess(db,clock,current,caseId);const left=caseScopeSql(current,'l',2),right=caseScopeSql(current,'r',2);
 return (await db.query<{restricted:boolean}>(`SELECT EXISTS(SELECT 1 FROM record_case_entity_aliases a JOIN record_cases l ON l.id=a.left_case_id JOIN record_cases r ON r.id=a.right_case_id WHERE (a.left_case_id=$1 OR a.right_case_id=$1) AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases successor WHERE successor.supersedes_id=a.id) AND NOT ((${left.sql}) AND (${right.sql}))) restricted`,[caseId,...left.params])).rows[0].restricted;
}

/** Complete internal/export graph; portal requests use readCaseLinks directly. */
export async function readCompleteCaseLinks(db:Database,clock:Clock,w:RecordWorkspace,caseId:string){
 const first=await readCaseLinks(db,clock,w,caseId,100),caseLinks=[...first.caseLinks];
 for(let offset=100;offset<first.caseLinksTotal;offset+=100)caseLinks.push(...(await readCaseLinks(db,clock,w,caseId,100,offset)).caseLinks);
 return {...first,caseLinks};
}
