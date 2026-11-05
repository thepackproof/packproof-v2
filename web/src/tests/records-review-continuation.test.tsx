import {OperationalSnapshots} from '../records/OperationalSnapshots';
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {PackProofApi} from '../api/client';
import {RequirementTemplates} from '../records/RequirementTemplates';
import {IssueAssignment} from '../records/IssueAssignment';
import {QuantitySummary} from '../records/QuantitySummary';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const template={templateId:'template-a',version:2,definitionSha256:'a'.repeat(64),definition:{name:'Loading documents',description:null,rules:[{key:'loading',stage:'loading',title:'Loading source document',acceptedEvidenceTypes:['SOURCE_ARTIFACT'],gracePeriodMs:0}]}};
const scope={proofId:'proof-a',organizationId:'org-a',environment:'sandbox',recordRevision:7,entities:[{id:'proof-a',label:'Shipment record'},{id:'item-a',label:'Line item A'}],onUpdated:vi.fn()};
it('requires explicit template review and preserves a lost-response command identity while choices stay the same',async()=>{
 const request=vi.fn(async(_path:string,method='GET')=>{if(method==='POST')throw Error('Record changed; refresh before assignment.');return {templates:[template]};}),user=userEvent.setup();
 render(<RequirementTemplates {...scope} api={{recordsRequest:request} as unknown as PackProofApi}/>);
 await user.click(screen.getByText('Manage reusable evidence requirements'));
 await screen.findByRole('option',{name:/Loading documents/});
 await user.selectOptions(screen.getByRole('combobox',{name:'Published requirement set'}),'template-a@2');
 const save=screen.getByRole('button',{name:'Assign reviewed requirements'});expect(save).toBeDisabled();
 await user.type(screen.getByRole('textbox',{name:'Assignment reason'}),'Reviewed loading expectations');
 await user.click(screen.getByRole('checkbox',{name:/I reviewed this version/}));
 await user.click(save);expect(await screen.findByRole('alert')).toHaveTextContent('Record changed');await user.click(save);
 await waitFor(()=>expect(request.mock.calls.filter(call=>call[1]==='POST')).toHaveLength(2));
 const posts=(request.mock.calls as unknown as Array<[string,string,Record<string,unknown>,Record<string,string>]>).filter(call=>call[1]==='POST');
 expect(posts[0][2]).toMatchObject({templateId:'template-a',version:2,definitionSha256:template.definitionSha256,subjectId:'proof-a'});
 expect(posts[0][3]['If-Match']).toBe('"7"');expect(posts[0][3]['Idempotency-Key']).toBe(posts[1][3]['Idempotency-Key']);
 await user.selectOptions(screen.getByRole('combobox',{name:'Apply requirements to'}),'item-a');expect(save).toBeDisabled();
});
it('publishes reusable requirements from ordinary fields without immediately assigning them',async()=>{
 const request=vi.fn(async(_path:string,method='GET')=>method==='POST'?{...template,version:1,definition:{...template.definition,name:'Outbound documents'}}:{templates:[]}),user=userEvent.setup();
 render(<RequirementTemplates {...scope} api={{recordsRequest:request} as unknown as PackProofApi}/>);
 await user.click(screen.getByText('Manage reusable evidence requirements'));await user.click(screen.getByText('Create a reusable requirement set'));
 await user.type(screen.getByRole('textbox',{name:'Requirement set name'}),'Outbound documents');await user.type(screen.getByRole('textbox',{name:'Requirement title'}),'Source packing document');
 await user.click(screen.getByRole('button',{name:'Publish requirement set'}));expect(await screen.findByText(/Saved Outbound documents/)).toBeVisible();
 const posts=(request.mock.calls as unknown as Array<[string,string,Record<string,unknown>]>).filter(call=>call[1]==='POST');expect(posts).toHaveLength(1);expect(posts[0][2].expectedVersion).toBe(0);expect(posts[0][0]).toContain('/requirement-templates?');
 expect(request.mock.calls.some(call=>call[0].includes('requirement-template-assignments'))).toBe(false);
});
it('shows current split allocations and keeps reported quantity matches separate from physical condition',()=>{
 const value={ordered:{quantity:{amount:'10',unit:'each'},source:{system:'Order export',reference:'00045'}},allocations:[{handlingUnitId:'package-a',quantity:{amount:'9',unit:'each'}}],evaluation:{outcome:'different',ruleVersion:'packproof.quantity-comparison/v1',reason:'Exact quantity difference'}};
 render(<QuantitySummary relationships={[{id:'old-item',externalReference:'line-00045',attributes:{itemAllocation:value}},{id:'item-a',supersedesId:'old-item',externalReference:'line-00045',attributes:{itemAllocation:value}}]}/>);
 expect(screen.getAllByText('line-00045')).toHaveLength(1);expect(screen.getByText('Reported difference')).toBeVisible();expect(screen.getByText(/9 each → package-a/)).toBeVisible();expect(screen.getByText(/does not establish physical condition/)).toBeVisible();
});
it('offers eligible named reviewers and sends a reasoned revision-protected routing command',async()=>{
 const request=vi.fn(async(_path:string,method='GET')=>method==='POST'?{id:'assigned'}:{reviewers:[{membershipId:'member-a',label:'Warehouse reviewer',role:'REVIEWER'}]}),user=userEvent.setup(),updated=vi.fn();
 render(<IssueAssignment api={{recordsRequest:request} as unknown as PackProofApi} proofId="proof-a" issueId="issue-a" revision={4} query="organizationId=org-a&environment=sandbox" onUpdated={updated}/>);
 await user.click(screen.getByText('Assign review responsibility'));await screen.findByRole('option',{name:/Warehouse reviewer/});
 await user.selectOptions(screen.getByRole('combobox',{name:'Responsible reviewer'}),'member-a');await user.type(screen.getByRole('textbox',{name:'Assignment reason'}),'Check the loading document');await user.click(screen.getByRole('button',{name:'Save assignment'}));
 await waitFor(()=>expect(updated).toHaveBeenCalled());const post=(request.mock.calls as unknown as Array<[string,string,unknown,Record<string,string>]>).find(call=>call[1]==='POST')!;
 expect(post[2]).toEqual({membershipId:'member-a',reason:'Check the loading document'});expect(post[3]['If-Match']).toBe('"4"');expect(screen.getByText(/does not resolve the issue/)).toBeVisible();
});

it('labels an API-only snapshot without implying finalized capture evidence exists',async()=>{
 const receipt={snapshotId:'snapshot-source',state:'READY',coreCapture:'NOT_PRESENT',revision:7,omissions:[],inventory:{artifacts:[],includedCount:0,omittedCount:0,artifactBytes:0,hasMore:false,limit:100}};
 const request=vi.fn(async(path:string)=>path.includes('/source-artifacts?')?{artifacts:[]}:path.includes('/snapshots?')?{snapshots:[receipt],hasMore:false}:receipt);
 render(<OperationalSnapshots api={{recordsRequest:request} as unknown as PackProofApi} proofId="source-proof" organizationId="source-org" environment="sandbox" recordRevision={7} enabled storageScope="source-user.api"/>);
 expect(await screen.findByText(/It contains no finalized capture manifest or personal attestation/)).toBeVisible();
});
