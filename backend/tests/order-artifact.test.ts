import {readFile} from 'node:fs/promises';
import {describe,expect,it,vi} from 'vitest';
import {createPgliteDatabase} from '../src/db/pglite.js';
import type {Installation} from '../src/records/agent-enrollments.js';
import type {ObjectStore} from '../src/s3/object-store.js';
import {installationOperation} from '../src/records/order-workspace.js';
import {attachMedia,affectedMediaReferences,qualifiedArtifactBytes,readOrderArtifact} from '../src/records/order-artifact.js';
import {matchingSourceText} from '../src/records/order-source.js';
import {sha256Hex} from '../src/hash.js';
import {normalizedRecord,projectOrders,refKey} from '../src/records/order-projection.js';

describe('revision-bound original export',()=>{
  it('retrieves the exact versioned original only through a single-order explicitly linked media receipt',async()=>{
    const {db,close}=await createPgliteDatabase();
    try {
      for (const sql of [
        'CREATE TABLE record_order_sessions(installation_id text,state text,scope jsonb)',
        'CREATE TABLE record_order_roots(proof_id text,operation_key text,organization_id text,environment text,operator_membership_id text,location_id text)',
        'CREATE TABLE platform_proof_ownership(proof_id text,merchant_id text,environment text,operator_membership_id text)',
        'CREATE TABLE record_state(proof_id text,location_id text)',
        'CREATE TABLE record_order_revisions(proof_id text,revision integer,view jsonb)',
        'CREATE TABLE record_order_events(operation_key text,source_id text,record jsonb)',
        'CREATE TABLE record_order_receipts(id text,operation_key text,source_id text,generation integer,original_sha256 text,object_key text,object_version text,file_name text,media_type text,received_at timestamptz)'
      ]) await db.query(sql);
      const installation={id:'i',organization_id:'owner',environment:'sandbox',operator_membership_id:'operator',integration_account_id:'account',location_id:null} as Installation;
      const operation=installationOperation(installation);
      const photo=await readFile(new URL('../../examples/multisource-journey/fixtures/packing_photo.jpg',import.meta.url));
      const sha=sha256Hex(photo);
      const key=`evidence/owner/order-originals/committed/sha256-${sha}`;
      const get=vi.fn(async()=>({body:photo,contentType:'image/jpeg'}));
      const deps={objectStore:{get} as unknown as ObjectStore};
      const order={namespace:'ERP',type:'order',id:'SO10482'};
      const record=normalizedRecord({eventId:'picture',version:'1',kind:'evidence',entity:{namespace:'media',type:'photo',id:'P'},references:[order],fields:{artifactSha256:sha},lines:[],locator:'$'});
      const [view]=projectOrders([{id:'e',receipt_id:'sidecar',source_id:'photos',record,original_sha256:'f'.repeat(64),file_name:'packing_photo.json',profile_version:'1',received_at:'2026-11-17T12:00:00Z'}],[{proof_id:'p',source_id:'erp',order_reference:'SO10482',root_key:refKey(order)}]).projections;
      await db.query("INSERT INTO record_order_sessions VALUES ('i','active',$1::jsonb)",[JSON.stringify({sources:[{id:'photos',generation:1}]})]);
      await db.query("INSERT INTO record_order_events VALUES ($1,'photos',$2::jsonb)",[operation,JSON.stringify(record)]);
      await db.query("INSERT INTO record_order_roots VALUES ('p',$1,'owner','sandbox','operator',NULL)",[operation]);
      await db.query("INSERT INTO platform_proof_ownership VALUES ('p','owner','sandbox','operator')");
      await db.query("INSERT INTO record_state VALUES ('p',NULL)");
      for(const [id,source,file,kind] of [['photo','photos','packing_photo.jpg','image/jpeg'],['report','photos','all-orders.csv','text/csv'],['wrong-source','other','packing_photo.jpg','image/jpeg']]){
        await db.query("INSERT INTO record_order_receipts VALUES ($1,$2,$3,1,$4,$5,'version-1',$6,$7,now())",[id,operation,source,sha,key,file,kind]);
      }
      expect(await affectedMediaReferences(db,operation,'photos',sha)).toContain(refKey(order));
      expect(await affectedMediaReferences(db,operation,'other',sha)).toEqual([]);
      const projected=await attachMedia(db,operation,view);
      expect(projected.originalArtifacts.map(a=>a.receiptId)).toEqual(['photo']);
      const shared=await attachMedia(db,operation,{...view,events:view.events.map(e=>({...e,associationScope:'shared'}))});
      expect(shared.originalArtifacts).toEqual([]);
      await db.query("INSERT INTO record_order_revisions VALUES ('p',1,$1::jsonb),('p',2,$2::jsonb)",[JSON.stringify(view),JSON.stringify(projected)]);
      await expect(readOrderArtifact(deps,db,installation,'p','1','photo')).rejects.toMatchObject({code:'ARTIFACT_NOT_FOUND'});
      for(const id of ['report','wrong-source']) await expect(readOrderArtifact(deps,db,installation,'p','2',id)).rejects.toMatchObject({code:'ARTIFACT_NOT_FOUND'});
      await expect(readOrderArtifact(deps,db,{...installation,organization_id:'another'},'p','2','photo')).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
      expect(get).not.toHaveBeenCalled();
      const result=await readOrderArtifact(deps,db,installation,'p','2','photo');
      expect(result).toMatchObject({kind:'original',bytesBase64:photo.toString('base64'),receiptId:'photo',originalSha256:sha});
      expect(get).toHaveBeenCalledWith(key,{versionId:'version-1'});
      await db.query("UPDATE record_order_sessions SET scope='{\"sources\":[]}'::jsonb WHERE installation_id='i'");
      expect(await readOrderArtifact(deps,db,installation,'p','2','photo')).toMatchObject({kind:'derived_excerpt'});
      await db.query("UPDATE platform_proof_ownership SET operator_membership_id='another-operator' WHERE proof_id='p'");
      await expect(readOrderArtifact(deps,db,installation,'p','2','photo')).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
      expect(get).toHaveBeenCalledTimes(1);
    } finally {await close();}
  });

  it('preserves single-label ZPL and excludes multi-label batches and unsupported documents',()=>{
    const label=Buffer.from('^XA^FDA100^FS^XZ');
    expect(qualifiedArtifactBytes(label,'application/zpl')).toBe(true);
    expect(qualifiedArtifactBytes(Buffer.concat([label,label]),'application/zpl')).toBe(false);
    expect(qualifiedArtifactBytes(Buffer.from('order,name\n1,Sample'),'image/jpeg')).toBe(false);
    expect(qualifiedArtifactBytes(Buffer.from('%PDF-1.7'),'application/pdf')).toBe(false);
  });
});

it('shows exact source text only for a single fully represented row',()=>{
  const record=normalizedRecord({eventId:'e',version:'1',kind:'order',entity:{namespace:'erp',type:'order',id:'A'},
    references:[],fields:{order:'A',amount:'8'},lines:[],locator:'row 2'});
  const read=(value:string,file='row.json')=>matchingSourceText(Buffer.from(value),file,record);
  expect(read(' { "order": "A", "amount": 8 } ')).toBe(' { "order": "A", "amount": 8 } ');
  expect(read('order,amount\r\nA,8\r\n','order.csv')).toBe('order,amount\r\nA,8\r\n');
  expect(read('[{"order":"A"},{"order":"B"}]')).toBeNull();
  expect(read('{"order":"B","order":"A"}')).toBeNull();
  expect(read('{"order":"A","anotherOrder":{"order":"B"}}')).toBeNull();
  expect(read('order,amount\nA,8\nB,3','order.csv')).toBeNull();
});
