import {describe,it,expect,vi,afterEach} from 'vitest';
import {schemas} from '../src/main/security';
import {DesktopApi} from '../src/main/api';
import type {DesktopConfig} from '../src/main/config';
import {desktopStudyApi,desktopStudyContext,desktopUploadState} from '../src/renderer/study';

afterEach(()=>vi.unstubAllGlobals());
describe('optional desktop study boundary',()=>{
  it('keeps capture, commitment and finalization states distinct',()=>{
    expect(desktopUploadState('RECORDING')).toBeUndefined();
    expect(desktopUploadState('COMMITTING')).toBe('committing');
    expect(desktopUploadState('FINALIZING')).toBe('finalizing');
    expect(desktopUploadState('COMPLETE')).toBe('complete');
    expect(desktopUploadState('WAITING_FOR_AUTH')).toBe('waiting');
    expect(desktopUploadState('INTERRUPTED')).toBe('needs_attention');
  });
  it('accepts only bounded study routes and supported method combinations',()=>{
    const input={userId:'account-a',path:'/consent',method:'GET'};
    expect(schemas.study.safeParse([input]).success).toBe(true);
    expect(schemas.study.safeParse([{...input,path:'/timings',method:'POST',body:{events:[]}}]).success).toBe(true);
    for(const bad of [{...input,path:'/me'},{...input,path:'/timings'},{...input,path:'/consent?token=x'},{...input,method:'DELETE'},{...input,body:{token:'unexpected'}},{...input,userId:undefined},{...input,method:'POST',body:{value:'x'.repeat(65537)}}])expect(schemas.study.safeParse([bad]).success).toBe(false);
  });
  it('binds every renderer request to the account which owns its journal',async()=>{
    const request=vi.fn(async()=>({enabled:false}));vi.stubGlobal('window',{packproof:{study:{request}}});
    const api=desktopStudyApi('https://api.example.invalid','account-a');
    await api.studyRequest('/consent');
    expect(request).toHaveBeenCalledWith('account-a','/consent','GET',undefined);
    await expect(api.studyRequest('https://evil.invalid')).rejects.toThrow('Unsupported');
    await expect(api.studyRequest('/consent','DELETE')).rejects.toThrow('Unsupported');
    expect(request).toHaveBeenCalledTimes(1);
    expect(desktopStudyContext('1.0.1')).toEqual({flowVersion:1,platform:'desktop',appVersion:'1.0.1'});
    expect(desktopStudyContext('account@example.invalid')).not.toHaveProperty('appVersion');
  });
  it('uses authenticated same-service transport and rejects account changes',async()=>{
    let account='account-a';const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>{account='account-b';return new Response(JSON.stringify({enabled:true}),{status:200});});
    const api=new DesktopApi({config:{apiBaseUrl:'https://api.example.invalid'} as DesktopConfig,getAccountId:()=>account,getToken:async()=>'test-token',fetch:fetcher});
    await expect(api.studyRequest('/consent','GET')).rejects.toThrow('Sign in to the account');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.invalid/study/consent');
    expect(()=>api.assertAccount('account-a')).toThrow('Sign in to the account');
  });
});
