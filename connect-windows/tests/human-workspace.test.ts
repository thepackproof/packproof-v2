import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron',()=>({ipcMain:{handle:vi.fn()}}));
vi.mock('../main/human-dashboard',()=>({openHumanDashboard:vi.fn(),closeHumanDashboard:vi.fn()}));
import { HumanWorkspaceClient } from '../main/human-workspace';
import { HostedSession } from '../main/hosted-session';
import type { ConnectStatus } from '../ui/types';

const scope = {organizationId:'org_test',environment:'sandbox',locationId:'facility_test'};
const identity = {apiBaseUrl:'https://api.example.test',userId:'human_test',username:null,displayName:null,token:async()=>'human-token'};
const order = {proofId:'proof_test',revision:3,orderReference:'SO-123'};
afterEach(()=>vi.unstubAllGlobals());

describe('local Evidence OS human transport',()=>{
  it('uses the human bearer and an exact facility query for order search, never a collector URL',async()=>{
    const fetcher = vi.fn<typeof fetch>(async()=>Response.json({orders:[order],nextBefore:4,totalOrders:8}));
    expect(await new HumanWorkspaceClient(identity,scope,fetcher).read('workspaceSearchOrders',['order&locationId=other'])).toEqual([order]);
    const [url,options] = fetcher.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/me/records/order-proofs');
    expect(parsed.searchParams.getAll('locationId')).toEqual(['facility_test']);
    expect(parsed.searchParams.get('organizationId')).toBe('org_test');
    expect(parsed.searchParams.get('q')).toBe('order&locationId=other');
    expect(options).toMatchObject({method:'GET',redirect:'error',headers:{Authorization:'Bearer human-token'}});
  });
  it('keeps the requested revision pinned and verifies the source artifact hash',async()=>{
    const bytes = Buffer.from('^XA^FO1,1^FD123^FS^XZ');
    const fetcher = vi.fn<typeof fetch>(async input=>String(input).includes('/sources/') ? Response.json({kind:'original',eventKey:'event_1',sourceId:'source_1',receiptId:'receipt_1',fileName:'label.zpl',artifactReceiptId:'receipt_1'}) :
      Response.json({kind:'original',receiptId:'receipt_1',fileName:'label.zpl',mediaType:'application/zpl',originalSha256:createHash('sha256').update(bytes).digest('hex'),bytesBase64:bytes.toString('base64')}));
    const value = await new HumanWorkspaceClient(identity,scope,fetcher).read('workspaceSourceRecord',['proof_test',3,'event_1']);
    expect(value).toMatchObject({eventKey:'event_1',artifact:{bytesBase64:bytes.toString('base64')}});
    expect(fetcher.mock.calls.every(([url])=>String(url).includes('/revisions/3/') && new URL(String(url)).searchParams.get('locationId')==='facility_test')).toBe(true);
    fetcher.mockImplementation(async input=>String(input).includes('/sources/') ? Response.json({kind:'original',eventKey:'event_1',artifactReceiptId:'receipt_1'}) : Response.json({kind:'original',receiptId:'receipt_1',mediaType:'application/zpl',originalSha256:'0'.repeat(64),bytesBase64:bytes.toString('base64')}));
    await expect(new HumanWorkspaceClient(identity,scope,fetcher).read('workspaceSourceRecord',['proof_test',3,'event_1'])).rejects.toThrow('integrity check');
  });
  it('rejects absent facility, invalid IDs and revision substitution',async()=>{
    const fetcher = vi.fn<typeof fetch>(async()=>Response.json({...order,revision:4,lines:[],events:[],evidence:[]}));
    expect(()=>new HumanWorkspaceClient(identity,{...scope,locationId:null},fetcher)).toThrow('authorized facility');
    const client = new HumanWorkspaceClient(identity,scope,fetcher);
    await expect(client.read('workspaceOrderDetail',['../other',3])).rejects.toThrow('Choose an order');
    await expect(client.read('workspaceOrderDetail',['proof_test',0])).rejects.toThrow('Choose an order');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.read('workspaceOrderDetail',['proof_test',3])).rejects.toThrow('revision changed');
  });
  it('keeps the native display projection and requires a separate human grant for originals',async()=>{
    const fetcher = vi.fn<typeof fetch>(async url=>String(url).includes('/sources/')
      ? Response.json({error:{code:'ORIGINAL_ACCESS_DENIED',message:'Your current access permits the order summary only.'}},{status:403})
      : Response.json({...order,lines:[],events:[{kind:'order',eventKey:'event_1',entity:{type:'order',id:'SO-123'},references:[],
          fields:{customerName:'Example customer',internalSecret:'not-a-display-field'},originalText:'raw source is separate'},
          {kind:'shipment',eventKey:'event_2',associationScope:'shared',fields:{customerName:'Another customer'}}],evidence:[]}));
    const client=new HumanWorkspaceClient(identity,scope,fetcher);
    const detail=await client.read('workspaceOrderDetail',['proof_test',3]);
    expect(detail).toMatchObject({events:[{fields:{customerName:'Example customer'}},{eventKey:'event_2'}]});
    expect(JSON.stringify(detail)).not.toMatch(/internalSecret|Another customer|raw source is separate/);
    await expect(client.read('workspaceSourceRecord',['proof_test',3,'event_1'])).rejects.toMatchObject({status:403,code:'ORIGINAL_ACCESS_DENIED'});
  });
});

function hosted(canConfigure = true) {
  let user = 'human_test';
  const local: ConnectStatus = {state:'collecting',installationId:'installation_test',environment:'development',
    binding:{...scope,operatorMembershipId:'member_test',integrationAccountId:'integration_test',sourceName:'ERP'},
    health:{serviceOnline:true,queueCount:7},transport:{state:'compatible',expectedRulesVersion:'v1'},
    workspace:{phase:'active',step:'overview',sources:[],orders:[{proofId:'collector_private',revision:1,orderReference:'SECRET'}],totalOrders:99,canReadOrders:true}};
  const human = {user:()=>user,dashboardIdentity:vi.fn(()=>identity),
    access:vi.fn(async()=>({...scope,userId:user,canConfigure})),setupAccess:vi.fn(),suggest:vi.fn(),review:vi.fn()};
  const host = new HostedSession(human,async()=>local,'https://example.test');
  return {host,human,local,setUser:(next:string)=>{user=next;}};
}
describe('human authority around local Evidence OS reads',()=>{
  it('replaces collector cards and counts with freshly human-authorized records',async()=>{
    const f=hosted();
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({orders:[order],totalOrders:1,updatedToday:1,updatedLast24Hours:1,nextBefore:null})));
    const authority=await f.host.guard('getWorkspaceStatus');
    const result=await f.host.presentWorkspace('getWorkspaceStatus',f.local,authority) as ConnectStatus;
    expect(result.workspace).toMatchObject({orders:[order],totalOrders:1,canReadOrders:true,canConfigure:true});
    expect(JSON.stringify(result)).not.toContain('collector_private');
    expect(f.human.access.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('discards a response after account change, facility change, or permission loss',async()=>{
    for (const change of ['account','facility','permission'] as const) {
      const f=hosted();
      vi.stubGlobal('fetch',vi.fn(async()=>{
        if(change==='account')f.setUser('other_user');
        if(change==='facility')f.human.access.mockResolvedValue({...scope,locationId:'other_facility',userId:'human_test',canConfigure:true});
        if(change==='permission')f.human.access.mockRejectedValue(Object.assign(Error('Permission removed'),{status:403}));
        return Response.json({...order,lines:[],events:[],evidence:[]});
      }));
      await expect(f.host.readWorkspace('workspaceOrderDetail',['proof_test',3])).rejects.toThrow();
    }
  });
  it('allows a scoped reader to read orders while retaining administrator gates and redacting local settings',async()=>{
    const f=hosted(false);
    f.local.source={folder:'C:\\private',folderDigest:'a'.repeat(64),accessible:true,samples:[{secret:'private-csv-value'}]};
    f.local.subscriptionDraft={folder:'C:\\private',folderDigest:'a'.repeat(64),files:[],samples:[{secret:'private-csv-value'}]};
    f.local.preview={id:'local-preview',previewVersion:'1',state:'ready',original:{sha256:'a'.repeat(64),byteSize:1},counts:{},recordIds:['private-csv-value'],rows:[]};
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({orders:[order],totalOrders:1,nextBefore:null})));
    const access=await f.host.guard('getWorkspaceStatus');
    const value=await f.host.presentWorkspace('getWorkspaceStatus',f.local,access) as ConnectStatus;
    expect(value.workspace).toMatchObject({canReadOrders:true,canConfigure:false,sources:[],outputFolder:null});
    expect(value.health.queueCount).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/private-csv-value|local-preview|C:\\\\private/);
    await expect(f.host.guard('chooseWorkspaceFolder')).rejects.toThrow('administrator');
    await expect(f.host.guard('openWorkspaceOutput')).rejects.toThrow('administrator');
    await expect(f.host.guard('workspaceOrderDetail')).resolves.toMatchObject({canReadOrders:true});
  });
  it('does not substitute cached service records or request human records without current compatible transport',async()=>{
    const f=hosted();
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const result=await f.host.presentWorkspace('getWorkspaceStatus',{...f.local,transport:{state:'unreachable',expectedRulesVersion:'v1'}},await f.host.guard('getWorkspaceStatus')) as ConnectStatus;
    expect(result.workspace).toMatchObject({canReadOrders:false,orders:[],totalOrders:null});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('withholds the human record transport during missing-facility bootstrap and preserves real collector phase for readers',async()=>{
    const f=hosted(false),fetcher=vi.fn(async()=>Response.json({orders:[order],totalOrders:1,nextBefore:null}));
    vi.stubGlobal('fetch',fetcher);
    f.local.workspace!.phase='draft';f.local.workspace!.step='order';
    const draft=await f.host.presentWorkspace('getWorkspaceStatus',f.local,await f.host.guard('getWorkspaceStatus')) as ConnectStatus;
    expect(draft.workspace).toMatchObject({phase:'draft',step:'order',canReadOrders:true,canConfigure:false});
    f.local.binding!.locationId=null;
    f.human.access.mockRejectedValue(Object.assign(Error('Missing facility'),{status:404}));
    f.human.setupAccess.mockResolvedValue({...scope,locationId:null,installationId:f.local.installationId,userId:'human_test',state:'setup'});
    fetcher.mockClear();
    const bootstrap=await f.host.presentWorkspace('getWorkspaceStatus',f.local,await f.host.guard('getWorkspaceStatus')) as ConnectStatus;
    expect(bootstrap).toMatchObject({setupAccess:{reason:'facility_required'},workspace:{canReadOrders:false}});
    await expect(f.host.readWorkspace('workspaceOrderDetail',['proof_test',3])).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
