import {createHash,createVerify,constants} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
/** Server-only host SDK. API keys never enter a browser, QR, callback URL, or mobile app. */
export class CaptureHostClient {
  constructor({apiBaseUrl,siteOrigin,apiKey,fetch:transport=globalThis.fetch}){
    this.apiBaseUrl=new URL(apiBaseUrl);this.siteOrigin=new URL(siteOrigin).origin;this.apiKey=apiKey;this.transport=transport;
    if(this.apiBaseUrl.protocol!=='https:'||new URL(this.siteOrigin).protocol!=='https:')throw new Error('Capture hosts require HTTPS');
  }
  async createIntent(proofId,{idempotencyKey,allowedSurfaces=['ANDROID','WEB']}={}){
    if(!idempotencyKey)throw new Error('A stable idempotency key is required');
    const response=await this.transport(new URL(`/v1/proofs/${encodeURIComponent(proofId)}/capture-intents`,this.apiBaseUrl),{method:'POST',headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({allowedSurfaces}),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Capture intent request failed (${response.status})`);
    const result=await response.json();
    if(result.schema!=='packproof.capture/1'||typeof result.launchToken!=='string'||!/^intent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(result.launchToken))throw new Error('Unsupported capture response');
    // Use this same URL for QR-to-phone and browser fallback. No customer details are encoded.
    return {intentId:result.intentId,expiresAt:result.expiresAt,launchUrl:`${this.siteOrigin}/capture#intent=${encodeURIComponent(result.launchToken)}`};
  }
}
/** Receipt trust comes from the configured signing-key registry, never a key supplied by the receipt itself. */
export function verifyCaptureReceipt(receipt,{proofId,captureId,trustedKeys}){
  try{
    if(receipt.schema!=='packproof.capture-receipt/1'||receipt.proofId!==proofId||receipt.captureId!==captureId||receipt.state!=='FINALIZED')return false;
    const proof=receipt.proofManifest,signature=proof?.signature,pem=trustedKeys[signature?.keyId];
    if(!pem||typeof proof.canonicalJson!=='string'||digest(proof.canonicalJson)!==proof.sha256||proof.proofId!==proofId)return false;
    const body=JSON.parse(proof.canonicalJson);if(body.proofId!==proofId)return false;
    const capture=body.captureManifests?.find(c=>c.captureId===captureId);
    if(!capture||capture.sha256!==receipt.manifestSha256||capture.manifest.context.proofId!==proofId||capture.manifest.context.captureId!==captureId||digest('packproof:manifest:1\n'+canonical(capture.manifest))!==capture.sha256)return false;
    const verifier=createVerify('sha256');verifier.update(proof.canonicalJson);verifier.end();
    const algorithm=signature.algorithm;
    if(!['ECDSA_SHA_256','RSASSA_PSS_SHA_256'].includes(algorithm))return false;
    return verifier.verify(algorithm==='RSASSA_PSS_SHA_256'?{key:pem,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}:{key:pem},Buffer.from(signature.signatureBase64,'base64'));
  }catch{return false;}
}
