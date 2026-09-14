/* The secure setting is resolved only by Zendesk's proxy, never in this iframe. */
'use strict';
const client=ZAFClient.init();
const apiOrigin='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const statusNode=document.getElementById('status'),results=document.getElementById('results');
let ticketId,workerId,sequence=0,busy=false;
function status(message,error=false){statusNode.textContent=message;statusNode.classList.toggle('error',error);}
function request(path,body){return client.request({url:apiOrigin+path,type:'POST',contentType:'application/json',dataType:'json',data:JSON.stringify(body),cors:false,secure:true,headers:{Authorization:'Bearer {{setting.claims_token}}'}});}
function errorMessage(error){
  const code=error?.responseJSON?.error?.code;
  if(code==='UNAUTHENTICATED'||error?.status===401)return 'The PackProof connection needs attention. Ask your administrator to reconnect it.';
  if(code==='ACCESS_LINK_EXPIRED'||code==='CLAIMS_PROOF_UNAVAILABLE')return 'Access has ended. Ask the seller for an updated Proof link.';
  if(error?.status===429)return 'Please wait a moment, then try again.';
  return 'PackProof could not be reached. Your ticket is unchanged; try again shortly.';
}
function field(parent,label,value){if(value==null||value==='')return;const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);parent.append(dt,dd);}
async function openProof(match,button){
  // Open synchronously to avoid a popup blocker after the asynchronous grant request.
  const popup=window.open('about:blank','_blank');
  if(!popup){status('Allow a new tab for this app, then select Open Proof again.',true);return;}
  popup.opener=null;button.disabled=true;
  try{
    const value=await request(`/v1/claims/proofs/${encodeURIComponent(match.proofId)}/open`,{ticketId,workerId});
    const url=new URL(value.viewerUrl);
    if(url.protocol!=='https:'||url.hostname!=='thepackproof.com'||!/^\/p\/[A-Za-z0-9_-]{43}$/.test(url.pathname))throw Error('Invalid viewer destination');
    popup.location.replace(url.href);status('Proof opened in a secure viewer. This link expires within 15 minutes.');
  }catch(error){popup.close();status(errorMessage(error),true);}finally{button.disabled=false;}
}
function render(match){
  const article=document.createElement('article'),title=document.createElement('h2'),details=document.createElement('dl');
  title.textContent=match.order?.itemTitle||'Proof record';article.append(title,details);
  field(details,'Order',match.order?.reference);field(details,'Proof',match.proofId);
  field(details,'State',match.status==='FINALIZED'?'Finalized':'In progress');
  const integrity={NOT_FINALIZED:'Not finalized',MANIFEST_HASH_MATCH:'Stored manifest hash matches',MANIFEST_HASH_MISMATCH:'Stored manifest hash does not match'};
  field(details,'Integrity',integrity[match.integrity?.result]||'Not checked');
  field(details,'Shipment',[match.shipment?.carrier,match.shipment?.trackingNumber].filter(Boolean).join(' · '));
  field(details,'Recordings shared',match.evidenceSummary?.sharedRecordings);
  const timeline=document.createElement('ol');
  for(const event of match.timeline||[]){const item=document.createElement('li');item.textContent=`${event.title} · ${new Date(event.occurredAt).toLocaleString()}`;timeline.append(item);}
  article.append(timeline);const button=document.createElement('button');button.type='button';button.textContent='Open Proof';button.addEventListener('click',()=>openProof(match,button));article.append(button);results.append(article);
}
async function lookup(identifiers){
  if(!ticketId||!workerId){status('Save this ticket before looking up its Proof.',true);return;}
  const current=++sequence;busy=true;document.getElementById('search').disabled=true;results.replaceChildren();status('Finding the Proof…');
  try{
    const data=await request('/v1/claims/lookup',{ticketId,workerId,...identifiers});
    if(current!==sequence)return;
    if(data.result==='NOT_FOUND')status('No approved Proof found. Check the reference or ask the seller to enable claims access.');
    else{status(data.result==='FOUND'?'Proof found.':'Multiple matches. Check the shipment and select its Proof.');data.matches.forEach(render);if(data.hasMore)status('More than 20 matches. Add a more specific reference.');}
  }catch(error){if(current===sequence)status(errorMessage(error),true);}
  finally{if(current===sequence){busy=false;document.getElementById('search').disabled=false;void client.invoke('resize',{width:'100%',height:Math.min(1100,document.body.scrollHeight+20)});}}
}
document.getElementById('lookup').addEventListener('submit',event=>{event.preventDefault();if(!busy)void lookup({[document.getElementById('kind').value]:document.getElementById('identifier').value.trim()});});
async function initialize(){
  try{
    const [context,metadata]=await Promise.all([client.get(['ticket.id','currentUser.id']),client.metadata()]);
    ticketId=context['ticket.id']?String(context['ticket.id']):null;workerId=context['currentUser.id']?String(context['currentUser.id']):null;
    const map={proof_id_field:'proofId',order_id_field:'orderId',tracking_field:'trackingNumber',reference_field:'ticketReference'};
    const identifiers={};
    for(const [setting,key] of Object.entries(map)){
      const id=String(metadata.settings[setting]||'').trim();if(!id)continue;
      if(!/^\d+$/.test(id)){status('A ticket field setting needs a numeric field ID. Ask your administrator to correct it.',true);return;}
      const path=`ticket.customField:custom_field_${id}`,value=(await client.get(path))[path];
      if(value)identifiers[key]=String(value).trim();
    }
    if(Object.keys(identifiers).length)await lookup(identifiers);else status('Enter an order reference, tracking number or Proof ID.');
  }catch(error){status(errorMessage(error),true);}
}
void client.invoke('resize',{width:'100%',height:600});void initialize();
