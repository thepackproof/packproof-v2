import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {DesktopApi} from '../src/main/api';
import {loadConfig} from '../src/main/config';
import {schemas} from '../src/main/security';
import {NewProof} from '../src/renderer/NewProof';
import {completeManualProof,manualProofFields,manualProofKey,pendingManualProof,restoreManualProof,saveManualProof,submitManualProof} from '../src/renderer/manual-proof';

const fields={title:'  Shipment A  ',reference:' order-A ',tracking:' 94001 ',carrier:' USPS '};
let values:Map<string,string>;
beforeEach(()=>{values=new Map();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});});
afterEach(()=>vi.unstubAllGlobals());
const apiScope='https://api.example.test';
function client(fetcher:typeof fetch,account=()=> 'account-A'){
  return new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:apiScope}),getAccountId:account,getToken:async()=> 'test-token',fetch:fetcher});
}

describe('desktop manual Proof recovery',()=>{
  it('persists before IPC and preserves exact operation through response loss and renderer restart',async()=>{
    const key=manualProofKey(apiScope,'account-A'),bodies:unknown[]=[];
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,options)=>{
      expect(values.has(`${key}:operation`)).toBe(true);
      bodies.push(JSON.parse(String(options?.body)));
      if(bodies.length===1)throw new Error('Response lost after server creation');
      return new Response(JSON.stringify({proofId:'proof-existing'}),{status:200});
    });
    const api=client(fetcher);
    const create=(input:Parameters<DesktopApi['createProof']>[0],owner:string)=>api.createProof(...schemas.transaction.parse([input,owner]));
    await expect(submitManualProof(key,'account-A',fields,create)).rejects.toThrow('Response lost');
    expect(restoreManualProof(key)).toEqual(fields);
    const result=await submitManualProof(key,'account-A',restoreManualProof(key),create);
    expect(result.proofId).toBe('proof-existing');expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({workflowType:'COMMERCE_SALE',transaction:{itemTitle:'Shipment A',externalReference:'order-A',shipping:{trackingNumber:'94001',carrier:'USPS'},idempotencyKey:expect.stringMatching(/^[a-f0-9-]{36}$/)}});
    completeManualProof(key);expect(values.size).toBe(0);
  });
  it('blocks changed pending fields and recovers the originally submitted fields and identity',async()=>{
    const key=manualProofKey(apiScope,'account-A'),create=vi.fn().mockRejectedValue(new Error('Offline'));
    await expect(submitManualProof(key,'account-A',fields,create)).rejects.toThrow('Offline');
    const original=create.mock.calls[0][0],edited={...fields,title:'A different shipment'};
    saveManualProof(key,edited);expect(restoreManualProof(key)).toEqual(edited);
    await expect(submitManualProof(key,'account-A',edited,create)).rejects.toThrow('Recover the submitted draft');expect(create).toHaveBeenCalledTimes(1);
    const submitted=pendingManualProof(key,edited);expect(submitted).not.toBeNull();
    const recovered=manualProofFields(submitted!);saveManualProof(key,recovered);
    create.mockResolvedValue({proofId:'proof-original'});
    await submitManualProof(key,'account-A',recovered,create);expect(create.mock.calls[1][0]).toEqual(original);
  });
  it('isolates drafts and operation identities by exact endpoint and account',async()=>{
    const key=manualProofKey(apiScope,'account-A');saveManualProof(key,fields);
    for(const other of [manualProofKey(apiScope,'account-B'),manualProofKey('https://another.example.test','account-A')]){
      expect(restoreManualProof(other).title).toBe('');expect(pendingManualProof(other,fields)).toBeNull();
    }
    const create=vi.fn().mockResolvedValue({proofId:'proof-A'});
    await submitManualProof(key,'account-A',fields,create);
    await submitManualProof(manualProofKey(apiScope,'account-B'),'account-B',fields,create);
    expect(create.mock.calls[1][0].idempotencyKey).not.toBe(create.mock.calls[0][0].idempotencyKey);
  });
  it('refuses to send when durable draft storage fails or a pending operation is corrupt',async()=>{
    const key=manualProofKey(apiScope,'account-A'),create=vi.fn();
    vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw new Error('Disk full');}});
    await expect(submitManualProof(key,'account-A',fields,create)).rejects.toThrow('could not save');expect(create).not.toHaveBeenCalled();
    vi.stubGlobal('localStorage',{getItem:(entry:string)=>entry.endsWith(':operation')?'invalid!':null,setItem:()=>{}});
    await expect(submitManualProof(key,'account-A',fields,create)).rejects.toThrow();expect(create).not.toHaveBeenCalled();
  });
  it('rejects a stale renderer owner before token access or any server call',async()=>{
    const fetcher=vi.fn<typeof fetch>(),getToken=vi.fn();
    const api=new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:apiScope}),getAccountId:()=> 'account-B',getToken,fetch:fetcher});
    expect(()=>api.createProof({itemTitle:'A',idempotencyKey:'saved-operation'},'account-A')).toThrow('Sign in to the account');
    expect(fetcher).not.toHaveBeenCalled();expect(getToken).not.toHaveBeenCalled();
  });
  it('accepts only bounded optional operation identity at the strict IPC boundary',()=>{
    expect(schemas.transaction.safeParse([{itemTitle:'A',idempotencyKey:'saved-operation'},'account-A']).success).toBe(true);
    expect(schemas.transaction.safeParse([{itemTitle:'Legacy caller'}]).success).toBe(true);
    for(const input of [{idempotencyKey:'short'},{idempotencyKey:'x'.repeat(129)},{idempotencyKey:'bad spaces'},{metadata:{createOperation:'forged'}},{proofId:'forged'}])expect(schemas.transaction.safeParse([{itemTitle:'A',...input},'account-A']).success).toBe(false);
    expect(schemas.transaction.safeParse([{itemTitle:'A'},'../account']).success).toBe(false);
  });
  it('renders creation disabled until main verifies the account and exact API scope',()=>{
    const html=renderToStaticMarkup(<NewProof userId="account-A" close={()=>{}} onCreated={()=>{}}/>);
    expect(html).toContain('Loading draft…');expect(html).toMatch(/<fieldset disabled=""/);expect(html).toContain('Your draft is saved on this computer for this account.');
  });
});
