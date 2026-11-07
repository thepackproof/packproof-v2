// Exact catalog shape for the checksum-pinned108 addition. Object OIDs and
// schema prefixes vary on restored databases and are deliberately excluded.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync(new URL('./record-agent-schema-manifest.json',import.meta.url),'utf8'));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function verifyRecordAgentSchemaCatalog(db){
 if(manifest.schema!=='packproof.record-agent-schema-manifest/v1'||manifest.migrationChecksum!=='65794164c6cd479a5921d0f1b7f4bc6585cbeca149657f2e156523553fc65f9f')throw Error('AGENT_SCHEMA_MANIFEST_MISMATCH');
 const catalog=await recordAgentSchemaCatalog(db);
 if(digest(catalog)!==digest(manifest.catalog))throw Error('AGENT_SCHEMA_CATALOG_MISMATCH');
 return digest(catalog);
}
export async function recordAgentSchemaCatalog(db){
 const schema=(await db.query('SELECT current_schema() AS name')).rows[0].name;
 const normalized=value=>String(value).replaceAll('"'+schema+'".','').replaceAll(schema+'.','');
 const tables=['record_agent_enrollments','record_agent_installations'];
 const columns=(await db.query(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace=current_schema()::regnamespace AND (c.relname=ANY($1::text[]) OR (c.relname='partner_import_jobs' AND a.attname=ANY($2::text[]))) ORDER BY c.relname,a.attnum`,[tables,['agent_installation_id','agent_config_revision']])).rows;
 const constraints=(await db.query(`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS deferred FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=current_schema()::regnamespace AND (c.relname=ANY($1::text[]) OR (c.relname='partner_import_jobs' AND k.conname=ANY($2::text[]))) ORDER BY c.relname,k.conname`,[tables,['partner_import_jobs_agent_installation_id_fkey','partner_import_jobs_agent_config_revision_check','partner_import_agent_revision']])).rows.map(row=>({...row,definition:normalized(row.definition)}));
 const indexes=(await db.query(`SELECT c.relname AS table_name,x.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique_index FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname,x.relname`,[tables])).rows.map(row=>({...row,definition:normalized(row.definition)}));
 return {columns:columns.map(row=>({...row,default_value:row.default_value===null?null:normalized(row.default_value)})),constraints,indexes};
}
