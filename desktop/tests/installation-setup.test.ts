import {describe,expect,it,vi} from 'vitest';
import {readInstallationSetupAccess} from '../src/main/installation-setup';
import {DesktopApi} from '../src/main/api';

const locator={installationId:'installation_test',environment:'sandbox' as const};
const organization={id:'org_test',environment:'sandbox',enabled:true,role:'ADMIN',locations:[{id:'location_test'}]};
const row={id:locator.installationId,installationId:locator.installationId,organizationId:organization.id,environment:'sandbox',locationId:null,state:'setup',
  config:{sourceName:'private source'},health:{queueCount:12},credentialExpiresAt:'2030-01-01T00:00:00Z'};
const missing=Object.assign(Error('not found'),{status:404});
const readFor=(orgs:unknown[]=[organization],value:unknown=row)=>vi.fn(async(path:string)=>path==='/me/records/context'?{organizations:orgs}:value);

describe('exact human-authorized installation setup metadata',()=>{
  it('uses the existing current-admin route and returns only recovery metadata',async()=>{
    const read=readFor();
    expect(await readInstallationSetupAccess(locator,'user_test',read)).toEqual({installationId:locator.installationId,organizationId:'org_test',environment:'sandbox',locationId:null,state:'setup',userId:'user_test'});
    expect(read.mock.calls.map(([path])=>path)).toEqual(['/me/records/context','/me/records/agent-installations/installation_test?organizationId=org_test&environment=sandbox']);
  });
  it('resolves stripped revoked binding without choosing another installation',async()=>{
    const read=vi.fn(async(path:string)=>{
      if(path==='/me/records/context')return{organizations:[{...organization,id:'org_other'},organization]};
      if(path.includes('org_other'))throw missing;
      return{...row,state:'revoked'};
    });
    expect(await readInstallationSetupAccess(locator,'user_test',read)).toMatchObject({installationId:locator.installationId,state:'revoked'});
    expect(read.mock.calls.slice(1).every(([path])=>path.includes('/installation_test?'))).toBe(true);
  });
  it.each([{role:'OPERATOR'},{role:'REVIEWER'},{enabled:false},{environment:'live'}])('rejects an ineligible current workspace %j',async change=>{
    const read=readFor([{...organization,...change}]);
    await expect(readInstallationSetupAccess(locator,'user_test',read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps a known workspace exact and checks current location grants even for administrators',async()=>{
    await expect(readInstallationSetupAccess({...locator,organizationId:'org_test'},'user_test',readFor([organization],{...row,locationId:'location_other'}))).rejects.toThrow();
    await expect(readInstallationSetupAccess({...locator,organizationId:'org_other'},'user_test',readFor())).rejects.toThrow();
    expect(await readInstallationSetupAccess(locator,'user_test',readFor([organization],{...row,locationId:'location_test'}))).toMatchObject({locationId:'location_test'});
  });
  it.each([{id:'other'},{organizationId:'other'},{environment:'live'},{locationId:undefined},{state:'unknown'}])('rejects mismatched server identity %j',async change=>{
    await expect(readInstallationSetupAccess(locator,'user_test',readFor([organization],{...row,...change}))).rejects.toThrow();
  });
  it('bounds workspace lookup, rejects ambiguous metadata, and aborts authority failures',async()=>{
    const tooMany=readFor(Array.from({length:21},(_,i)=>({...organization,id:'org_'+i})));
    await expect(readInstallationSetupAccess(locator,'user_test',tooMany)).rejects.toThrow();
    expect(tooMany).toHaveBeenCalledTimes(1);
    await expect(readInstallationSetupAccess(locator,'user_test',readFor([organization,organization]))).rejects.toThrow();
    const denied=vi.fn(async(path:string)=>{if(path==='/me/records/context')return{organizations:[{...organization,id:'first'},organization]};throw Object.assign(Error('sign in'),{status:401});});
    await expect(readInstallationSetupAccess(locator,'user_test',denied)).rejects.toMatchObject({status:401});
    expect(denied).toHaveBeenCalledTimes(2);
  });
  it('uses the signed-in transport and stops when its account changes during lookup',async()=>{
    let user='user_test';
    const fetcher=vi.fn<typeof fetch>(async()=>{user='other_user';return new Response(JSON.stringify({organizations:[organization]}),{headers:{'Content-Type':'application/json'}});});
    const api=new DesktopApi({config:{channel:'development',apiBaseUrl:'https://api.example.test',webBaseUrl:'https://example.test',cognito:{clientId:'example',userPoolId:'us-east-1_example',region:'us-east-1'}},getAccountId:()=>user,getToken:async()=>'test-token',fetch:fetcher});
    await expect(api.installationSetupAccess(locator)).rejects.toMatchObject({code:'SESSION_CHANGED'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });
});
