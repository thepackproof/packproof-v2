import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {FEATURES,type AnalysisEnvelope,type Feature} from '../../../packages/evidence-contracts/contracts.mjs';
import {RndReview} from './RndReview';
import {RndWebPanel} from './RndWebPanel';
import type {RndSnapshot,RndTransport,SourcePreview} from './types';
import {PackProofApi} from '../api/client';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const flagSet=(value=true)=>Object.fromEntries(FEATURES.map(feature=>[feature,{collection:value,processing:value,internalDisplay:value,customerDisplay:false}])) as Record<Feature,{collection:boolean;processing:boolean;internalDisplay:boolean;customerDisplay:boolean}>;
const source=(id:string)=>({sourceId:id,evidenceId:id,legId:'OUTBOUND',mimeType:'image/png',byteLength:100,sha256:'a'.repeat(64),relationship:'ORIGINAL_RECORDING' as const,retentionState:'AVAILABLE' as const});
function result(feature:Feature='proofshield',artifactCount=1):AnalysisEnvelope{return {schemaVersion:'packproof.analysis.v1',feature,tenantId:'tenant_a',proofId:'proof_a',rootManifestDigest:'sha256:'+'a'.repeat(64),subject:{packageInstanceId:'package_a',shipmentLegId:'OUTBOUND'},analysisId:'analysis_a',sourceRefs:[{...source('evidence_a'),proofId:'proof_a',objectKey:'private/object',objectVersionId:'version1',captureSessionId:null}],inputDigest:'sha256:'+'b'.repeat(64),method:{executableDigest:'sha256:'+'c'.repeat(64),modelDigest:null,policyVersion:'research-v1'},operationalState:'SUCCEEDED',findingState:'RECORDED',scope:'Local research only',coverage:{},reasonCodes:['RESEARCH_PROFILE_UNQUALIFIED'],limitations:['This is a derivative, not a finding about truth.'],supersedesId:null,serverReceivedAt:'2026-10-02T00:00:00Z',analyzedAt:'2026-10-02T00:00:01Z',details:{artifacts:Array.from({length:artifactCount},(_,i)=>({sha256:String(i+1).repeat(64),mimeType:'image/png'})),observations:[{type:'SIGNED_TRANSFORMATION_RECORD',sourceRefs:[{sourceId:'evidence_a'}],record:{recipeSha256:'f'.repeat(64)}}]}};}
function fixture(withJob=false,artifacts=1){
 const snapshot:RndSnapshot={sources:[source('evidence_a'),source('evidence_b')],analyses:withJob?[{analysisId:'analysis_a',feature:'proofshield',operationalState:'SUCCEEDED',findingState:'RECORDED',result:result('proofshield',artifacts),errorCode:null,createdAt:'2026-10-02T00:00:00Z',completedAt:'2026-10-02T00:00:01Z'}]:[],limitations:[]};
 const transport:RndTransport={capabilities:vi.fn().mockResolvedValue({enabled:true,killSwitch:false,features:flagSet(),releaseAuthorized:false}),list:vi.fn().mockResolvedValue(snapshot),consent:vi.fn().mockResolvedValue({}),request:vi.fn().mockResolvedValue({}),derivative:vi.fn().mockResolvedValue({}),artifact:vi.fn().mockResolvedValue({url:'blob:derivative-a',mimeType:'image/png'}),review:vi.fn().mockResolvedValue({}),export:vi.fn().mockResolvedValue({}),exportArchive:vi.fn().mockResolvedValue(undefined)};
 const openSource=vi.fn().mockResolvedValue({url:'blob:source-a',mimeType:'image/png'}),saveExport=vi.fn().mockResolvedValue(undefined);
 return {snapshot,transport,openSource,saveExport};
}
async function consent(){fireEvent.click(screen.getByText('Consented research tools'));fireEvent.click(screen.getByLabelText(/I am authorized/));fireEvent.click(screen.getByRole('button',{name:'Record research consent'}));await screen.findByRole('button',{name:'Research consent recorded'});}
beforeEach(()=>{vi.stubGlobal('URL',URL);URL.createObjectURL=vi.fn(()=> 'blob:created');URL.revokeObjectURL=vi.fn();});
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('research review boundaries',()=>{
 it('makes no research request or customer-facing panel when the build flag is off',()=>{
  vi.stubEnv('VITE_PACKPROOF_RND','0');const api={rndCapabilities:vi.fn(),rndAnalyses:vi.fn()} as unknown as PackProofApi;
  const {container}=render(<RndWebPanel proofId="proof_a" api={api}/>);
  expect(container).toBeEmptyDOMElement();expect(api.rndCapabilities).not.toHaveBeenCalled();
 });
 it.each([{enabled:false,killSwitch:false},{enabled:true,killSwitch:true}])('fails closed when global controls disable research: %j',async control=>{
  const f=fixture();vi.mocked(f.transport.capabilities).mockResolvedValue({...control,features:flagSet(),releaseAuthorized:false});
  render(<RndReview proofId="proof_a" {...f}/>);await waitFor(()=>expect(f.transport.capabilities).toHaveBeenCalled());await act(async()=>{});
  expect(f.transport.list).not.toHaveBeenCalled();expect(f.transport.request).not.toHaveBeenCalled();const button=screen.queryByRole('button',{name:'Request analysis'});if(button)expect(button).toBeDisabled();
 });
 it('does not display a server result when that feature internal-display flag is false',async()=>{
  const f=fixture(true);const flags=flagSet();flags.proofshield.internalDisplay=false;
  vi.mocked(f.transport.capabilities).mockResolvedValue({enabled:true,killSwitch:false,features:flags});
  render(<RndReview proofId="proof_a" {...f}/>);await waitFor(()=>expect(f.transport.list).toHaveBeenCalled());await act(async()=>{});
  expect(screen.queryByRole('button',{name:'Review redacted derivative'})).toBeNull();
 });
 it('clears source-bound masks when source selection changes',async()=>{
  const f=fixture();render(<RndReview proofId="proof_a" {...f}/>);await screen.findByText(/No research analyses (have been requested|are available for review)/);await consent();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'proofshield'}});
  fireEvent.click(screen.getByLabelText(/evidence_a · image/));fireEvent.click(screen.getByRole('button',{name:'Open mask editor'}));
  const img=await screen.findByAltText('Original being reviewed for redaction');
  Object.defineProperties(img,{naturalWidth:{value:800,configurable:true},naturalHeight:{value:600,configurable:true}});fireEvent.load(img);
  fireEvent.click(screen.getByRole('button',{name:'Add opaque mask'}));expect(screen.getByRole('button',{name:'Create derivative for review'})).toBeEnabled();
  fireEvent.click(screen.getByLabelText(/evidence_a · image/));fireEvent.click(screen.getByLabelText(/evidence_b · image/));
  expect(screen.queryByRole('button',{name:'Create derivative for review'})).toBeNull();expect(f.transport.derivative).not.toHaveBeenCalled();
 });
 it('does not revive an old Proof preview after navigation and revokes the stale object URL',async()=>{
  const f=fixture(true),pending=deferred<SourcePreview>();f.openSource.mockReturnValueOnce(pending.promise);
  const {rerender}=render(<RndReview proofId="proof_a" {...f}/>);fireEvent.click(await screen.findByRole('button',{name:'Open supporting source'}));
  rerender(<RndReview proofId="proof_b" {...f}/>);await waitFor(()=>expect(f.transport.list).toHaveBeenCalledWith('proof_b'));
  await act(async()=>pending.resolve({url:'blob:old-proof-private',mimeType:'image/png'}));
  expect(document.querySelector('img[src="blob:old-proof-private"]')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-proof-private');
 });
 it('does not transfer consent from an earlier Proof after a pending response',async()=>{
  const f=fixture(),pending=deferred<unknown>();vi.mocked(f.transport.consent).mockReturnValueOnce(pending.promise);
  const {rerender}=render(<RndReview proofId="proof_a" {...f}/>);await screen.findByText(/No research analyses (have been requested|are available for review)/);
  fireEvent.click(screen.getByText('Consented research tools'));fireEvent.click(screen.getByLabelText(/I am authorized/));fireEvent.click(screen.getByRole('button',{name:'Record research consent'}));
  rerender(<RndReview proofId="proof_b" {...f}/>);await waitFor(()=>expect(f.transport.list).toHaveBeenCalledWith('proof_b'));
  await act(async()=>pending.resolve({}));expect(screen.queryByRole('button',{name:'Research consent recorded'})).toBeNull();
 });
 it('renders actual comparison observation records as a matrix with missingness and unresolved conflicts',async()=>{
  const f=fixture(true);const analysis=result('proofmatch',0);analysis.details.observations=[{type:'COMPARISON_CHANNEL',channel:'identifier',findingState:'INCONCLUSIVE',conflict:true,sourceRefs:[{sourceId:'evidence_a'}],scope:'Observed text only',supportingObservations:[{type:'OCR_TEXT',attribution:'MACHINE_OBSERVATION',value:'ID-A'}]},{type:'COMPARISON_CHANNEL',channel:'weight',findingState:'NOT_CHECKED',sourceRefs:[{sourceId:'evidence_b'}],missingReason:'No measured weight was supplied'}];f.snapshot.analyses[0]={...f.snapshot.analyses[0],feature:'proofmatch',result:analysis};
  render(<RndReview proofId="proof_a" {...f}/>);await screen.findByRole('table',{name:'Comparison by channel'});expect(screen.getByText(/Unresolved conflict/)).toBeVisible();expect(screen.getByText('No measured weight was supplied')).toBeVisible();expect(screen.getByText(/ocr text · machine observation · ID-A/)).toBeVisible();
 });
 it('requires the exact artifact preview before enabling approval of its bytes',async()=>{
  const f=fixture(true,2);render(<RndReview proofId="proof_a" {...f}/>);
  const previews=await screen.findAllByRole('button',{name:'Review redacted derivative'});const approvals=screen.getAllByRole('button',{name:'Approve these exact redacted bytes'});
  expect(approvals.every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
  fireEvent.click(previews[0]);await waitFor(()=>expect(approvals[0]).toBeEnabled());expect(approvals[1]).toBeDisabled();
  fireEvent.click(approvals[0]);await waitFor(()=>expect(f.transport.review).toHaveBeenCalledWith('proof_a','analysis_a',{approved:true,artifactSha256:'1'.repeat(64),recipeSha256:'f'.repeat(64)},expect.any(String)));
 });
 it('does not approve a derivative when authorized artifact retrieval fails',async()=>{
  const f=fixture(true);vi.mocked(f.transport.artifact).mockRejectedValue(new Error('Forbidden'));
  render(<RndReview proofId="proof_a" {...f}/>);fireEvent.click(await screen.findByRole('button',{name:'Review redacted derivative'}));
  await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Approve these exact redacted bytes'})).toBeDisabled();expect(f.transport.review).not.toHaveBeenCalled();
 });
});

describe('web research effective API isolation',()=>{
 it('denies remote, credentials, non-HTTP, query and fragment bases when the real research flag is enabled',()=>{
  vi.stubEnv('VITE_PACKPROOF_RND','1');
  for(const baseUrl of ['https://api.thepackproof.com','https://localhost.evil.test','https://user:pass@localhost:3000','ftp://localhost:3000','http://127.0.0.1:3000?next=remote','http://127.0.0.1:3000#remote'])expect(()=>new PackProofApi({baseUrl,getToken:()=>null})).toThrow();
 });
 it('denies empty and relative API bases on a remote page origin',()=>{
  vi.stubEnv('VITE_PACKPROOF_RND','1');vi.stubGlobal('location',{origin:'https://thepackproof.com'});
  for(const baseUrl of ['','/api','//api.thepackproof.com'])expect(()=>new PackProofApi({baseUrl,getToken:()=>null})).toThrow('loopback');
 });
 it('pins empty/relative bases to their validated loopback origin before issuing requests',async()=>{
  vi.stubEnv('VITE_PACKPROOF_RND','1');vi.stubGlobal('location',{origin:'http://127.0.0.1:5173'});
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({enabled:false}),{headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
  const api=new PackProofApi({baseUrl:'',getToken:()=> 'local-token'});await api.rndCapabilities();
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:5173/rnd/capabilities');
 });
});
