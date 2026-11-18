import {expect,it} from 'vitest';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {listOrders,listOrderIssues} from '../src/records/order-feed.js';
it('counts, pages and reviews only the latest currently visible order revisions',async()=>{
  const {db,close}=await createPgliteDatabase();
  try{
    await db.query('CREATE TABLE record_order_roots(proof_id text PRIMARY KEY, operation_key text, organization_id text, operator_membership_id text, environment text, location_id text, order_reference text)');
    await db.query('CREATE TABLE record_order_revisions(sequence bigserial PRIMARY KEY, proof_id text, revision integer, committed_at timestamptz, view jsonb)');
    await db.query('CREATE TABLE platform_proof_ownership(proof_id text,merchant_id text,operator_membership_id text,environment text)');
    await db.query('CREATE TABLE record_state(proof_id text,location_id text)');
    await db.query("INSERT INTO record_order_roots SELECT n::text,'work','org','operator','live','loc','SO-'||n FROM generate_series(1,24)n");
    await db.query("INSERT INTO platform_proof_ownership SELECT proof_id,organization_id,operator_membership_id,environment FROM record_order_roots");
    await db.query("INSERT INTO record_state SELECT proof_id,CASE WHEN proof_id='23' THEN 'moved' ELSE location_id END FROM record_order_roots");
    const view={events:[{kind:'order',fields:{customerName:'Riverside',fulfillmentStatus:'Partially fulfilled'}},{kind:'receiving',fields:{customer:'Other label'}}],lines:[{loadedAcknowledgedDiscrepancy:'2 EA more loaded than acknowledged'}],conflicts:[]};
    await db.query("INSERT INTO record_order_revisions(proof_id,revision,committed_at,view) SELECT proof_id,1,now()-interval '2 days',$1 FROM record_order_roots ORDER BY proof_id::integer",[view]);
    await db.query("INSERT INTO record_order_revisions(proof_id,revision,committed_at,view) VALUES ('24',2,now(),$1)",[{...view,lines:[]}]);
    const scope={where:'r.operation_key=$1',params:['work']};
    const dayStart=new Date(Date.now()-3600000).toISOString();
    const first=await listOrders(db,scope,null,1,null,dayStart);
    expect(first).toMatchObject({totalOrders:23,updatedLast24Hours:1,updatedToday:1,orders:[{proofId:'24',revision:2,customerName:'Riverside',fulfillmentStatus:'Partially fulfilled',latestKind:'receiving'}]});
    expect(first.orders[0].issue).toBeUndefined();
    const older=await listOrders(db,scope,null,1,first.nextBefore);
    expect(older.orders[0]).toMatchObject({proofId:'22',issue:'2 EA more loaded than acknowledged'});
    const issues=await listOrderIssues(db,scope);
    expect(issues.orderIssueCount).toBe(22);expect(issues.orderIssues).toHaveLength(20);
    const remaining=await listOrderIssues(db,scope,issues.nextIssuesBefore);
    expect(remaining.orderIssues.map(o=>o.proofId)).toEqual(['2','1']);expect(remaining.nextIssuesBefore).toBeNull();
    expect((await listOrders(db,scope,'SO-23',20)).orders).toEqual([]);
    expect((await listOrderIssues(db,{where:'r.operation_key=$1',params:['elsewhere']})).orderIssueCount).toBe(0);
  }finally{await close();}
},20000);
