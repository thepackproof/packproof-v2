import {PackProofClient,type LegacySchemas,type PartnerSchemas} from './client.mjs';
const client=new PackProofClient({apiOrigin:'https://api.example.test',credential:'server-only-test'});
const envelope=await client.request('legacy.post_proofs',{key:'persisted-key',body:{externalId:'1001',transaction:{itemTitle:'Synthetic parcel'}}});
const proofId:string=envelope.proof.proofId;
const status:LegacySchemas['ProofStatus']=envelope.proof.status;
const result=await client.request('partner.searchPartnerProofs',{query:{state:'READY',limit:10}});
const preserved:boolean=result.proofs[0].readiness.preserved;
const snapshot:PartnerSchemas['ProofSnapshotMetadata']=await client.request('partner.createProofSnapshot',{body:{pageSize:10}});
const page=await client.request('partner.getProofSnapshot',{path:{snapshotId:snapshot.snapshotId}});
const after:string=snapshot.eventCursor;
const bindingPage=await client.request('partner.listPartnerProofBindings',{path:{proofId},query:{limit:50}});
const bindingKind:PartnerSchemas['CurrentExternalBinding']['resourceType']=bindingPage.bindings[0].resourceType;
void bindingKind;
const download:Response=await client.request('legacy.get_proofs_id_package',{path:{id:proofId}});
void [status,preserved,page,after,download];
// @ts-expect-error A create command must carry the original persisted idempotency key.
await client.request('legacy.post_proofs',{body:{externalId:'1001',transaction:{itemTitle:'Synthetic'}}});
// @ts-expect-error Proof read requires the path-bound Proof identity.
await client.request('legacy.get_proofs_id');
// @ts-expect-error Canonical lifecycle does not contain dashboard operational states.
const invalid:LegacySchemas['ProofStatus']='READY';
// @ts-expect-error Service client excludes account/admin operations.
await client.request('partner.get__me_organizations');
