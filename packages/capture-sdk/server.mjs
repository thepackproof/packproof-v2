import {createHash,createVerify,createPublicKey,constants} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
/** Server-only host SDK. API keys never enter a browser, QR, callback URL, or mobile app. */
export class CaptureHostClient {
  constructor({apiBaseUrl,siteOrigin,apiKey,fetch:transport=globalThis.fetch}){
    this.apiBaseUrl=new URL(apiBaseUrl);this.siteOrigin=new URL(siteOrigin).origin;this.apiKey=apiKey;this.transport=transport;
    if(this.apiBaseUrl.protocol!=='https:'||new URL(this.siteOrigin).protocol!=='https:')throw new Error('Capture hosts require HTTPS');
  }
  async createIntent(proofId,{idempotencyKey,allowedSurfaces=['ANDROID','IOS','WEB']}={}){
    if(!idempotencyKey)throw new Error('A stable idempotency key is required');
    const response=await this.transport(new URL(`/v1/proofs/${encodeURIComponent(proofId)}/capture-intents`,this.apiBaseUrl),{method:'POST',headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({allowedSurfaces}),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Capture intent request failed (${response.status})`);
    const result=await response.json();
    if(result.schema!=='packproof.capture/1'||typeof result.launchToken!=='string'||!/^intent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(result.launchToken))throw new Error('Unsupported capture response');
    // Use this same URL for QR-to-phone and browser fallback. No customer details are encoded.
    return {intentId:result.intentId,expiresAt:result.expiresAt,launchUrl:`${this.siteOrigin}/capture#intent=${encodeURIComponent(result.launchToken)}`};
  }
  async issueCompletionReceipt(proofId,captureId,{idempotencyKey,expectedContext,trustedKey}={}){
    if(typeof idempotencyKey!=='string'||!idempotencyKey)throw new Error('A stable idempotency key is required');
    return this.completionReceiptRequest('POST',proofId,captureId,{idempotencyKey,expectedContext,trustedKey});
  }
  async readCompletionReceipt(proofId,captureId,{expectedContext,trustedKey}={}){
    return this.completionReceiptRequest('GET',proofId,captureId,{expectedContext,trustedKey});
  }
  async completionReceiptRequest(method,proofId,captureId,{idempotencyKey,expectedContext,trustedKey}){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(proofId)||!/^[A-Za-z0-9_-]{1,128}$/.test(captureId)
      ||expectedContext?.proofId!==proofId||expectedContext?.captureId!==captureId||!trustedKey)throw new Error('Original expected capture context and trusted key are required');
    const response=await this.transport(new URL(`/v1/proofs/${encodeURIComponent(proofId)}/capture-sessions/${encodeURIComponent(captureId)}/completion-receipt`,this.apiBaseUrl),{
      method,headers:{Authorization:`Bearer ${this.apiKey}`,...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':idempotencyKey}:{})},
      ...(method==='POST'?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw new Error(`Capture completion request failed (${response.status})`);
    const receipt=await response.json();
    if(!verifyCaptureCompletionReceipt(receipt,expectedContext,trustedKey))throw new Error('Capture completion receipt did not match its original context and trusted signature');
    return receipt;
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

const completionContextKeys=['intentId','captureId','proofId','actorId','transactionId','transactionDigest','contextSha256',
  'captureManifestSha256','evidenceId','sourceSha256','finalManifestId','finalManifestSha256','audience','returnTarget'];
/** Verify the additive signed completion envelope against retained host context and a pinned active public key. */
export function verifyCaptureCompletionReceipt(receipt,expectedContext,trustedKey){
  try{
    const p=receipt?.payload,s=receipt?.signature;
    if(!p||p.schema!=='packproof.capture-completion/1'||p.state!=='FINALIZED'
      ||typeof p.receiptId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.receiptId)
      ||typeof p.issuedAt!=='string'||!Number.isFinite(Date.parse(p.issuedAt))
      ||typeof receipt.canonicalJson!=='string'||receipt.canonicalJson.length>16384
      ||typeof receipt.sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sha256)
      ||!s||!['ECDSA_SHA_256','RSASSA_PSS_SHA_256'].includes(s.algorithm)
      ||typeof s.keyId!=='string'||!s.keyId||s.keyId.length>200
      ||typeof s.signatureBase64!=='string'||!s.signatureBase64||s.signatureBase64.length>16384
      ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.signatureBase64)
      ||typeof s.signedAt!=='string'||!Number.isFinite(Date.parse(s.signedAt))
      ||!trustedKey||trustedKey.status!=='ACTIVE'||s.keyId!==trustedKey.keyId||s.algorithm!==trustedKey.algorithm
      ||typeof trustedKey.publicKeyPem!=='string'||trustedKey.publicKeyPem.includes('PRIVATE')||trustedKey.publicKeyPem.length>32768
      ||!trustedKey.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')||!expectedContext
      ||completionContextKeys.some(key=>typeof expectedContext[key]!=='string'||!expectedContext[key]||p[key]!==expectedContext[key]))return false;
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(p.intentId)||!/^[A-Za-z0-9_-]{1,128}$/.test(p.proofId)
      ||p.audience!==`packproof:capture-intent:${p.intentId}`||p.returnTarget!==`/proofs/${p.proofId}`
      ||Object.keys(p).sort().join(',')!==[...completionContextKeys,'schema','receiptId','state','issuedAt'].sort().join(',')
      ||canonical(p)!==receipt.canonicalJson||digest(receipt.canonicalJson)!==receipt.sha256)return false;
    for(const key of ['transactionDigest','contextSha256','captureManifestSha256','sourceSha256','finalManifestSha256'])if(!/^[a-f0-9]{64}$/.test(p[key]))return false;
    const key=createPublicKey(trustedKey.publicKeyPem);
    if(s.algorithm==='ECDSA_SHA_256'&&(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'))return false;
    if(s.algorithm==='RSASSA_PSS_SHA_256'&&(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048))return false;
    const verifier=createVerify('sha256');verifier.update(receipt.canonicalJson);verifier.end();
    return verifier.verify(s.algorithm==='RSASSA_PSS_SHA_256'?{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}:key,Buffer.from(s.signatureBase64,'base64'));
  }catch{return false;}
}
