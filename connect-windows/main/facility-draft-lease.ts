const tenMinutes = 10 * 60 * 1000;
const networkCodes = new Set(['ENETUNREACH','EHOSTUNREACH','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
const permittedOffline = new Set(['choices','getStatus','getWorkspaceStatus','getFacilityDraft','saveFacilityNotes']);

export interface FacilityBinding {
  user:string; installationId:string; organizationId:string; environment:string; locationId:string|null;
  operatorMembershipId:string; integrationAccountId:string;
}
export function isOfflineTransport(error:unknown) {
  if (!error || typeof error!=='object' || 'status' in error || !('name' in error)) return false;
  if (error.name==='TimeoutError') return true;
  if (error.name!=='TypeError' || !('cause' in error) || !error.cause || typeof error.cause!=='object') return false;
  return 'code' in error.cause && networkCodes.has(String(error.cause.code));
}
export class FacilityDraftLease {
  private current: {key:string;checkedAt:number}|null=null;
  constructor(private now:()=>number=()=>performance.now()) {}
  clear(){this.current=null;}
  observe(binding:FacilityBinding,allowed:boolean) {
    this.current=allowed && binding.locationId ? {key:JSON.stringify(binding),checkedAt:this.now()}:null;
  }
  allows(binding:FacilityBinding,method:string,error:unknown) {
    const lease=this.current;
    if (!isOfflineTransport(error) || !lease || lease.key!==JSON.stringify(binding) ||
        this.now()-lease.checkedAt<0 || this.now()-lease.checkedAt>=tenMinutes) {this.clear();return false;}
    return permittedOffline.has(method);
  }
}
