export const MEASUREMENT_MIGRATION=Object.freeze({id:'076_first_experience_measurement',checksum:'3b80452692918bb3589500d100b773deeb8cddf3c57b6882796e8cd1a13c1157'});
/** This source comparison permits one reviewed additive change, never DDL.
 * The later read-only verifier still requires all 77 actual receipts. */
export function reviewedMeasurementInventory(candidate,predecessor,compatibilitySource=''){
 if(candidate.length!==77||![76,77].includes(predecessor.length))return false;
 const measurement=candidate.find(row=>row.id===MEASUREMENT_MIGRATION.id);
 if(measurement?.checksum!==MEASUREMENT_MIGRATION.checksum)return false;
 const prior=new Map(predecessor.map(row=>[row.id,row.checksum]));
 if(prior.size!==predecessor.length||new Set(candidate.map(row=>row.id)).size!==candidate.length)return false;
 if(candidate.some(row=>row.id!==MEASUREMENT_MIGRATION.id&&prior.get(row.id)!==row.checksum))return false;
 if(predecessor.length===77)return prior.get(MEASUREMENT_MIGRATION.id)===MEASUREMENT_MIGRATION.checksum;
 return !prior.has(MEASUREMENT_MIGRATION.id)&&compatibilitySource.includes(MEASUREMENT_MIGRATION.id)&&compatibilitySource.includes(MEASUREMENT_MIGRATION.checksum);
}
