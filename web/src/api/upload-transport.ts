import { ApiError } from "./types";

/** A stalled transfer is retryable; continuing byte progress renews the idle deadline. */
export function uploadBlob(url:string,method:string,headers:Record<string,string>,body:Blob,signal:AbortSignal,onProgress?:(sent:number)=>void):Promise<void> {
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    let idle:ReturnType<typeof setTimeout>,done=false,lastBytes=0;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(idle);signal.removeEventListener("abort",cancel);if(error)reject(error);else resolve();};
    const cancel=()=>{finish(new ApiError("UPLOAD_INTERRUPTED","Upload interrupted. Your original is saved for retry.",408));request.abort();};
    const arm=()=>{clearTimeout(idle);idle=setTimeout(cancel,90_000);};
    request.open(method,url);
    for(const [key,value] of Object.entries(headers))request.setRequestHeader(key,value);
    request.upload.onprogress=event=>{if(event.loaded>lastBytes){lastBytes=event.loaded;arm();onProgress?.(event.loaded);}};
    request.onerror=()=>finish(new ApiError("NETWORK_ERROR","Upload interrupted. Check your connection and resume.",0));
    request.onabort=()=>finish(new ApiError("UPLOAD_INTERRUPTED","Upload interrupted. Your original was kept.",408));
    request.onload=()=>{
      if(request.status>=200&&request.status<300){finish();return;}
      let error:{code?:string;message?:string}={};
      try{error=JSON.parse(request.responseText).error??{};}catch{/* S3 errors are XML. */}
      const expired=request.status===403&&/ExpiredToken|RequestExpired|AccessDenied/.test(request.responseText)&&!error.code;
      finish(new ApiError(expired?"UPLOAD_URL_EXPIRED":error.code??"UPLOAD_FAILED",expired?"The upload URL expired. Retrying the saved recording.":error.message??"Upload failed. Your original was kept.",expired?408:request.status));
    };
    signal.addEventListener("abort",cancel);arm();
    if(signal.aborted)cancel();else request.send(body);
  });
}
