import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../hash.js';
import type { IntegrationCredentialStore } from '../integrations/credentials.js';
import type { BillingProviderVerifier, VerifiedProviderEvent } from './usage-ledger.js';

export interface StripeBillingConfig {
  account: string; environment: 'sandbox' | 'live'; apiVersion: string;
  accountMode: 'direct' | 'connected'; credentialReference: string;
  portalCancellation?: { configuration: string; returnUrl: string };
}
const MAX_BYTES=1024*1024;
function fail(code:string,message:string,status=400):never{throw new DomainError(code,message,status);}
function obj(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('STRIPE_INVALID_RESPONSE','Unsupported billing provider record',502);return value as Record<string,unknown>;}
function ref(value:unknown,prefix:string):string{if(typeof value!=='string'||!new RegExp(`^${prefix}_[A-Za-z0-9]{1,180}$`).test(value))fail('STRIPE_INVALID_REFERENCE','Invalid billing provider reference');return value;}
const related=(value:unknown,prefix:string)=>ref(value&&typeof value==='object'?obj(value).id:value,prefix);
function money(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)fail('STRIPE_INVALID_AMOUNT','Billing amount must be a nonnegative safe integer');return value as number;}
function epoch(value:unknown,clock:Clock):string{if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)*1000>clock.now().getTime())fail('STRIPE_INVALID_TIME','Invalid billing provider time');return new Date(Number(value)*1000).toISOString();}
function https(value:unknown):URL{let url:URL;try{url=new URL(String(value));}catch{fail('STRIPE_INVALID_URL','Invalid billing URL');}if(url!.protocol!=='https:'||url!.username||url!.password||url!.hash)fail('STRIPE_INVALID_URL','A fixed HTTPS billing URL is required');return url!;}
function validateConfig(c:StripeBillingConfig){
  ref(c.account,'acct');
  if(!['sandbox','live'].includes(c.environment)||!['direct','connected'].includes(c.accountMode)||!/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9_-]*)?$/.test(c.apiVersion))fail('STRIPE_CONFIGURATION_REQUIRED','Explicit billing account mode, environment and API version are required',503);
  if(!/^(?:arn:aws:secretsmanager:[^\s]+|sm:[^\s]+|packproof\/[^\s]+)$/.test(c.credentialReference))fail('STRIPE_MANAGED_SECRET_REQUIRED','Billing requires a managed credential reference',503);
  if(c.portalCancellation){ref(c.portalCancellation.configuration,'bpc');https(c.portalCancellation.returnUrl);}
}
/** Absent provider means disabled. Partial selected-provider configuration fails closed. */
export function stripeBillingConfigFromEnv(env:NodeJS.ProcessEnv):StripeBillingConfig|null{
  if(!env.PACKPROOF_BILLING_PROVIDER)return null;
  if(env.PACKPROOF_BILLING_PROVIDER!=='stripe')fail('BILLING_PROVIDER_UNSUPPORTED','Configured billing provider is unsupported',503);
  const c:StripeBillingConfig={account:env.PACKPROOF_STRIPE_ACCOUNT??'',environment:env.PACKPROOF_STRIPE_ENVIRONMENT as StripeBillingConfig['environment'],apiVersion:env.PACKPROOF_STRIPE_API_VERSION??'',accountMode:env.PACKPROOF_STRIPE_ACCOUNT_MODE as StripeBillingConfig['accountMode'],credentialReference:env.PACKPROOF_STRIPE_CREDENTIAL_REFERENCE??''};
  if(env.PACKPROOF_STRIPE_CANCELLATION_PORTAL_ENABLED==='true')c.portalCancellation={configuration:env.PACKPROOF_STRIPE_PORTAL_CONFIGURATION??'',returnUrl:env.PACKPROOF_STRIPE_PORTAL_RETURN_URL??''};
  validateConfig(c);return c;
}
/** Documented Stripe v1 HMAC over original bytes, constant-time comparison and
 * five-minute delivery freshness. A delivery timestamp is never payment time. */
export function verifyStripeSignature(rawBody:Buffer,header:string|null,secret:string,clock:Clock){
  if(!Buffer.isBuffer(rawBody)||!rawBody.length||rawBody.length>MAX_BYTES)fail('STRIPE_INVALID_BODY','Bounded unmodified billing body required',413);
  if(!/^whsec_[A-Za-z0-9_]{16,}$/.test(secret))fail('STRIPE_MANAGED_SECRET_REQUIRED','Managed webhook secret is unavailable',503);
  if(!header||header.length>4096)fail('STRIPE_SIGNATURE_INVALID','Invalid billing signature',401);
  const fields=header.split(',').map(p=>p.trim().split('='));const times=fields.filter(([k])=>k==='t').map(([,v])=>v),signatures=fields.filter(([k])=>k==='v1').map(([,v])=>v);
  if(times.length!==1||!/^\d{1,12}$/.test(times[0]??'')||!signatures.length||signatures.length>16||signatures.some(v=>!/^[a-f0-9]{64}$/.test(v??'')))fail('STRIPE_SIGNATURE_INVALID','Invalid billing signature',401);
  if(Math.abs(Math.floor(clock.now().getTime()/1000)-Number(times[0]))>300)fail('STRIPE_SIGNATURE_EXPIRED','Billing signature is outside its freshness window',401);
  const expected=createHmac('sha256',secret).update(`${times[0]}.`).update(rawBody).digest();let matches=false;
  for(const candidate of signatures)matches=timingSafeEqual(expected,Buffer.from(candidate!,'hex'))||matches;
  if(!matches)fail('STRIPE_SIGNATURE_INVALID','Invalid billing signature',401);
}

/** Optional provider implementation. No constructor/network call activates an
 * offer, creates a charge or changes historical evidence access. */
export class StripeBillingAdapter implements BillingProviderVerifier{
  readonly provider='stripe';readonly environment:'sandbox'|'live';readonly providerAccount:string;private readonly config:StripeBillingConfig;
  constructor(config:StripeBillingConfig,private readonly credentials:IntegrationCredentialStore,private readonly clock:Clock,private readonly fetcher:typeof fetch=fetch){validateConfig(config);this.config={...config,portalCancellation:config.portalCancellation?{...config.portalCancellation}:undefined};this.environment=config.environment;this.providerAccount=config.account;}
  private async secrets(){const value=await this.credentials.getCredentials({adapterKey:'stripe-billing',credentialReference:this.config.credentialReference});const apiKey=value?.material.apiKey,webhookSecret=value?.material.webhookSecret;
    if(!apiKey||!new RegExp(`^(?:sk|rk)_${this.environment==='live'?'live':'test'}_[A-Za-z0-9]{16,}$`).test(apiKey)||!webhookSecret)fail('STRIPE_MANAGED_SECRET_REQUIRED','Billing credentials are unavailable or use another environment',503);return{apiKey:apiKey!,webhookSecret:webhookSecret!};}
  private async api(route:string,apiKey:string,body?:URLSearchParams,idempotencyKey?:string):Promise<Record<string,unknown>>{
    if(!/^\/v1\/[a-z_]+(?:\/[A-Za-z0-9_]+)?(?:\?[^\s]*)?$/.test(route))fail('STRIPE_INVALID_ROUTE','Unsupported billing route');
    const headers:Record<string,string>={Authorization:`Bearer ${apiKey}`,'Stripe-Version':this.config.apiVersion};if(this.config.accountMode==='connected')headers['Stripe-Account']=this.config.account;if(body)headers['Content-Type']='application/x-www-form-urlencoded';if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{const response=await this.fetcher(`https://api.stripe.com${route}`,{method:body?'POST':'GET',body,headers,signal:controller.signal,redirect:'error'});
      if(!response.ok){await response.body?.cancel();fail('STRIPE_PROVIDER_UNAVAILABLE','Billing provider request failed',502);}
      if(Number(response.headers.get('content-length')??0)>MAX_BYTES){await response.body?.cancel();fail('STRIPE_RESPONSE_TOO_LARGE','Billing response exceeded its budget',502);}
      if(!response.body)fail('STRIPE_INVALID_RESPONSE','Empty billing response',502);const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let length=0;
      for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>MAX_BYTES){await reader.cancel();fail('STRIPE_RESPONSE_TOO_LARGE','Billing response exceeded its budget',502);}chunks.push(part.value);}
      return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch(error){if(error instanceof DomainError)throw error;fail('STRIPE_PROVIDER_UNAVAILABLE','Billing provider request failed',502);}finally{clearTimeout(timeout);}
  }
  private async assertAccount(apiKey:string){const a=await this.api('/v1/account',apiKey);if(a.id!==this.providerAccount||a.object!=='account')fail('STRIPE_ACCOUNT_MISMATCH','Billing credentials belong to another provider account',409);}
  private mode(row:Record<string,unknown>){if(row.livemode!==(this.environment==='live'))fail('STRIPE_ENVIRONMENT_MISMATCH','Billing record belongs to another environment',409);}
  async verifyAndNormalize(input:{rawBody:Buffer;signature:string|null}):Promise<VerifiedProviderEvent>{
    const secrets=await this.secrets();verifyStripeSignature(input.rawBody,input.signature,secrets.webhookSecret,this.clock);
    let e:Record<string,unknown>;try{e=obj(JSON.parse(input.rawBody.toString('utf8')));}catch{fail('STRIPE_INVALID_BODY','Billing event is not valid JSON');}
    return this.normalizeAuthenticatedEvent(e!,secrets.apiKey);
  }
  private async normalizeAuthenticatedEvent(e:Record<string,unknown>,apiKey:string):Promise<VerifiedProviderEvent>{
    this.mode(e);ref(e.id,'evt');epoch(e.created,this.clock);
    if(e!.object!=='event'||e!.api_version!==this.config.apiVersion||e!.context!=null||(this.config.accountMode==='connected'?e!.account!==this.providerAccount:e!.account!=null))fail('STRIPE_EVENT_CONTEXT_MISMATCH','Billing endpoint account or API version mismatch',409);
    if(!['payment_intent.succeeded','refund.created','refund.updated','refund.failed'].includes(String(e!.type)))fail('STRIPE_EVENT_NOT_SUPPORTED','Billing event type is not configured for accounting',422);
    const source=obj(obj(e!.data).object),refund=String(e!.type).startsWith('refund.'),reversed=refund&&['failed','canceled'].includes(String(source.status));
    if(source.object!==(refund?'refund':'payment_intent')||(!reversed&&source.status!=='succeeded'))fail('STRIPE_EVENT_NOT_SETTLED','Only succeeded records or verified failed-refund reversals enter accounting',422);
    if(source.currency!=='usd')fail('STRIPE_CURRENCY_UNSUPPORTED','Offer ledger accepts USD only',422);
    await this.assertAccount(apiKey);const subjectId=ref(source.id,refund?'re':'pi'),current=await this.api(`/v1/${refund?'refunds':'payment_intents'}/${subjectId}`,apiKey);
    if(current.id!==subjectId||current.object!==source.object||(reversed?current.status!==source.status:!['succeeded',...(refund?['failed','canceled']:[])].includes(String(current.status)))||current.currency!=='usd')fail('STRIPE_PAYMENT_MISMATCH','Billing record differs from succeeded event',409);
    const amount=money(refund?current.amount:current.amount_received);if(amount!==money(refund?source.amount:source.amount_received))fail('STRIPE_PAYMENT_MISMATCH','Billing event amount differs from financial record',409);
    const paymentId=refund?related(current.payment_intent,'pi'):subjectId,payment=refund?await this.api(`/v1/payment_intents/${paymentId}`,apiKey):current;this.mode(payment);
    if(payment.id!==paymentId||payment.object!=='payment_intent'||payment.status!=='succeeded'||payment.currency!=='usd')fail('STRIPE_PAYMENT_MISMATCH','Refund must resolve to a succeeded payment',409);
    const customer=related(payment.customer,'cus');if(!refund&&related(source.customer,'cus')!==customer)fail('STRIPE_CUSTOMER_MISMATCH','Billing event customer differs from financial record',409);
    if(refund&&related(source.payment_intent,'pi')!==paymentId)fail('STRIPE_PAYMENT_MISMATCH','Refund event differs from payment association',409);
    const chargeId=related(refund?current.charge:current.latest_charge,'ch'),charge=await this.api(`/v1/charges/${chargeId}`,apiKey);this.mode(charge);
    if(charge.id!==chargeId||charge.object!=='charge'||charge.status!=='succeeded'||charge.paid!==true||related(charge.payment_intent,'pi')!==paymentId||related(charge.customer,'cus')!==customer||charge.currency!=='usd')fail('STRIPE_PAYMENT_MISMATCH','Invalid billing charge association',409);
    const balanceId=related(reversed?current.failure_balance_transaction:refund?current.balance_transaction:charge.balance_transaction,'txn'),balance=await this.api(`/v1/balance_transactions/${balanceId}`,apiKey);
    if(balance.id!==balanceId||balance.object!=='balance_transaction'||balance.currency!=='usd'||related(balance.source,refund?'re':'ch')!==(refund?subjectId:chargeId)||balance.amount!==(refund&&!reversed?-amount:amount))fail('STRIPE_BALANCE_MISMATCH','Balance transaction differs from financial record',409);
    // Immutable financial booking time, not delivery, invoice period or bank payout.
    return{eventReference:String(e!.id),customerReference:customer,subjectReference:subjectId,paymentReference:paymentId,kind:reversed?'refund_reversed':refund?'refund_settled':'payment_settled',occurredAt:epoch(balance.created,this.clock),amountMinor:amount,currency:'USD'};
  }
  /** Server-authenticated reconciliation ingress; never accepts user event bodies. */
  async readVerifiedAccountingEvent(eventReference:string):Promise<VerifiedProviderEvent>{
    ref(eventReference,'evt');const secrets=await this.secrets();await this.assertAccount(secrets.apiKey);
    const event=await this.api(`/v1/events/${eventReference}`,secrets.apiKey);
    if(event.id!==eventReference)fail('STRIPE_EVENT_CONTEXT_MISMATCH','Retrieved event identity does not match',409);
    return this.normalizeAuthenticatedEvent(event,secrets.apiKey);
  }
  async listAccountingEventReferences(input:{start:string;end:string;startingAfter?:string}){
    const from=Date.parse(input.start),to=Date.parse(input.end),now=this.clock.now().getTime();
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||to>now||from<now-30*86400000)fail('STRIPE_EVENT_HISTORY_GAP','Provider event window is outside the available 30-day history',409);
    const secrets=await this.secrets();await this.assertAccount(secrets.apiKey);
    const query=new URLSearchParams({limit:'100','created[gte]':String(Math.floor(from/1000)),'created[lt]':String(Math.floor(to/1000))});
    for(const type of ['payment_intent.succeeded','refund.created','refund.updated','refund.failed'])query.append('types[]',type);
    if(input.startingAfter)query.set('starting_after',ref(input.startingAfter,'evt'));
    const page=await this.api(`/v1/events?${query}`,secrets.apiKey);
    if(page.object!=='list'||!Array.isArray(page.data)||page.data.length>100||typeof page.has_more!=='boolean'||page.has_more&&!page.data.length)fail('STRIPE_INVALID_RESPONSE','Invalid accounting event page',502);
    const events=(page.data as unknown[]).map(value=>{const event=obj(value);this.mode(event);const at=epoch(event.created,this.clock);
      if(event.object!=='event'||event.api_version!==this.config.apiVersion||event.context!=null||(this.config.accountMode==='connected'?event.account!==this.providerAccount:event.account!=null)||at<input.start||at>=input.end)fail('STRIPE_EVENT_CONTEXT_MISMATCH','Accounting scan event has another context or period',409);
      return{eventReference:ref(event.id,'evt'),createdAt:at};});
    const cursor=page.has_more?events.at(-1)!.eventReference:null;
    if(cursor&&cursor===input.startingAfter)fail('STRIPE_EVENT_CURSOR_STALLED','Accounting event cursor did not advance',409);
    return{events,hasMore:page.has_more,nextStartingAfter:cursor};
  }
  private async ownCustomer(db:Database,userId:string,requested?:string){const rows=(await db.query<{customer_reference:string}>("SELECT customer_reference FROM billing_customer_bindings WHERE provider='stripe' AND environment=$1 AND provider_account=$2 AND user_id=$3 ORDER BY customer_reference",[this.environment,this.providerAccount,userId])).rows;if(requested)ref(requested,'cus');const found=requested?rows.find(r=>r.customer_reference===requested):rows.length===1?rows[0]:null;if(!found)fail('BILLING_CUSTOMER_NOT_BOUND','Choose a billing account linked to the signed-in user',404);return found!.customer_reference;}
  async listOwnInvoices(db:Database,userId:string,input:{customerReference?:string;startingAfter?:string}={}){
    const customer=await this.ownCustomer(db,userId,input.customerReference),secrets=await this.secrets();await this.assertAccount(secrets.apiKey);const query=new URLSearchParams({customer,limit:'100'});if(input.startingAfter)query.set('starting_after',ref(input.startingAfter,'in'));
    const result=await this.api(`/v1/invoices?${query}`,secrets.apiKey);if(result.object!=='list'||!Array.isArray(result.data)||result.data.length>100||typeof result.has_more!=='boolean')fail('STRIPE_INVALID_RESPONSE','Invalid billing invoice page',502);
    const invoices=(result.data as unknown[]).map(value=>{const row=obj(value);this.mode(row);if(related(row.customer,'cus')!==customer||row.object!=='invoice'||row.currency!=='usd')fail('STRIPE_CUSTOMER_MISMATCH','Invoice belongs to another customer or currency',502);return{invoiceReference:ref(row.id,'in'),status:['draft','open','paid','uncollectible','void'].includes(String(row.status))?String(row.status):'unknown',currency:'USD',amountDueMinor:money(row.amount_due),amountPaidMinor:money(row.amount_paid),createdAt:epoch(row.created,this.clock)};});
    return{provider:this.provider,environment:this.environment,customerReference:customer,invoices,hasMore:result.has_more,nextStartingAfter:result.has_more?invoices.at(-1)?.invoiceReference??null:null,chargesCreated:false};
  }
  /** Explicit user action: hosted cancellation review only. No direct cancellation,
   * invoice creation, charge or modification of historical Proof rights. */
  async createOwnCancellationPortal(db:Database,userId:string,input:{customerReference?:string;subscriptionReference:string;operationId:string}){
    const portal=this.config.portalCancellation;if(!portal)fail('STRIPE_PORTAL_DISABLED','Cancellation portal is not configured',503);if(!/^[A-Za-z0-9:_-]{8,160}$/.test(input.operationId))fail('INVALID_BILLING_OPERATION','Stable cancellation operation ID required');
    const customer=await this.ownCustomer(db,userId,input.customerReference),subscriptionId=ref(input.subscriptionReference,'sub'),secrets=await this.secrets();await this.assertAccount(secrets.apiKey);
    const sub=await this.api(`/v1/subscriptions/${subscriptionId}`,secrets.apiKey);this.mode(sub);if(sub.id!==subscriptionId||sub.object!=='subscription'||related(sub.customer,'cus')!==customer)fail('STRIPE_CUSTOMER_MISMATCH','Subscription is not linked to this customer',403);
    const body=new URLSearchParams({customer,configuration:portal!.configuration,return_url:portal!.returnUrl,'flow_data[type]':'subscription_cancel','flow_data[subscription_cancel][subscription]':subscriptionId,'flow_data[after_completion][type]':'redirect','flow_data[after_completion][redirect][return_url]':portal!.returnUrl});
    const key=`packproof-cancel-${sha256Hex([this.environment,this.providerAccount,customer,subscriptionId,input.operationId].join('\n'))}`;
    const result=await this.api('/v1/billing_portal/sessions',secrets.apiKey,body,key);
    if(result.object!=='billing_portal.session'||related(result.customer,'cus')!==customer||typeof result.url!=='string')fail('STRIPE_INVALID_RESPONSE','Invalid billing portal session',502);
    const url=https(result.url);if(url.hostname!=='billing.stripe.com'||url.port)fail('STRIPE_INVALID_RESPONSE','Invalid billing portal host',502);
    return{url:url.toString(),subscriptionReference:subscriptionId,cancellationCompleted:false,chargesCreated:false};
  }
}
