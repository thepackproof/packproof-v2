import {FORWARD_COMPATIBLE_MIGRATIONS as previous, isReviewedForwardCompatibleMigration as previouslyReviewed} from './forward-compatible-migrations.previous.js';

const addition=Object.freeze({id:'123_order_workspace',checksum:'941c88e20122caaaab739ee28f791d5b65157a6bb4acd347c4ff7e2e3801c1bd'});
export const FORWARD_COMPATIBLE_MIGRATIONS=Object.freeze([...previous,addition]);
export function isReviewedForwardCompatibleMigration(row){
  return previouslyReviewed(row) || row?.id===addition.id && row.checksum===addition.checksum;
}
