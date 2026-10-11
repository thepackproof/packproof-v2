import {DesktopApi,DesktopApiError} from './api';
import type {CaptureAllowanceView} from '../shared/contracts';
export const LOCAL_CAPTURE_LIMITS={maxRecordingBytes:250_000_000,maxRecordingSeconds:300};

/** Offline eligibility is explicitly unconfirmed. An online failure is never an offline grant. */
export async function desktopCaptureAllowance(api:Pick<DesktopApi,'assertAccount'|'admitDesktopCapture'>,proofId:string,owner:string,offline:boolean,signal?:AbortSignal):Promise<CaptureAllowanceView>{
  api.assertAccount(owner);signal?.throwIfAborted();
  if(offline)return {proofId,reservation:'UNCONFIRMED',...LOCAL_CAPTURE_LIMITS};
  let response;
  try{response=await api.admitDesktopCapture(proofId,signal);}catch(error){
    if((error as {status?:number}).status===404)throw new DesktopApiError('DESKTOP_ADMISSION_UNAVAILABLE','This service cannot check desktop allowance yet. Retry after the service is updated; existing recordings remain available.',409);
    throw error;
  }
  api.assertAccount(owner);signal?.throwIfAborted();
  if(!response||response.schemaVersion!==1||response.proofId!==proofId||response.client!=='DESKTOP_CAMERA'||response.surface!=='DESKTOP'||response.registrationTiming!=='POST_CAPTURE_CLIENT_REPORTED'||!['RESERVED','NOT_REQUIRED'].includes(response.reservation)||!Number.isSafeInteger(response.maxRecordingBytes)||response.maxRecordingBytes<1||!Number.isSafeInteger(response.maxRecordingSeconds)||response.maxRecordingSeconds<1)
    throw new DesktopApiError('INVALID_DESKTOP_ADMISSION','Recording allowance could not be confirmed. Retry before packing.',502);
  return {proofId,reservation:response.reservation,maxRecordingBytes:Math.min(LOCAL_CAPTURE_LIMITS.maxRecordingBytes,response.maxRecordingBytes),maxRecordingSeconds:Math.min(LOCAL_CAPTURE_LIMITS.maxRecordingSeconds,response.maxRecordingSeconds)};
}
