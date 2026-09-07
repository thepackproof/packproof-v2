import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import request from 'supertest';
import {createHarness,createUser,auth,type TestHarness} from './helpers.js';
import {StripeEnrollment,type StripeApi} from '../src/billing/stripe-enrollment.js';
import {registerOfferVersion,scheduleApprovedOfferPeriod,type OfferDefinition} from '../src/billing/usage-ledger.js';
import {syntheticPublication} from './program-metrics-publication-fixture.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import {createCaptureSession,completeCaptureSession} from '../src/domain/capture-sessions.js';

let h:TestHarness,sequence=0;const now=new Date('2026-09-07T12:00:00Z'),clock={now:()=>new Date(now)};
beforeAll(async()=>{h=await createHarness(clock);},30000);afterAll(async()=>{await h.close();});
async function proof(userId:string){const t=await request(h.app).post('/transactions').set(auth(userId)).send({itemTitle:'VHS test'});const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(userId)).send({});expect(p.status).toBe(200);return p.body.proofId as string;}
async function setup(){
  const n=++sequence,userId=await createUser(h),offer:OfferDefinition={schemaVersion:'packproof.billing.v1',version:`checkout-offer-${n}`,status:'approved',currency:'USD',priceMinor:2900,interval:'monthly',includedFinalizedProofs:1,maxRecordingBytes:10000,maxRecordingSeconds:30,retentionPolicyVersion:'test-retention-v1',preservationStandard:'canonical-original-v1',supplements:'included_within_published_allowance',overage:'block_new_capture',approvedTermsReference:'synthetic-terms'};
  const approval={publication:syntheticPublication(offer,now)};await registerOfferVersion(h.db,clock,offer,approval);
  const price={id:'price_fixture',object:'price',livemode:false,active:true,currency:'usd',unit_amount:2900,type:'recurring',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
  const customer=`cus_fixture${n}`,subscription=`sub_fixture${n}`,sessionId=`cs_test_fixture${n}`,epoch=Math.floor(now.getTime()/1000),calls:Array<{route:string;body?:URLSearchParams;key?:string}>=[];
  let session:Record<string,unknown>={},sub:Record<string,unknown>={},wrongPrice=false;
  const api:StripeApi=async(route,body,key)=>{calls.push({route,body,key});
    if(route==='/v1/prices/price_fixture')return {...price,unit_amount:wrongPrice?3000:2900};
    if(route==='/v1/checkout/sessions'&&body){const binding=body.get('client_reference_id');session={id:sessionId,object:'checkout.session',livemode:false,mode:'subscription',status:'open',client_reference_id:binding,metadata:{packproof_checkout:binding},url:`https://checkout.stripe.com/c/pay/${sessionId}#valid-provider-fragment`,expires_at:epoch+3600,customer,subscription,payment_status:'unpaid',consent:{terms_of_service:'accepted'}};sub={id:subscription,object:'subscription',livemode:false,customer,status:'active',metadata:{packproof_checkout:binding},items:{has_more:false,data:[{quantity:1,price,current_period_start:epoch,current_period_end:epoch+30*86400}]},trial_end:null,cancel_at_period_end:false,cancel_at:null,canceled_at:null,ended_at:null};return session;}
    if(route===`/v1/checkout/sessions/${sessionId}`)return session;
    if(route===`/v1/subscriptions/${subscription}`)return sub;
    if(route.startsWith('/v1/subscriptions?'))return {object:'list',data:[sub],has_more:false};
    throw new Error(`Unexpected fixture route ${route}`);
  };
  const service=new StripeEnrollment('acct_fixture','sandbox',clock,{offerVersion:offer.version,priceReference:'price_fixture',successUrl:'https://packproof.example/account',cancelUrl:'https://packproof.example/account'},api,approval);
  const input={operationId:`operation-fixture-${n}`,offerVersion:offer.version,acceptedOfferSha256:sha256Hex(canonicalize(offer))};
  return {userId,offer,approval,service,input,calls,wrongPrice:()=>{wrongPrice=true;},complete:()=>{session.status='complete';session.payment_status='paid';},sub:()=>sub,session:()=>session};
}
describe('optional paid enrollment and capture limits',()=>{
  it('keeps unconfigured billing hidden and free web capture usable',async()=>{
    const userId=await createUser(h),id=await proof(userId);
    expect((await request(h.app).get('/me/billing/status').set(auth(userId))).body).toMatchObject({enabled:false,subscriptions:[]});
    expect((await request(h.app).get('/me/billing/offer').set(auth(userId))).body).toEqual({enabled:false,offer:null});
    const s=await request(h.app).post(`/proofs/${id}/capture-sessions`).set(auth(userId)).send({client:'WEB_CAMERA',idempotencyKey:'free-test'});
    expect(s.status).toBe(201);expect(s.body.maxRecordingBytes).toBe(250000000);expect(s.body.maxRecordingSeconds).toBe(300);
    expect((await h.db.query('SELECT 1 FROM billing_capture_reservations WHERE proof_id=$1',[id])).rows).toHaveLength(0);
  });
  it('refuses changed consent and mismatched provider pricing before creating checkout',async()=>{
    const f=await setup();await expect(f.service.start(h.db,f.userId,{...f.input,acceptedOfferSha256:'a'.repeat(64)})).rejects.toMatchObject({code:'BILLING_OFFER_CONSENT_MISMATCH'});
    f.wrongPrice();await expect(f.service.start(h.db,f.userId,f.input)).rejects.toMatchObject({code:'STRIPE_OFFER_PRICE_MISMATCH'});
    expect(f.calls.every(c=>!c.body)).toBe(true);expect((await h.db.query('SELECT 1 FROM billing_checkout_operations WHERE user_id=$1',[f.userId])).rows).toHaveLength(0);
  });
  it('replays hosted checkout without a second session and binds only verified own-account completion',async()=>{
    const f=await setup(),other=await createUser(h),first=await f.service.start(h.db,f.userId,f.input);expect(first.url).toContain('checkout.stripe.com');
    expect(await f.service.start(h.db,f.userId,f.input)).toEqual(first);expect(f.calls.filter(c=>c.body)).toHaveLength(1);
    expect(f.calls.find(c=>c.body)?.body?.get('consent_collection[terms_of_service]')).toBe('required');
    await expect(f.service.complete(h.db,other,f.input)).rejects.toMatchObject({code:'BILLING_CHECKOUT_NOT_FOUND'});
    expect(await f.service.complete(h.db,f.userId,f.input)).toEqual({state:'PENDING',enrolled:false});
    f.complete();expect(await f.service.complete(h.db,f.userId,f.input)).toMatchObject({state:'active',enrolled:true});
    expect(await f.service.complete(h.db,f.userId,f.input)).toMatchObject({enrolled:true});
    expect((await h.db.query('SELECT * FROM billing_account_offer_periods WHERE user_id=$1',[f.userId])).rows).toHaveLength(1);
    expect((await h.db.query('SELECT * FROM billing_customer_bindings WHERE user_id=$1',[f.userId])).rows).toHaveLength(1);
    expect(f.calls.filter(c=>c.body)).toHaveLength(1);
  });
  it('rejects a substituted subscription customer or missing hosted terms without enrollment',async()=>{
    const f=await setup();await f.service.start(h.db,f.userId,f.input);f.complete();f.sub().customer='cus_foreign';
    await expect(f.service.complete(h.db,f.userId,f.input)).rejects.toMatchObject({code:'STRIPE_CUSTOMER_MISMATCH'});
    f.session().consent={terms_of_service:null};await expect(f.service.complete(h.db,f.userId,f.input)).rejects.toMatchObject({code:'BILLING_PROVIDER_CONSENT_REQUIRED'});
    expect((await h.db.query('SELECT 1 FROM billing_customer_bindings WHERE user_id=$1',[f.userId])).rows).toHaveLength(0);
  });
  it('shows provider trial and cancellation lifecycle with an explicitly estimated base renewal amount',async()=>{
    const f=await setup();await f.service.start(h.db,f.userId,f.input);f.complete();await f.service.complete(h.db,f.userId,f.input);
    expect((await f.service.status(h.db,f.userId)).subscriptions[0]).toMatchObject({status:'active',nextCharge:{baseAmountMinor:2900,currency:'USD',estimate:true}});
    f.sub().status='trialing';f.sub().trial_end=Math.floor(now.getTime()/1000)+7*86400;
    expect((await f.service.status(h.db,f.userId)).subscriptions[0]).toMatchObject({status:'trialing',trialEnd:'2026-09-14T12:00:00.000Z',nextCharge:{expectedAt:'2026-09-14T12:00:00.000Z'}});
    f.sub().cancel_at_period_end=true;expect((await f.service.status(h.db,f.userId)).subscriptions[0]).toMatchObject({cancelAtPeriodEnd:true,nextCharge:null});
    expect(f.calls.filter(c=>c.body)).toHaveLength(1);
  });
  it('atomically caps new Proof reservations while allowing retries and enforcing the persisted byte limit',async()=>{
    const f=await setup(),first=await proof(f.userId),second=await proof(f.userId);
    await scheduleApprovedOfferPeriod(h.db,clock,{id:`allowance-period-${sequence}`,userId:f.userId,offerVersion:f.offer.version,start:now.toISOString(),end:'2026-09-08T12:00:00.000Z',consentReceiptReference:'synthetic-consent'},f.approval);
    const attempts=await Promise.allSettled([first,second].map(proofId=>createCaptureSession(h.db,clock,f.userId,proofId,{client:'WEB_CAMERA',idempotencyKey:'one-slot'})));
    expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(a=>a.status==='rejected')).toHaveLength(1);
    const accepted=attempts.find(a=>a.status==='fulfilled');if(accepted?.status!=='fulfilled')throw new Error('missing accepted capture');const s=accepted.value;
    expect(s).toMatchObject({maxRecordingBytes:10000,maxRecordingSeconds:30});
    expect(await createCaptureSession(h.db,clock,f.userId,s.proofId,{client:'WEB_CAMERA',idempotencyKey:'one-slot'})).toMatchObject({id:s.id});
    await expect(completeCaptureSession(h.db,clock,f.userId,s.proofId,s.id,{sha256:'a'.repeat(64),byteSize:10001,contentType:'video/mp4'})).rejects.toMatchObject({code:'CAPTURE_RECORDING_LIMIT'});
    await expect(h.db.query('UPDATE capture_sessions SET max_duration_ms=300000 WHERE id=$1',[s.id])).rejects.toThrow('CAPTURE_RECORDING_LIMIT_IMMUTABLE');
    const later={now:()=>new Date('2026-09-09T12:00:00.000Z')};
    expect(await createCaptureSession(h.db,later,f.userId,s.proofId,{client:'WEB_CAMERA',idempotencyKey:'recovery-retake'})).toMatchObject({maxRecordingBytes:10000});
    const unused=s.proofId===first?second:first;
    await expect(createCaptureSession(h.db,later,f.userId,unused,{client:'WEB_CAMERA',idempotencyKey:'expired-new'})).rejects.toMatchObject({code:'BILLING_OFFER_RENEWAL_REQUIRED'});
  });
});
