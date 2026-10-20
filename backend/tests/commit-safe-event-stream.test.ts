import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { appendAudit } from '../src/domain/audit.js';
import { listEventStream } from '../src/platform/event-stream.js';
import { randomBytes } from 'node:crypto';

describe('commit safe stream',()=>{
  let opened:Awaited<ReturnType<typeof createPgliteDatabase>>;
  let now=Date.parse('2026-10-20T17:00:00Z');
  const clock={now:()=>new Date(now)};
  const config={signingKey:randomBytes(32).toString('base64')};
  const scope={tenantId:'tenant-stream',environment:'sandbox' as const};
  let user:string,proofId:string;
  beforeAll(async()=>{
    opened=await createPgliteDatabase();await migrate(opened.db);
    user=await insertUser(opened.db,clock);
    await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'stream','sandbox',$3)",[scope.tenantId,user,clock.now().toISOString()]);
    await opened.db.transaction(async tx=>{
      const txn=await createTransaction(tx,clock,user,{itemTitle:'Synthetic parcel'});
      const proof=await createOrGetProof(tx,clock,user,txn.transactionId);proofId=proof.proofId;
      await tx.query("INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,'1001',$2,'fixture',$3)",[scope.tenantId,proofId,clock.now().toISOString()]);
    });
  },60000);
  afterAll(async()=>{await opened?.close();});
  it('publishes initial events after binding, pages without losing the tail, and scopes signed cursors',async()=>{
    const first=await listEventStream(opened.db,clock,scope,config,{limit:1});
    expect(first.events).toHaveLength(1);expect(first.hasMore).toBe(true);
    const second=await listEventStream(opened.db,clock,scope,config,{after:first.nextCursor});
    expect(second.events.length).toBeGreaterThan(0);
    expect(new Set([...first.events,...second.events].map(e=>e.id)).size).toBe(first.events.length+second.events.length);
    await expect(listEventStream(opened.db,clock,{...scope,tenantId:'other'},config,{after:first.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(listEventStream(opened.db,clock,{...scope,environment:'live'},config,{after:first.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(listEventStream(opened.db,clock,scope,config,{after:first.nextCursor,proofId})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  });
  it('rolls back allocation and does not publish a failed domain mutation',async()=>{
    const before=await listEventStream(opened.db,clock,scope,config);
    await expect(opened.db.transaction(async tx=>{
      await appendAudit(tx,{proofId,actorUserId:user,eventType:'PROOF_ACCESSED',eventData:{},at:clock.now()});
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      throw new Error('synthetic crash');
    })).rejects.toThrow('synthetic crash');
    const empty=await listEventStream(opened.db,clock,scope,config,{after:before.nextCursor});expect(empty.events).toEqual([]);
    await opened.db.transaction(tx=>appendAudit(tx,{proofId,actorUserId:user,eventType:'PROOF_ACCESSED',eventData:{},at:clock.now()}));
    const after=await listEventStream(opened.db,clock,scope,config,{after:before.nextCursor});
    expect(after.events).toHaveLength(1);
    expect(BigInt(after.events[0].streamSequence)).toBe(BigInt(before.events.at(-1)!.streamSequence)+1n);
  });
  it('rejects forged and expired cursors with a recoverable response',async()=>{
    const page=await listEventStream(opened.db,clock,scope,config);
    await expect(listEventStream(opened.db,clock,scope,config,{after:page.nextCursor.replace(/^./,page.nextCursor[0]==='a'?'b':'a')})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    now+=604800001;
    await expect(listEventStream(opened.db,clock,scope,config,{after:page.nextCursor})).rejects.toMatchObject({code:'EVENT_CURSOR_EXPIRED',httpStatus:410});
  });
});
