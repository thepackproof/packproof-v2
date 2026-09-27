import { useEffect, useRef, useState } from 'react';
import type { SharedProofLink, SharedProofPreview } from '../shared/contracts';
import { Badge, ErrorNotice, Icon, Modal } from './components';
import { dateTime, errorMessage, humanize } from './presentation';

const sharingNotice='Anyone with this link can view this Proof’s original recordings and future updates until access ends. Review recordings for private information before sharing.';
const revocationNotice='Revoking a link prevents future access. It cannot recall files or screenshots already saved.';
export const sharingConsent='I reviewed this preview and the original recordings, and approve sharing them and future updates with anyone who has the link.';
const categoryLabels:Record<string,string>={status:'Proof status',order:'Order details',shipping:'Shipping events',evidence:'Original recordings',statements:'Participant statements',itemIdentifiers:'Item identifiers'};

export function SharePreviewContents({preview,open,disabled}:{preview:SharedProofPreview;open:(id:string,type:string)=>void;disabled:boolean}) {
  return <section className="share-preview" aria-label="Recipient preview">
    <div className="section-heading"><h3>What recipients can see</h3><Badge>{humanize(preview.status)}</Badge></div>
    <p className="help">Categories included by PackProof</p><div className="share-categories">{preview.disclosure.fields.map(field=><Badge key={field}>{categoryLabels[field]||humanize(field)}</Badge>)}</div>
    {preview.tracker&&<div className="share-recipient-summary"><h3>{preview.tracker.itemTitle||'Shared Proof'}</h3><p>{preview.tracker.headline}{preview.tracker.shipment?.carrier?` · ${preview.tracker.shipment.carrier}`:''}</p>{preview.fulfillmentScope==='REMAINING_SHIPMENT'&&<p className="help">This record covers the remaining shipment, not the complete order.</p>}<ul className="share-milestones">{preview.tracker.milestones.map((milestone,index)=><li key={`${milestone.code}-${index}`}><span>{milestone.label}</span><small>{milestone.occurredAt?dateTime(milestone.occurredAt):humanize(milestone.state||'Upcoming')}</small></li>)}</ul></div>}
    {!!preview.chronology?.length&&<details><summary>Record activity · {preview.chronology.length}</summary>{preview.chronology.map(event=><div className="share-statement" key={event.id}><p>{event.title}</p><small>{dateTime(event.occurredAt)} · {humanize(event.source)}{event.provider?` · ${event.provider}`:''}</small></div>)}</details>}
    {preview.recordTracking&&<details><summary>Shipping events · {preview.recordTracking.events.length}</summary><p>{preview.recordTracking.carrier||'Carrier not available'} · {humanize(preview.recordTracking.status||preview.recordTracking.syncState)}</p>{preview.recordTracking.events.map(event=><div className="share-statement" key={event.id}><p>{humanize(event.eventType)}</p><small>{dateTime(event.occurredAt)} · {humanize(event.source)} · {event.provider}</small></div>)}<small>Last update: {dateTime(preview.recordTracking.lastUpdatedAt)} · {humanize(preview.recordTracking.source)}</small></details>}
    <h3>Original recordings · {preview.evidence?.length??0}</h3>
    {preview.evidence?.length?<ul className="share-recordings">{preview.evidence.map(item=><li key={item.evidenceId}><div><strong>{item.label||`${item.slot} recording`}</strong><small>{item.slot} · {item.contentType||'Original media'}</small></div><button disabled={disabled} onClick={()=>open(item.evidenceId,item.contentType||'application/octet-stream')}><Icon name="play" size={16}/>Review original</button></li>)}</ul>:<p className="muted">{preview.evidenceState?.message||'No original recordings are currently available.'} Future recordings will be included while the link remains active.</p>}
    {!!preview.statements?.length&&<details><summary>Participant statements · {preview.statements.length}</summary>{preview.statements.map(statement=><div className="share-statement" key={statement.attestationId}><p>{statement.statement}</p><small>{statement.attributedTo} · {dateTime(statement.createdAt)}</small></div>)}</details>}
    {preview.recordAsOf?.scopeStatement&&<p className="help">{preview.recordAsOf.scopeStatement}</p>}
    {preview.integrity&&<details><summary>Integrity · {humanize(preview.integrity.result)}</summary><p className="help">{preview.integrity.scope}</p></details>}
  </section>;
}

export function ShareProof({id,onClose}:{id:string;onClose:()=>void}) {
  const [preview,setPreview]=useState<SharedProofPreview|null>(null),[link,setLink]=useState<SharedProofLink|null>(null);
  const [reviewed,setReviewed]=useState(false),[days,setDays]=useState(7),[busy,setBusy]=useState<'preview'|'create'|'media'|null>('preview');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[media,setMedia]=useState<{url:string;type:string}|null>(null);
  const active=useRef(false),lock=useRef(false),generation=useRef(0);
  async function refresh(){
    if(lock.current)return;lock.current=true;
    const request=++generation.current;setBusy('preview');setPreview(null);setReviewed(false);setMedia(null);setError('');
    try{const next=await window.packproof.proofs.sharePreview(id);if(active.current&&request===generation.current)setPreview(next);}
    catch(reason){if(active.current&&request===generation.current)setError(errorMessage(reason));}
    finally{lock.current=false;if(active.current&&request===generation.current)setBusy(null);}
  }
  useEffect(()=>{active.current=true;void refresh();return()=>{active.current=false;generation.current++;};},[id]);
  async function create(){
    if(lock.current||!preview||!reviewed)return;lock.current=true;setBusy('create');setError('');
    try{const result=await window.packproof.proofs.share(id,{previewHash:preview.disclosure.viewHash,originalsReviewed:true,expiresAt:new Date(Date.now()+days*86400_000).toISOString()});if(active.current){setLink(result);setMedia(null);}}
    catch(reason){if(active.current){setError(errorMessage(reason));setPreview(null);setReviewed(false);setMedia(null);}}
    finally{lock.current=false;if(active.current)setBusy(null);}
  }
  async function open(evidenceId:string,type:string){
    if(lock.current||!preview)return;lock.current=true;setBusy('media');setError('');
    try{const url=await window.packproof.proofs.evidenceUrl(id,evidenceId,preview.disclosure.viewHash);if(active.current)setMedia({url,type});}
    catch(reason){if(active.current)setError(errorMessage(reason));}
    finally{lock.current=false;if(active.current)setBusy(null);}
  }
  return <Modal title={link?'Share this Proof':'Review sharing'} close={()=>{if(busy!=='create')onClose();}}>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {notice&&<p role="status">{notice}</p>}
    {link?<>
      <div className="notice success">Share link created.</div>
      <p>{preview?.disclosure.sharingNotice||sharingNotice}</p>
      <label>Proof link<input value={link.url} readOnly onFocus={event=>event.target.select()}/></label>
      <p className="help">{link.expiresAt?`Access expires ${dateTime(link.expiresAt)}.`:'Check the link expiry in PackProof.'}</p>
      <p className="help">{preview?.disclosure.revocationNotice||revocationNotice}</p>
      <p className="help">Manage or revoke this link from Share Proof → Manage shared links on the PackProof website.</p>
      <div className="modal-actions"><button onClick={()=>void window.packproof.system.openExternal(link.url).catch(reason=>setError(errorMessage(reason)))}>Open link</button><button className="primary" onClick={()=>void navigator.clipboard.writeText(link.url).then(()=>setNotice('Share link copied.')).catch(()=>setNotice('Select the link above and copy it.'))}>Copy link</button></div>
    </>:<>
      <p>{preview?.disclosure.sharingNotice||sharingNotice}</p>
      {busy==='preview'&&<p role="status">Loading the current recipient preview…</p>}
      {preview&&<>
        <SharePreviewContents preview={preview} open={(evidenceId,type)=>void open(evidenceId,type)} disabled={!!busy}/>
        {media&&<div className="share-playback">{media.type.startsWith('video')?<video className="evidence-player" src={media.url} controls autoPlay onError={()=>setError('This recording could not play. Check your connection and try Review original again.')}/>:media.type.startsWith('image')?<img className="evidence-player" src={media.url} alt="Original recording from the sharing preview" onError={()=>setError('This original could not load. Try Review original again.')}/>:<p>Preview is unavailable for this media type. Use the authenticated Proof export to review the original before approving sharing.</p>}<p className="help">Authenticated original playback. This does not create a public link.</p></div>}
        <label>Link expires<select aria-label="Link expires" value={days} disabled={!!busy} onChange={event=>setDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
        <p className="help">{preview.disclosure.revocationNotice||revocationNotice}</p>
        <label className="declaration"><input type="checkbox" checked={reviewed} disabled={!!busy} onChange={event=>setReviewed(event.target.checked)}/><span>{sharingConsent}</span></label>
      </>}
      <div className="modal-actions"><button disabled={busy==='create'} onClick={onClose}>Cancel</button>{preview?<><button disabled={!!busy} onClick={()=>void refresh()}>Refresh preview</button><button className="primary" disabled={!!busy||!reviewed} onClick={()=>void create()}>{busy==='create'?'Creating link…':'Create share link'}</button></>:<button className="primary" disabled={!!busy} onClick={()=>void refresh()}>Review latest preview</button>}</div>
    </>}
  </Modal>;
}
