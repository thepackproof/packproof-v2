import {FORWARD_COMPATIBLE_MIGRATIONS as previous, isReviewedForwardCompatibleMigration as previouslyReviewed} from './forward-compatible-migrations.previous.js';

const additions = Object.freeze([
  Object.freeze({id:'123_order_workspace',checksum:'941c88e20122caaaab739ee28f791d5b65157a6bb4acd347c4ff7e2e3801c1bd'}),
  Object.freeze({id:'124_connect_collector_version',checksum:'66db31ba54b918122ede837715987c19273c8c76aecf4fd1b7a278d161eaa5be'}),
]);
export const FORWARD_COMPATIBLE_MIGRATIONS = Object.freeze([...previous,...additions]);
export function isReviewedForwardCompatibleMigration(row) {
  return previouslyReviewed(row) || additions.some(entry => entry.id === row?.id && entry.checksum === row.checksum);
}
