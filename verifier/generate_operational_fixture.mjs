/** Synthetic public test fixture only; never uses a deployment key or network. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const loaded = require('canonicalize');
const canonicalize = loaded.default || loaded;
const bytes = value => Buffer.from(canonicalize(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-03T12:00:00.000Z', previousAt = '2026-11-03T11:00:00.000Z';
const earlier = '2026-11-03T10:00:00.000Z';
const proofId = 'proof_operational_fixture', organizationId = 'org_operational_fixture';
const original = Buffer.from('Synthetic organization-submitted photo bytes; no customer material.\n');
const core = Buffer.from(JSON.stringify({manifestVersion:1,proofId,synthetic:true,evidence:[{evidenceId:'evidence_fixture',evidenceType:'PHOTO',objectKey:'originals/evidence_fixture',objectVersionId:'immutable-version-fixture',contentType:'image/jpeg',byteSize:original.length,sha256:digest(original)}]}, null, 2)+'\n');
const entity = {id:'entity_package_fixture',proof_id:proofId,kind:'package',external_reference:'BOX-00001',parent_id:null,attributes:{expectedQuantity:2,observedQuantity:1},actor_user_id:'user_fixture',supersedes_id:null,created_at:earlier};
const artifact = {artifactId:'evidence_fixture',path:'originals/evidence_fixture',kind:'CAPTURE_ORIGINAL',sha256:digest(original),byteSize:original.length,contentType:'image/jpeg',evidenceType:'PHOTO',storage:{bucket:'synthetic-fixture',key:'originals/evidence_fixture',versionId:'immutable-version-fixture'},source:{kind:'ORGANIZATION_SUBMITTED',reference:null,reportedAt:earlier,receivedAt:earlier,acceptedAt:earlier,actorId:'user_fixture',connectionId:null,receiptSha256:null},derivation:null};
const manifest = {
  profile:'packproof.operational-record-manifest.v1',assertion:'ORGANIZATION_SUBMITTED',snapshotId:'snapshot_fixture_2',organizationId,environment:'sandbox',proofId,revision:2,
  priorSnapshot:null,core:{manifestSha256:digest(core)},evaluation:{at,version:'packproof.requirement-evaluation.v1'},
  actor:{userId:'user_fixture',membershipId:'membership_fixture',role:'OWNER',locationId:null},
  record:{title:'Synthetic fixture',reference:'000001',lifecycle:'open',reviewState:'unreviewed',locationId:null,updatedAt:earlier},
  entities:[entity],links:[{id:'link_fixture',proof_id:proofId,evidence_id:artifact.artifactId,subject_id:entity.id,reason:'Package photo association',actor_user_id:'user_fixture',created_at:earlier}],
  requirements:[{id:'requirement_fixture',proof_id:proofId,subject_id:entity.id,stage:'packing',title:'Packing photo',template_version:'fixture/v1',accepted_evidence_types:['PHOTO'],due_at:at,grace_period_ms:0,created_at:earlier,evaluation_status:'satisfied',matching_artifact_ids:[artifact.artifactId]}],
  waivers:[],issues:[{id:'issue_fixture',proof_id:proofId,category:'quantity_mismatch',severity:'warning',title:'Organization-submitted quantities differ',subject_id:entity.id,rule_version:'quantity-equality/v1',compared_sources:{expected:{value:2},observed:{value:1}},created_at:earlier}],
  actions:[{id:'action_fixture',sequence:'1',issue_id:'issue_fixture',action:'acknowledge',reason:'Review pending',actor_user_id:'user_fixture',created_at:earlier}],amendments:[],artifacts:[artifact],omissions:[]
};
const prior = structuredClone(manifest); prior.snapshotId='snapshot_fixture_1';prior.revision=1;prior.evaluation.at=previousAt;
const priorBytes=bytes(prior); manifest.priorSnapshot={snapshotId:prior.snapshotId,manifestSha256:digest(priorBytes)};
manifest.entities.push({...entity,id:'entity_late_fixture',external_reference:'LATE-ENTITY',attributes:{note:'A later revision appends an entity without rewriting the prior snapshot.'},created_at:'2026-11-03T11:30:00.000Z'});
const manifestBytes=bytes(manifest);
const payload = {profile:'packproof.operational-snapshot.v1',snapshotId:manifest.snapshotId,organizationId,environment:manifest.environment,proofId,revision:manifest.revision,manifestPath:'operational/manifest.json',manifestSha256:digest(manifestBytes),issuer:'https://synthetic-fixture.invalid',issuedAt:at};
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const protectedHeader=bytes({alg:'ES256',kid:'operational-fixture-test-key',typ:'application/packproof-operational-snapshot+jws'}).toString('base64url');
const encodedPayload=bytes(payload).toString('base64url');
const signature=sign('sha256',Buffer.from(`${protectedHeader}.${encodedPayload}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
const descriptor={schema:'packproof.operational-snapshot-package.v1',snapshotId:manifest.snapshotId,organizationId,environment:manifest.environment,proofId,revision:manifest.revision,envelopePath:'operational/envelope.jws.json',manifestPath:'operational/manifest.json',timestamp:{state:'NOT_PRESENT'}};
const files={'package.json':bytes(descriptor),'operational/envelope.jws.json':bytes({protected:protectedHeader,payload:encodedPayload,signature}),'operational/manifest.json':manifestBytes,'operational/prior-manifest.json':priorBytes,'core/manifest.json':core,[artifact.path]:original};
const fixture={synthetic:true,expectedManifestSha256:digest(manifestBytes),expectedCoreSha256:digest(core),expectedPriorSha256:digest(priorBytes),files:Object.fromEntries(Object.entries(files).map(([name,value])=>[name,value.toString('base64')])),trust:{schema:'packproof.envelope-trust.v1',issuer:payload.issuer,publishedAt:at,nextReviewAt:'2026-12-01T00:00:00.000Z',keys:[{keyId:'operational-fixture-test-key',publicKeyPem:publicKey.export({type:'spki',format:'pem'}),status:'ACTIVE',validFrom:'2026-11-01T00:00:00.000Z',validUntil:null,statusEffectiveAt:null}]}};
writeFileSync(fileURLToPath(new URL('operational-snapshot-fixture.json',import.meta.url)),JSON.stringify(fixture,null,2)+'\n');
