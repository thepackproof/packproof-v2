import {buildRndRequest,createRndClient,type RndInput,type RndOutput} from '../generated-client.mjs';
const consent:RndInput<'recordConsent'>={path:{id:'proof'},idempotencyKey:'consent-1',body:{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true}};
buildRndRequest('recordConsent',consent);
buildRndRequest('requestAnalysis',{path:{id:'proof'},idempotencyKey:'analysis-1',body:{feature:'proofsight',evidenceIds:['e1'],parameters:{samplingHz:2,annotations:[{annotationId:'region1',sourceId:'e1',semanticClass:'PARCEL',polygon:[[0,0],[10,0],[10,10]]}]}}});
buildRndRequest('requestDerivative',{path:{id:'proof'},idempotencyKey:'derivative-1',body:{evidenceIds:['e1'],parameters:{mode:'zk-prove',enrollmentId:'enrollment',mask:Array(16).fill(true) as [boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean]}}});
// @ts-expect-error Unknown model paths are never a client parameter.
buildRndRequest('requestAnalysis',{path:{id:'proof'},idempotencyKey:'a',body:{feature:'proofsight',evidenceIds:['e1'],parameters:{modelPath:'/tmp/arbitrary'}}});
// @ts-expect-error Exact reviewed artifact and recipe digests are required.
buildRndRequest('derivativeReview',{path:{id:'proof',analysisId:'a'},idempotencyKey:'r',body:{approved:true}});
// @ts-expect-error The active illumination mode is not exposed.
buildRndRequest('issueLiveChallenge',{path:{id:'proof'},idempotencyKey:'c',body:{intentId:'i',mode:'TORCH'}});
// @ts-expect-error Analysis path binding is mandatory.
buildRndRequest('getAnalysis',{});
const client=createRndClient({fetch:globalThis.fetch});
const response:Promise<RndOutput<'listAnalyses'>>=client.listAnalyses({path:{id:'proof'}});
void response;
