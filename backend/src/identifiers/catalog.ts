import type {Database} from '../db/database.js';
import {sha256Hex} from '../hash.js';
import {normalizeGtin} from './core.js';
import type {IntakeItem} from '../intake/context.js';
export interface AliasRow {id:string;owner_user_id:string;tenant_key:string;connection_id:string;identifier_type:'SKU'|'GTIN';normalized_value:string;source_ref:string;source_revision:string;snapshot_id:string|null;order_record_id:string|null;transaction_id:string|null;product_key:string;product_json:{title:string|null;variant:string|null;sku:string|null;gtin:string|null;imageUrl:string|null;externalItemId:string|null};observed_at:string|Date;}
const safeImage=(s:unknown):string|null=>{if(typeof s!=='string'||s.length>2048)return null;try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&['cdn.shopify.com','i.ebayimg.com','i.etsystatic.com'].includes(u.hostname)?u.href:null;}catch{return null;}};
export async function indexIdentifierItems(db:Database,input:{ownerUserId:string;tenantKey:string;connectionId:string;sourceId:string;sourceRevision:string;snapshotId?:string|null;orderRecordId?:string|null;transactionId?:string|null;observedAt:string;items:Array<IntakeItem & {barcode?:string|null;gtin?:string|null;productId?:string|null;variantId?:string|null;imageUrl?:string|null}>}) {
  const connection=(await db.query<{adapter_key:string}>('SELECT adapter_key FROM integration_connections WHERE id=$1 AND owner_user_id=$2',[input.connectionId,input.ownerUserId])).rows[0];
  if(!connection||/demo|reference/i.test(connection.adapter_key))return;
  for(const [index,item] of input.items.entries()) {
    const sourceRef=`${input.sourceId}:${index+1}`;
    const gtin=normalizeGtin(item.gtin??item.barcode??'');
    const product={title:item.title??null,variant:item.variant??null,sku:item.sku??null,gtin,imageUrl:safeImage(item.imageUrl),externalItemId:item.externalItemId??null};
    // A provider variant ID is global within its store. Otherwise keep each order line
    // distinct; a duplicated SKU must not collapse genuinely different products.
    const key=item.variantId?`variant:${item.variantId}`:item.productId?`product:${item.productId}:${item.variant??''}`:`descriptor:${[product.title,product.variant,product.sku,gtin].map(v=>`${Buffer.byteLength(v??'')}:${v??''}`).join('|')}`;
    const aliases:Array<['SKU'|'GTIN',string]>=[];
    if(item.sku&&Buffer.byteLength(item.sku)<=300)aliases.push(['SKU',item.sku]);
    if(gtin)aliases.push(['GTIN',gtin]);
    // Non-GTIN merchant barcodes are exact merchant identifiers, preserving case.
    if(item.barcode&&!gtin&&item.barcode!==item.sku&&Buffer.byteLength(item.barcode)<=300)aliases.push(['SKU',item.barcode]);
    for(const [type,value] of aliases)await db.query(`INSERT INTO identifier_aliases(id,owner_user_id,tenant_key,connection_id,identifier_type,normalized_value,source_ref,source_revision,snapshot_id,order_record_id,transaction_id,product_key,product_json,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) ON CONFLICT DO NOTHING`,['alias_'+sha256Hex(`${input.tenantKey}:${input.connectionId}:${type}:${value}:${sourceRef}`),input.ownerUserId,input.tenantKey,input.connectionId,type,value,sourceRef,input.sourceRevision,input.snapshotId??null,input.orderRecordId??null,input.transactionId??null,key,JSON.stringify(product),input.observedAt]);
  }
}
export async function indexIntakeIdentifierSnapshot(db:Database,snapshotId:string) {
 const row=(await db.query<{id:string;transaction_id:string;context:{tenantKey:string;items:IntakeItem[]};digest:string;created_at:string|Date;actor_user_id:string;connection_id:string;source_kind:string}>(`SELECT s.*,o.actor_user_id,o.connection_id,o.source_kind FROM intake_order_snapshots s JOIN intake_source_observations o ON o.id=s.observation_id WHERE s.id=$1`,[snapshotId])).rows[0];
 if(row?.source_kind==='API_OBSERVED')await indexIdentifierItems(db,{ownerUserId:row.actor_user_id,tenantKey:row.context.tenantKey,connectionId:row.connection_id,sourceId:row.id,sourceRevision:row.digest,snapshotId:row.id,transactionId:row.transaction_id,observedAt:new Date(row.created_at).toISOString(),items:row.context.items});
}
export async function findIdentifierAliases(db:Database,scope:{actor:string;tenantKey:string;connectionId:string},type:'SKU'|'GTIN',value:string):Promise<AliasRow[]> {
 return (await db.query<AliasRow>(`SELECT a.* FROM identifier_aliases a JOIN integration_connections c ON c.id=a.connection_id AND c.owner_user_id=a.owner_user_id AND c.status='ACTIVE'
 LEFT JOIN commerce_order_records r ON r.id=a.order_record_id
 WHERE a.owner_user_id=$1 AND a.tenant_key=$2 AND a.connection_id=$3 AND a.identifier_type=$4 AND a.normalized_value=$5
 AND (a.order_record_id IS NULL OR r.normalized_fingerprint=a.source_revision)
 ORDER BY a.observed_at DESC,a.id LIMIT 201`,[scope.actor,scope.tenantKey,scope.connectionId,type,value])).rows;
}

/** Fold two records only through their exact source order-line relationship. */
export function distinctProductAliases(aliases:AliasRow[]):Map<string,AliasRow> {
 const products=new Map<string,AliasRow>();
 for(const alias of aliases){
  const p=alias.product_json;
  const newer=alias.snapshot_id?aliases.find(other=>other.order_record_id&&other.transaction_id===alias.transaction_id&&p.externalItemId&&other.product_json.externalItemId===p.externalItemId):null;
  const representative=newer??alias;
  if(!products.has(representative.product_key))products.set(representative.product_key,representative);
 }
 return products;
}
