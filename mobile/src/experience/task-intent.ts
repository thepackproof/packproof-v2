/** Local navigation locators only. This schema cannot contain tokens, codes or evidence consent. */
export type TaskIntent = {version:1;flowVersion:0|1;route:'create'|'manual'|'orders'|'activity'|'proof'|'receipt'|'signature'|'invitation'|'capture'|'finalize';proofId?:string;historyShareId?:string;invitationId?:string;creationMode?:'options'};
const routes=new Set(['create','manual','orders','activity','proof','receipt','signature','invitation','capture','finalize']);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
export const taskIntentKey=(api:string,user:string)=>`packproof.task-intent:v1:${encodeURIComponent(api.replace(/\/+$/,''))}:${user}`;
export const pendingLinkKey=(api:string)=>`packproof.pending-link:v1:${encodeURIComponent(api.replace(/\/+$/,''))}`;
export function parseTaskIntent(raw:string|null):TaskIntent|null {
  try {
    const value=JSON.parse(raw||'null');
    if(!value||value.version!==1||![0,1].includes(value.flowVersion)||!routes.has(value.route))return null;
    if(['proof','receipt','signature','capture','finalize'].includes(value.route)&&!id(value.proofId))return null;
    if(value.route==='invitation'&&!id(value.invitationId))return null;
    if(value.historyShareId!==undefined&&!id(value.historyShareId))return null;
    // Explicit projection also drops unknown fields from stale or tampered storage.
    return {version:1,flowVersion:value.flowVersion,route:value.route,...(id(value.proofId)?{proofId:value.proofId}:{}),...(id(value.historyShareId)?{historyShareId:value.historyShareId}:{}),...(id(value.invitationId)?{invitationId:value.invitationId}:{}),...(value.route==='create'&&value.creationMode==='options'?{creationMode:'options' as const}:{})};
  } catch{return null;}
}
export function taskIntent(route:string,proofId:string|null|undefined,flowVersion:0|1,extra:Partial<Pick<TaskIntent,'historyShareId'|'invitationId'|'creationMode'>>={}):TaskIntent|null {
  return parseTaskIntent(JSON.stringify({version:1,flowVersion,route,...(proofId&&['proof','receipt','signature','invitation','capture','finalize'].includes(route)?{proofId}:{}),...extra}));
}
