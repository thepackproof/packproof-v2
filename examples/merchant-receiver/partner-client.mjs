/** Reference server adapter. Never import this into browser/native bundles. */
export class PartnerClient {
  constructor({apiOrigin,siteOrigin,credential,merchantId,delegationId,environment='sandbox',fetch:transport=globalThis.fetch}) {
    this.api=new URL(apiOrigin);this.site=new URL(siteOrigin);
    if([this.api,this.site].some(u=>u.protocol!=='https:'||u.username||u.password||u.search||u.hash))throw new Error('Configure HTTPS origins without credentials or tokens');
    if(!['sandbox','live'].includes(environment)||typeof credential!=='string'||!credential.startsWith(`pp_org_${environment}_`))throw new Error('Credential environment does not match');
    if(!merchantId)throw new Error('Explicit merchant context is required');
    this.headers={Authorization:`Bearer ${credential}`,'PackProof-Merchant-Id':merchantId,...(delegationId?{'PackProof-Delegation-Id':delegationId}:{})};
    this.transport=transport;
  }
  async request(method,route,{key,body,stream=false}={}) {
    if(method!=='GET'&&(!key||typeof key!=='string'))throw new Error('Persist a stable idempotency key before sending');
    let response;
    try {
      response=await this.transport(new URL(`/v1/partner${route}`,this.api),{method,headers:{...this.headers,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
    } catch {
      const error=new Error('Request outcome is unknown; reconcile or retry with the same operation key');error.unknownOutcome=method!=='GET';throw error;
    }
    if(!response.ok) {
      const payload=await response.json().catch(()=>({}));
      const error=new Error(payload.detail??'Partner request failed');error.status=response.status;error.code=payload.code??payload.error?.code;error.retryAfter=response.headers.get('Retry-After');throw error;
    }
    return stream?response:response.json();
  }
  importOrder(order,key){return this.request('POST','/proofs',{key,body:order});}
  resolveOrder(integrationAccountId,externalId){return this.request('GET',`/proofs/resolve?${new URLSearchParams({integrationAccountId,externalId})}`);}
  proof(proofId){return this.request('GET',`/proofs/${encodeURIComponent(proofId)}`);}
  async capture(proofId,key){
    const intent=await this.request('POST',`/proofs/${encodeURIComponent(proofId)}/capture-intents`,{key,body:{allowedSurfaces:['WEB','ANDROID']}});
    if(intent.proofId!==proofId||intent.requiresAuthenticatedAttestation!==true||!/^intent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(intent.launchToken??''))throw new Error('Unexpected capture context');
    return {intentId:intent.intentId,expiresAt:intent.expiresAt,launchUrl:`${this.site.origin}/capture#intent=${encodeURIComponent(intent.launchToken)}`};
  }
  events(after){return this.request('GET',`/event-stream${after?`?${new URLSearchParams({after})}`:''}`);}
  package(proofId){return this.request('GET',`/proofs/${encodeURIComponent(proofId)}/package`,{stream:true});}
}
