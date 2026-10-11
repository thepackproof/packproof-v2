import {describe,it,expect,vi} from 'vitest';
import {DesktopApi,DesktopApiError,type DesktopCaptureAdmission} from '../src/main/api';
import {desktopCaptureAllowance} from '../src/main/capture-allowance';
import {DesktopEvidenceTransport} from '../src/main/evidence-api';
import {loadConfig} from '../src/main/config';
import {schemas} from '../src/main/security';
const grant:DesktopCaptureAdmission={schemaVersion:1,proofId:'proof_a',client:'DESKTOP_CAMERA',surface:'DESKTOP',reservation:'RESERVED',maxRecordingBytes:10000,maxRecordingSeconds:30,registrationTiming:'POST_CAPTURE_CLIENT_REPORTED'};
describe('desktop pre-record allowance without invented camera provenance',()=>{
 it('requires an exact account and Proof tuple at the IPC boundary',()=>{
  expect(schemas.currentProof.safeParse(['proof_a','account_a']).success).toBe(true);
  for(const value of [['proof_a'],['proof_a','account_a','extra'],['../foreign','account_a']])expect(schemas.currentProof.safeParse(value).success).toBe(false);
 });
 it('reserves only via the bounded authenticated endpoint and exposes no server camera-session ID',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(grant),{status:200}));
  const api=new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:'https://api.example.test'}),getAccountId:()=> 'account_a',getToken:async()=> 'fixture-bearer',fetch:fetcher});
  const result=await new DesktopEvidenceTransport(api).authorizeCapture({accountId:'account_a',proofId:'proof_a',jobId:'job_a'},new AbortController().signal);
  expect(result).toMatchObject({maxRecordingBytes:10000,maxRecordingSeconds:30});expect(result).not.toHaveProperty('id');
  expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/proofs/proof_a/capture-sessions/desktop-admission');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({schemaVersion:1});
 });
 it('checks the account again after admission and never uses another Proof response',async()=>{
  let owner='account_a';const api={assertAccount:(expected:string)=>{if(expected!==owner)throw new Error('Account changed');},admitDesktopCapture:vi.fn(async()=>grant)};
  await expect(desktopCaptureAllowance(api,'proof_a','other',false)).rejects.toThrow('Account changed');expect(api.admitDesktopCapture).not.toHaveBeenCalled();
  api.admitDesktopCapture.mockImplementation(async()=>{owner='other';return grant;});
  await expect(desktopCaptureAllowance(api,'proof_a','account_a',false)).rejects.toThrow('Account changed');
  owner='account_a';api.admitDesktopCapture.mockResolvedValue({...grant,proofId:'foreign'});
  await expect(desktopCaptureAllowance(api,'proof_a','account_a',false)).rejects.toMatchObject({code:'INVALID_DESKTOP_ADMISSION'});
 });
 it('preserves explicit offline capture, but never converts online denials or timeouts to eligibility',async()=>{
  const api={assertAccount:vi.fn(),admitDesktopCapture:vi.fn(async()=>grant)};
  expect(await desktopCaptureAllowance(api,'proof_a','account_a',true)).toMatchObject({reservation:'UNCONFIRMED',maxRecordingSeconds:300});expect(api.admitDesktopCapture).not.toHaveBeenCalled();
  for(const error of [new DesktopApiError('BILLING_CAPTURE_ALLOWANCE_EXHAUSTED','Allowance exhausted',402),new DesktopApiError('SERVICE_UNAVAILABLE','Service unavailable',503),new Error('Network timeout')]){
   api.admitDesktopCapture.mockRejectedValueOnce(error);await expect(desktopCaptureAllowance(api,'proof_a','account_a',false)).rejects.toBe(error);
  }
 });
 it('fails closed on malformed limits and unsupported protocol, and clamps valid larger limits',async()=>{
  const api={assertAccount:vi.fn(),admitDesktopCapture:vi.fn(async()=>grant)};
  for(const patch of [{maxRecordingBytes:0},{maxRecordingSeconds:NaN},{maxRecordingSeconds:1.5},{client:'WEB_CAMERA'}]){
   api.admitDesktopCapture.mockResolvedValueOnce({...grant,...patch} as DesktopCaptureAdmission);await expect(desktopCaptureAllowance(api,'proof_a','account_a',false)).rejects.toMatchObject({code:'INVALID_DESKTOP_ADMISSION'});
  }
  api.admitDesktopCapture.mockResolvedValueOnce({...grant,maxRecordingBytes:999_000_000,maxRecordingSeconds:600});expect(await desktopCaptureAllowance(api,'proof_a','account_a',false)).toMatchObject({maxRecordingBytes:250_000_000,maxRecordingSeconds:300});
  api.admitDesktopCapture.mockRejectedValueOnce(new DesktopApiError('NOT_FOUND','Not found',404));await expect(desktopCaptureAllowance(api,'proof_a','account_a',false)).rejects.toMatchObject({code:'DESKTOP_ADMISSION_UNAVAILABLE'});
 });
});
