import type {Clock} from '../clock.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {sha256Hex} from '../hash.js';
import {bindBillingCustomer,scheduleApprovedOfferPeriod,validateOfferDefinition,type OfferDefinition} from './usage-ledger.js';
import {requireOfferPublication,type ApprovedOfferOptions} from './publication-receipt.js';

export interface StripeCheckoutConfig {offerVersion:string;priceReference:string;successUrl:string;cancelUrl:string;}
export interface BillingOfferResponse {enabled:boolean;environment?:'sandbox'|'live';offer:(OfferDefinition&{sha256:string})|null;}
export interface BillingSubscriptionStatus {
  subscriptionReference:string;status:string;currentPeriodEnd:string|null;trialEnd:string|null;cancelAtPeriodEnd:boolean;
  cancelAt:string|null;canceledAt:string|null;endedAt:string|null;
  nextCharge:{expectedAt:string|null;baseAmountMinor:number|null;currency:string|null;estimate:boolean}|null;
}
export interface BillingStatusResponse {enabled:boolean;environment?:'sandbox'|'live';subscriptions:BillingSubscriptionStatus[];pendingCheckout:string|null;}
export type StripeApi=(route:string,body?:URLSearchParams,idempotencyKey?:string)=>Promise<Record<string,unknown>>;
type Operation={id:string;user_id:string;offer_version:string;offer_sha256:string;operation_key:string;consent_at:string|Date;session_reference:string|null;checkout_url:string|null;expires_at:string|Date|null;subscription_reference:string|null;state:string};
function fail(code:string,message:string,status=409):never{throw new DomainError(code,message,status);}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('STRIPE_INVALID_RESPONSE','Invalid subscription data',502);return value as Record<string,unknown>;}
function reference(value:unknown,prefix:string):string{const v=value&&typeof value==='object'?record(value).id:value;if(typeof v!=='string'||!new RegExp(`^${prefix}_[A-Za-z0-9_]{1,180}$`).test(v))fail('STRIPE_INVALID_REFERENCE','Invalid subscription reference',422);return v;}
function timestamp(value:unknown,nullable=false):string|null{if(value==null&&nullable)return null;if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>253402300799)fail('STRIPE_INVALID_TIME','Invalid subscription timestamp',502);return new Date(Number(value)*1000).toISOString();}
function operationKey(value:unknown):string{if(typeof value!=='string'||!/^[-A-Za-z0-9:_]{8,160}$/.test(value))fail('INVALID_BILLING_OPERATION','A stable checkout operation ID is required',422);return value;}
export function validateCheckoutConfig(config:StripeCheckoutConfig){
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(config.offerVersion))fail('STRIPE_CHECKOUT_CONFIGURATION_REQUIRED','A published offer version is required',503);
  reference(config.priceReference,'price');
  for(const value of [config.successUrl,config.cancelUrl]){let url:URL;try{url=new URL(value);}catch{fail('STRIPE_CHECKOUT_CONFIGURATION_REQUIRED','Fixed checkout return URLs are required',503);}if(url!.protocol!=='https:'||url!.username||url!.password||url!.hash)fail('STRIPE_CHECKOUT_CONFIGURATION_REQUIRED','Fixed HTTPS checkout return URLs are required',503);}
}

/** All provider calls are authenticated by the adapter. The caller supplies only an
 * operation ID and exact accepted offer hash; provider/customer/price/URLs are server-owned. */
export class StripeEnrollment {
  constructor(private readonly account:string,private readonly environment:'sandbox'|'live',private readonly clock:Clock,private readonly checkout:StripeCheckoutConfig|undefined,private readonly api:StripeApi,private readonly approval?:ApprovedOfferOptions){}
  private mode(row:Record<string,unknown>){if(row.livemode!==(this.environment==='live'))fail('STRIPE_ENVIRONMENT_MISMATCH','Billing data belongs to another environment');}
  private async offer(db:Database,version=this.checkout?.offerVersion){
    if(!version)fail('STRIPE_CHECKOUT_DISABLED','Paid enrollment is not configured',503);
    const row=(await db.query<{definition_json:OfferDefinition;sha256:string}>('SELECT definition_json,sha256 FROM billing_offer_versions WHERE version=$1',[version])).rows[0];
    if(!row||row.definition_json.status!=='approved')fail('BILLING_OFFER_NOT_APPROVED','This offer is not available for enrollment');
    const offer=validateOfferDefinition(row.definition_json);await requireOfferPublication(offer,this.clock,this.approval);
    if(offer.interval!=='monthly')fail('BILLING_OFFER_UNSUPPORTED','Checkout currently supports approved monthly offers only');
    return {...row,definition_json:offer};
  }
  async availableOffer(db:Database):Promise<BillingOfferResponse>{
    if(!this.checkout)return {enabled:false,offer:null};
    const o=await this.offer(db);return {enabled:true,environment:this.environment,offer:{...o.definition_json,sha256:o.sha256}};
  }
  private async price(offer:OfferDefinition){
    if(!this.checkout)fail('STRIPE_CHECKOUT_DISABLED','Paid enrollment is not configured',503);
    const p=await this.api(`/v1/prices/${this.checkout.priceReference}`);this.mode(p);const recurring=record(p.recurring);
    if(p.object!=='price'||p.id!==this.checkout.priceReference||p.active!==true||p.currency!=='usd'||p.unit_amount!==offer.priceMinor||p.type!=='recurring'||recurring.interval!=='month'||recurring.interval_count!==1||recurring.usage_type!=='licensed')
      fail('STRIPE_OFFER_PRICE_MISMATCH','The provider price does not match the accepted offer');
    return p;
  }
  private async ownOperation(db:Database,userId:string,key:string){
    const row=(await db.query<Operation>('SELECT * FROM billing_checkout_operations WHERE user_id=$1 AND provider_account=$2 AND environment=$3 AND operation_key=$4',[userId,this.account,this.environment,operationKey(key)])).rows[0];
    if(!row)fail('BILLING_CHECKOUT_NOT_FOUND','Checkout was not started by this account',404);return row;
  }
  async start(db:Database,userId:string,input:{operationId:string;offerVersion:string;acceptedOfferSha256:string}){
    operationKey(input.operationId);const o=await this.offer(db);
    if(input.offerVersion!==o.definition_json.version||input.acceptedOfferSha256!==o.sha256)fail('BILLING_OFFER_CONSENT_MISMATCH','Review and accept the current published offer before checkout');
    await this.price(o.definition_json);
    const operation=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
      const previous=(await tx.query<Operation>('SELECT * FROM billing_checkout_operations WHERE user_id=$1 AND provider_account=$2 AND environment=$3 AND operation_key=$4',[userId,this.account,this.environment,input.operationId])).rows[0];
      if(previous){if(previous.offer_sha256!==o.sha256||previous.offer_version!==input.offerVersion)fail('BILLING_CHECKOUT_CONFLICT','This checkout operation records different accepted terms');return previous;}
      if((await tx.query("SELECT 1 FROM billing_checkout_operations WHERE user_id=$1 AND provider_account=$2 AND environment=$3 AND state IN ('PENDING','OPEN')",[userId,this.account,this.environment])).rows.length)
        fail('BILLING_CHECKOUT_IN_PROGRESS','Finish or expire the existing checkout before starting another');
      if((await tx.query('SELECT 1 FROM billing_account_offer_periods WHERE user_id=$1 AND period_end>$2',[userId,this.clock.now().toISOString()])).rows.length)
        fail('BILLING_OFFER_ALREADY_ENROLLED','An accepted plan already covers this account');
      const bound=(await tx.query<{customer_reference:string}>("SELECT customer_reference FROM billing_customer_bindings WHERE provider='stripe' AND provider_account=$1 AND environment=$2 AND user_id=$3",[this.account,this.environment,userId])).rows;
      if(bound.length>1)fail('BILLING_CUSTOMER_AMBIGUOUS','This account needs billing customer reconciliation');
      if(bound[0]){
        const subscriptions=await this.api(`/v1/subscriptions?${new URLSearchParams({customer:bound[0].customer_reference,status:'all',limit:'100'})}`);
        if(subscriptions.object!=='list'||!Array.isArray(subscriptions.data)||subscriptions.has_more!==false)fail('STRIPE_INVALID_RESPONSE','Existing subscriptions require complete account coverage',502);
        for(const value of subscriptions.data){const sub=record(value);this.mode(sub);if(reference(sub.customer,'cus')!==bound[0].customer_reference)fail('STRIPE_CUSTOMER_MISMATCH','Subscription belongs to another customer');
          if(!['canceled','incomplete_expired'].includes(String(sub.status)))fail('BILLING_OFFER_ALREADY_ENROLLED','Resolve the existing subscription before starting another');}
      }
      const id=`checkout:${sha256Hex([this.account,this.environment,userId,input.operationId].join('\n'))}`;
      return (await tx.query<Operation>(`INSERT INTO billing_checkout_operations(id,user_id,provider_account,environment,offer_version,offer_sha256,operation_key,consent_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING') RETURNING *`,[id,userId,this.account,this.environment,input.offerVersion,o.sha256,input.operationId,this.clock.now().toISOString()])).rows[0];
    });
    if(operation.state==='COMPLETE')return {state:'COMPLETE',operationId:input.operationId,url:null,chargesCreated:false};
    if(operation.state==='EXPIRED')fail('BILLING_CHECKOUT_EXPIRED','This checkout expired. Start a new checkout');
    if(operation.session_reference)return {state:'OPEN',operationId:input.operationId,url:operation.checkout_url,chargesCreated:false};
    // Stripe retains idempotency keys for at least 24 hours. Never retry an uncertain
    // creation outside that window, where it could create a second session.
    if(this.clock.now().getTime()-new Date(operation.consent_at).getTime()>23*3600000)
      fail('BILLING_CHECKOUT_RECONCILIATION_REQUIRED','An uncertain checkout requires provider reconciliation before retry');
    const config=this.checkout!;
    const body=new URLSearchParams({mode:'subscription','line_items[0][price]':config.priceReference,'line_items[0][quantity]':'1',success_url:config.successUrl,cancel_url:config.cancelUrl,client_reference_id:operation.id,'metadata[packproof_checkout]':operation.id,'subscription_data[metadata][packproof_checkout]':operation.id,'consent_collection[terms_of_service]':'required'});
    const customers=(await db.query<{customer_reference:string}>("SELECT customer_reference FROM billing_customer_bindings WHERE provider='stripe' AND provider_account=$1 AND environment=$2 AND user_id=$3",[this.account,this.environment,userId])).rows;
    if(customers.length>1)fail('BILLING_CUSTOMER_AMBIGUOUS','This account needs billing customer reconciliation');
    if(customers[0])body.set('customer',customers[0].customer_reference);
    const session=await this.api('/v1/checkout/sessions',body,`packproof-${sha256Hex(operation.id)}`);this.mode(session);
    if(session.object!=='checkout.session'||session.mode!=='subscription'||session.client_reference_id!==operation.id||session.status!=='open'||typeof session.url!=='string')fail('STRIPE_INVALID_RESPONSE','Invalid hosted checkout session',502);
    const sessionId=reference(session.id,'cs');let url:URL;try{url=new URL(session.url);}catch{fail('STRIPE_INVALID_RESPONSE','Invalid checkout URL',502);}
    if(url!.protocol!=='https:'||url!.hostname!=='checkout.stripe.com'||url!.port||url!.username||url!.password)fail('STRIPE_INVALID_RESPONSE','Invalid checkout destination',502);
    const expires=timestamp(session.expires_at)!;
    await db.query("UPDATE billing_checkout_operations SET session_reference=$2,checkout_url=$3,expires_at=$4,state='OPEN' WHERE id=$1 AND state IN ('PENDING','OPEN')",[operation.id,sessionId,url!.toString(),expires]);
    return {state:'OPEN',operationId:input.operationId,url:url!.toString(),chargesCreated:false};
  }
  private async subscription(referenceId:string,customer:string){
    const s=await this.api(`/v1/subscriptions/${reference(referenceId,'sub')}`);this.mode(s);
    if(s.object!=='subscription'||s.id!==referenceId||reference(s.customer,'cus')!==customer)fail('STRIPE_CUSTOMER_MISMATCH','Subscription does not belong to this billing account',403);
    return s;
  }
  private items(sub:Record<string,unknown>){const items=record(sub.items);if(!Array.isArray(items.data)||items.data.length!==1||items.has_more===true)fail('STRIPE_SUBSCRIPTION_ITEMS_MISMATCH','Subscription must contain exactly the accepted plan');return record(items.data[0]);}
  private async enrollPeriod(db:Database,operation:Operation,customer:string,sub:Record<string,unknown>){
    if(!['active','trialing'].includes(String(sub.status)))return {enrolled:false,state:String(sub.status)};
    const o=await this.offer(db,operation.offer_version),item=this.items(sub),price=record(item.price),recurring=record(price.recurring);
    if(!this.checkout||price.id!==this.checkout.priceReference||price.currency!=='usd'||price.unit_amount!==o.definition_json.priceMinor||item.quantity!==1||recurring.interval!=='month'||recurring.interval_count!==1)
      fail('STRIPE_OFFER_PRICE_MISMATCH','The subscription differs from the accepted offer');
    const providerStart=timestamp(item.current_period_start??sub.current_period_start)!,providerEnd=timestamp(item.current_period_end??sub.current_period_end)!;
    const subscriptionId=reference(sub.id,'sub'),now=this.clock.now().toISOString();
    if(providerStart>now||providerEnd<=now||providerEnd<=providerStart)fail('STRIPE_SUBSCRIPTION_PERIOD_INVALID','The provider subscription has no current period');
    const periodId=`stripe-period:${sha256Hex([this.environment,this.account,subscriptionId,providerStart].join('\n'))}`;
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[operation.user_id]);
      await bindBillingCustomer(tx,this.clock,{provider:'stripe',environment:this.environment,providerAccount:this.account,customerReference:customer,userId:operation.user_id});
      if(!(await tx.query('SELECT 1 FROM billing_account_offer_periods WHERE id=$1',[periodId])).rows.length)
        await scheduleApprovedOfferPeriod(tx,{now:()=>new Date(now)},{id:periodId,userId:operation.user_id,offerVersion:operation.offer_version,start:now,end:providerEnd,consentReceiptReference:operation.id},this.approval);
      await tx.query("UPDATE billing_checkout_operations SET state='COMPLETE',subscription_reference=$2 WHERE id=$1",[operation.id,subscriptionId]);
    });
    return {enrolled:true,state:String(sub.status),periodId};
  }
  async complete(db:Database,userId:string,input:{operationId:string}){
    const operation=await this.ownOperation(db,userId,input.operationId);
    if(!operation.session_reference)fail('BILLING_CHECKOUT_PENDING','Checkout session creation has not been confirmed');
    const session=await this.api(`/v1/checkout/sessions/${reference(operation.session_reference,'cs')}`);this.mode(session);
    if(session.object!=='checkout.session'||session.id!==operation.session_reference||session.mode!=='subscription'||session.client_reference_id!==operation.id||record(session.metadata).packproof_checkout!==operation.id)
      fail('STRIPE_CHECKOUT_BINDING_MISMATCH','Checkout does not match this account and accepted offer');
    if(session.status==='expired'){await db.query("UPDATE billing_checkout_operations SET state='EXPIRED' WHERE id=$1 AND state<>'COMPLETE'",[operation.id]);return {state:'EXPIRED',enrolled:false};}
    if(session.status!=='complete'||!['paid','no_payment_required'].includes(String(session.payment_status)))return {state:'PENDING',enrolled:false};
    if(record(session.consent).terms_of_service!=='accepted')fail('BILLING_PROVIDER_CONSENT_REQUIRED','The hosted checkout has no accepted terms');
    const customer=reference(session.customer,'cus'),sub=await this.subscription(reference(session.subscription,'sub'),customer);
    if(record(sub.metadata).packproof_checkout!==operation.id)fail('STRIPE_CHECKOUT_BINDING_MISMATCH','Subscription does not match the consented checkout');
    return this.enrollPeriod(db,operation,customer,sub);
  }
  async status(db:Database,userId:string):Promise<BillingStatusResponse>{
    const customers=(await db.query<{customer_reference:string}>("SELECT customer_reference FROM billing_customer_bindings WHERE provider='stripe' AND provider_account=$1 AND environment=$2 AND user_id=$3",[this.account,this.environment,userId])).rows;
    if(!customers.length)return {enabled:true,environment:this.environment,subscriptions:[],pendingCheckout:(await db.query<{operation_key:string}>("SELECT operation_key FROM billing_checkout_operations WHERE user_id=$1 AND provider_account=$2 AND environment=$3 AND state IN ('OPEN','PENDING')",[userId,this.account,this.environment])).rows[0]?.operation_key??null};
    if(customers.length>1)fail('BILLING_CUSTOMER_AMBIGUOUS','This account needs billing customer reconciliation');
    const customer=customers[0].customer_reference,page=await this.api(`/v1/subscriptions?${new URLSearchParams({customer,status:'all',limit:'100'})}`);
    if(page.object!=='list'||!Array.isArray(page.data)||page.data.length>100||page.has_more!==false)fail('STRIPE_INVALID_RESPONSE','Subscription listing requires complete account coverage',502);
    const subscriptions=page.data.map(v=>{const s=record(v);this.mode(s);if(s.object!=='subscription'||reference(s.customer,'cus')!==customer)fail('STRIPE_CUSTOMER_MISMATCH','Subscription belongs to another customer');
      const item=this.items(s),price=record(item.price),periodEnd=timestamp(item.current_period_end??s.current_period_end,true),trialEnd=timestamp(s.trial_end,true),cancelAt=timestamp(s.cancel_at,true);
      const renewing=['active','trialing'].includes(String(s.status))&&s.cancel_at_period_end!==true&&!cancelAt;
      const amount=Number.isSafeInteger(price.unit_amount)&&Number.isSafeInteger(item.quantity)&&Number(price.unit_amount)>=0&&Number(item.quantity)>0?Number(price.unit_amount)*Number(item.quantity):null;
      return {subscriptionReference:reference(s.id,'sub'),status:String(s.status),currentPeriodEnd:periodEnd,trialEnd,cancelAtPeriodEnd:s.cancel_at_period_end===true,cancelAt,canceledAt:timestamp(s.canceled_at,true),endedAt:timestamp(s.ended_at,true),nextCharge:renewing?{expectedAt:s.status==='trialing'?trialEnd:periodEnd,baseAmountMinor:Number.isSafeInteger(amount)?amount:null,currency:price.currency==='usd'?'USD':null,estimate:true}:null};
    });
    return {enabled:true,environment:this.environment,subscriptions,pendingCheckout:(await db.query<{operation_key:string}>("SELECT operation_key FROM billing_checkout_operations WHERE user_id=$1 AND provider_account=$2 AND environment=$3 AND state IN ('OPEN','PENDING')",[userId,this.account,this.environment])).rows[0]?.operation_key??null};
  }
  async reconcile(db:Database,limit=25){
    if(!this.checkout)return {enabled:false,inspected:0,completed:0};
    const operations=(await db.query<Operation>("SELECT * FROM billing_checkout_operations WHERE provider_account=$1 AND environment=$2 AND state IN ('OPEN','COMPLETE') ORDER BY last_checked_at,id LIMIT $3",[this.account,this.environment,limit])).rows;
    let completed=0;const errors:Array<{operationId:string;code:string}>=[];
    for(const op of operations)try{const result=await this.complete(db,op.user_id,{operationId:op.operation_key});if(result.enrolled)completed++;}catch(error){errors.push({operationId:op.id,code:error instanceof DomainError?error.code:'BILLING_ENROLLMENT_RECONCILIATION_FAILED'});}finally{await db.query('UPDATE billing_checkout_operations SET last_checked_at=$2 WHERE id=$1',[op.id,this.clock.now().toISOString()]);}
    return {enabled:true,inspected:operations.length,completed,errors};
  }
}
