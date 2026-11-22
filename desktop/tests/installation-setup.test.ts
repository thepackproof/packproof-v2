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

describe('pending file review in authenticated setup access', () => {
  const sha = 'a'.repeat(64);
  const binding = { sourceName: 'Shipping exports', integrationAccountId: 'source_1', operatorMembershipId: 'member_1', locationId: null };
  const history = { mode: 'selected_then_new', observedAt: '2020-01-02T03:04:05.000Z', initialFileName: 'Shipping report.csv',
    initialFileSha256: 'b'.repeat(64), baselineSha256: 'c'.repeat(64) };
  const contract = { schema: 'packproof.scheduled-csv/v2', historyPolicy: history };
  const proposal = { ...binding, sourceContract: contract, folderDigest: 'd'.repeat(64), mapping: { trackingNumber: 'Private heading' } };
  const pending = { ...row, ...binding, configRevision: 0, configSha256: null, config: null, pendingProposal: proposal,
    pendingProposalSha256: sha, testImportId: null, verifiedImportId: null };

  function transport(installation: unknown, role = 'ADMIN') {
    const fetcher = vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/context')
      ? { organizations: [{ ...organization, role }] } : installation));
    const api = new DesktopApi({ config: { channel: 'development', apiBaseUrl: 'https://api.example.test', webBaseUrl: 'https://example.test',
      cognito: { clientId: 'example', userPoolId: 'us-east-1_example', region: 'us-east-1' } },
      getAccountId: () => 'user_test', getToken: async () => 'test-token', fetch: fetcher });
    return { result: api.installationSetupAccess({ ...locator, organizationId: organization.id }), fetcher };
  }

  it('exposes only the original basename and pending digest from the exact current administrator read', async () => {
    const { result, fetcher } = transport(pending);
    expect(await result).toEqual({ installationId: locator.installationId, organizationId: organization.id, environment: 'sandbox',
      locationId: null, state: 'setup', userId: 'user_test', pendingFileReview: {
        proposalSha256: sha, fileName: 'Shipping report.csv', expiresAt: '2020-01-02T03:34:05.000Z' } });
    expect(fetcher.mock.calls.map(([url, opts]) => [new URL(String(url)).pathname, opts?.method])).toEqual([
      ['/me/records/context', 'GET'], ['/me/records/agent-installations/' + locator.installationId, 'GET']]);
  });

  it.each([
    { state: 'ready' }, {configRevision: 1}, {config: {}}, {configSha256: sha}, {testImportId: 'import_1'}, {pendingProposalSha256: 'bad'},
    {installationId: 'other'}, { pendingProposal: {...proposal, sourceName: 'other'} },
    { pendingProposal: {...proposal, sourceContract: {...contract, schema: 'packproof.scheduled-csv/v1'}} },
    ...[{observedAt: '2999-01-01T00:00:00Z'}, {observedAt: 'invalid'}, {observedAt: '2020-02-30T00:00:00Z'},
      {observedAt: '2020-01-01'}, {initialFileName: '../report.csv'},
      {initialFileName: 'unsafe\nreport.csv'}, {initialFileSha256: ''}].map(change => ({
        pendingProposal: {...proposal, sourceContract: {...contract, historyPolicy: {...history, ...change}}} })),
  ])('omits an ineligible review while preserving normal setup metadata', async change => {
    const { result } = transport({ ...pending, ...change });
    expect(await result).not.toHaveProperty('pendingFileReview');
  });

  it('does not read the installation for a non-administrator', async () => {
    const { result, fetcher } = transport(pending, 'OPERATOR');
    await expect(result).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers a fresh proposal after restart with the source timestamp and exact server digest', async () => {
    const renewedDigest = 'e'.repeat(64), observed = Date.now() - 120_000;
    const renewed = { ...pending, pendingProposalSha256: renewedDigest,
      pendingProposal: { ...proposal, sourceContract: { ...contract, historyPolicy: { ...history, observedAt: new Date(observed).toISOString() } } } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const { result } = transport(renewed);
      expect((await result).pendingFileReview).toEqual({ proposalSha256: renewedDigest, fileName: history.initialFileName,
        expiresAt: new Date(observed + 30 * 60_000).toISOString() });
    }
  });

  it('accepts an older source proposal with no location field only on an unrestricted installation', async () => {
    const { locationId: _location, ...older } = proposal;
    const { result } = transport({ ...pending, pendingProposal: older });
    expect((await result).pendingFileReview?.proposalSha256).toBe(sha);
    const restricted = transport({ ...pending, locationId: 'location_test', pendingProposal: older });
    expect(await restricted.result).not.toHaveProperty('pendingFileReview');
  });
});
