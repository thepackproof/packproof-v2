import {afterEach,it,expect,vi} from 'vitest';
import {uploadBlob} from '../api/upload-transport';
let current:FakeXHR;
class FakeXHR {upload:{onprogress?:(e:{loaded:number})=>void}={};status=0;responseText='';onload?:()=>void;onabort?:()=>void;onerror?:()=>void;abort=vi.fn(()=>this.onabort?.());open=vi.fn();send=vi.fn();setRequestHeader=vi.fn();constructor(){current=this;}}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function start(){vi.useFakeTimers();vi.stubGlobal('XMLHttpRequest',FakeXHR);return uploadBlob('https://upload.test','PUT',{},new Blob(['video']),new AbortController().signal);}
it('stalled bytes become retryable instead of claiming an indefinite upload',async()=>{const job=start();const result=expect(job).rejects.toMatchObject({code:'UPLOAD_INTERRUPTED',status:408});await vi.advanceTimersByTimeAsync(90000);await result;expect(current.abort).toHaveBeenCalled();});
it('continuing byte progress keeps a slow upload alive',async()=>{const job=start();await vi.advanceTimersByTimeAsync(80000);current.upload.onprogress?.({loaded:1});await vi.advanceTimersByTimeAsync(80000);expect(current.abort).not.toHaveBeenCalled();current.status=200;current.onload?.();await job;});
it('an expired S3 URL is retryable so the same upload can request a fresh URL',async()=>{const job=start();current.status=403;current.responseText='<Error><Code>RequestExpired</Code></Error>';current.onload?.();await expect(job).rejects.toMatchObject({code:'UPLOAD_URL_EXPIRED',status:408});});
