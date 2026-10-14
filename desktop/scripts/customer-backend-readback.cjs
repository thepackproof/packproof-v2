'use strict';
// Independent, read-only verification after the native app performs each write.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const API='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const CLIENT='34pnucunllka2jcs8hsq762m5e';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const insist=(value,code)=>{if(!value)throw new Error(code);};
async function createReader(platform){
 const credential=JSON.parse(process.env.CUSTOMER_FLOW_CREDENTIALS||'{}')[platform];
 insist(credential?.email?.endsWith('@example.invalid'),'ISOLATED_TEST_ACCOUNT_REQUIRED');
 let token,refreshToken,userId;
 async function auth(flow,parameters){const r=await fetch('https://cognito-idp.us-east-1.amazonaws.com/',{method:'POST',headers:{'Content-Type':'application/x-amz-json-1.1','X-Amz-Target':'AWSCognitoIdentityProviderService.InitiateAuth'},body:JSON.stringify({ClientId:CLIENT,AuthFlow:flow,AuthParameters:parameters}),signal:AbortSignal.timeout(30000)});const data=await r.json();insist(r.ok&&data.AuthenticationResult?.AccessToken,'TEST_SIGN_IN_FAILED');token=data.AuthenticationResult.AccessToken;refreshToken=data.AuthenticationResult.RefreshToken||refreshToken;}
 async function response(route){const r=await fetch(API+route,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(120000)});if(!r.ok){const data=await r.json().catch(()=>({}));const code=data.error?.code;throw new Error(/^[A-Z_]+$/.test(code||'')?code:'BACKEND_READ_HTTP_'+r.status);}return r;}
 async function get(route){return (await response(route)).json();}
 await auth('USER_PASSWORD_AUTH',{USERNAME:credential.email,PASSWORD:credential.password});
 userId=(await get('/me')).userId;insist(userId,'TEST_ACCOUNT_UNRESOLVED');
 async function preflight(){const usage=await get('/me/usage'),billing=await get('/me/billing/status'),proofs=(await get('/me/proofs?limit=100')).proofs;insist(usage.currentOffer===null&&usage.automaticChargesEnabled===false&&billing.subscriptions?.length===0&&billing.pendingCheckout===null,'UNENROLLED_TEST_ACCOUNT_REQUIRED');insist(proofs.every(p=>p.transaction.itemTitle?.startsWith('SYNTHETIC native flow ')),'TEST_ACCOUNT_CONTAINS_UNEXPECTED_PROOF');return{userId,existingSyntheticProofs:proofs.length,billingEnrolled:false,automaticChargesEnabled:false};}
 async function find(title){const list=(await get('/me/proofs?limit=100')).proofs.filter(p=>p.transaction.itemTitle===title);insist(list.length===1,'EXACT_SYNTHETIC_PROOF_REQUIRED');return get('/proofs/'+encodeURIComponent(list[0].proofId));}
 async function verify(title,out){
  const proof=await find(title);insist(proof.status==='FINALIZED'&&proof.finalizedAt&&proof.manifestId,'SERVER_FINALIZATION_NOT_CONFIRMED');
  insist(proof.participants.some(p=>p.userId===userId&&p.role==='SELLER'),'PROOF_ACCOUNT_MISMATCH');
  const manifest=await get(`/proofs/${proof.proofId}/manifest`);insist(manifest.proofId===proof.proofId&&hash(manifest.canonicalJson)===manifest.sha256,'MANIFEST_DIGEST_MISMATCH');
  insist(proof.evidence.length===1,'EXPECTED_ONE_CAMERA_RECORDING');
  const evidence=[];
  for(const row of proof.evidence){insist(row.committedAt&&row.sha256&&row.byteSize>0,'SERVER_EVIDENCE_NOT_COMMITTED');const r=await response(`/proofs/${proof.proofId}/evidence/${row.evidenceId}`);const bytes=Buffer.from(await r.arrayBuffer());insist(hash(bytes)===row.sha256&&bytes.length===row.byteSize,'ORIGINAL_DIGEST_MISMATCH');const ext=row.contentType?.includes('webm')?'webm':'mp4';fs.writeFileSync(path.join(out,`original-${row.evidenceId}.${ext}`),bytes);evidence.push({evidenceId:row.evidenceId,sha256:row.sha256,byteSize:row.byteSize,contentType:row.contentType,committedAt:row.committedAt,downloadedOriginalDigestVerified:true});}
  const again=await get(`/proofs/${proof.proofId}/manifest`);insist(again.sha256===manifest.sha256&&again.canonicalJson===manifest.canonicalJson,'MANIFEST_CHANGED_ON_READBACK');
  await auth('REFRESH_TOKEN_AUTH',{REFRESH_TOKEN:refreshToken});insist((await get('/me')).userId===userId,'REFRESH_ACCOUNT_MISMATCH');
  fs.writeFileSync(path.join(out,'finalized-manifest.json'),manifest.canonicalJson);
  const receipt={apiBaseUrl:API,checkedAt:new Date().toISOString(),userId,proofId:proof.proofId,status:proof.status,finalizedAt:proof.finalizedAt,manifestId:manifest.manifestId,manifestSha256:manifest.sha256,canonicalManifestDigestVerified:true,manifestReadbackStable:true,independentAuthenticationRefresh:true,evidence};
  fs.writeFileSync(path.join(out,'backend-readback.json'),JSON.stringify(receipt,null,2));return receipt;
 }
 return{preflight,find,verify};
}
module.exports={createReader};
if(require.main===module)(async()=>{const [platform,action,title,out]=process.argv.slice(2);const reader=await createReader(platform);const result=action==='preflight'?await reader.preflight():action==='find'?await reader.find(title):await reader.verify(title,out);if(action==='find')console.log(JSON.stringify({proofId:result.proofId,status:result.status,evidenceCount:result.evidence.length}));else console.log(JSON.stringify(result));})().catch(error=>{console.error(/^[A-Z_0-9]+$/.test(error.message||'')?error.message:'BACKEND_READBACK_FAILED');process.exitCode=1;});
