import { useState } from 'react';
import type { PackProofApi } from '../api/client';
import { displayState } from './model';
import { useWorkflowCommand, useWorkflowData } from './workflow';

interface Action {
  id:string;caseKey:string;version:number;action:string;reason:string;createdAt:string;
  actorUserId:string;ownerMembershipId:string|null;proofRevision:number;
}
export interface OrderGap {key:string;label:string;open:boolean}
export function OrderCaseReview({api, scope, proofId, revision, gaps, canAct}: {
  api:PackProofApi;scope:string;proofId:string;revision:number;gaps:OrderGap[];canAct:boolean
}) {
  const [open,setOpen] = useState(false), [refresh,setRefresh] = useState(0);
  const [selected,setSelected] = useState(''), [choice,setChoice] = useState('request_receipt');
  const [reason,setReason] = useState(''), [owner,setOwner] = useState('');
  const base = '/order-proofs/' + encodeURIComponent(proofId) + '/case-actions?' + scope;
  const history = useWorkflowData<{items:Action[]}>(api,open ? base : null, refresh);
  const options = gaps.filter(g => g.open || history.data?.items.some(a => a.caseKey === g.key));
  const gap = options.find(g => g.key === selected) || options[0];
  const actions = (history.data?.items ?? []).filter(a => a.caseKey === gap?.key).sort((a,b) => b.version-a.version);
  const decision = gap?.open ? choice : 'resolve';
  const people = useWorkflowData<{reviewers:{membershipId:string;label:string}[]}>(api,
    open && decision === 'assign' ? '/' + encodeURIComponent(proofId) + '/issue-reviewers?' + scope : null);
  const command = useWorkflowCommand(api,base + ':' + revision + ':' + (gap?.key ?? ''));
  const submit = async () => {
    if (!gap || !history.data || !reason.trim()) return;
    const params = new URLSearchParams(scope);
    const result = await command.run(base,{organizationId:params.get('organizationId'),environment:params.get('environment'),
      caseKey:gap.key,expectedVersion:actions[0]?.version ?? 0,expectedRevision:revision,action:decision,
      reason:reason.trim(),...(decision === 'assign' ? {ownerMembershipId:owner} : {})});
    if (result) {setReason('');setRefresh(n=>n+1);}
  };
  return <details className="records-panel" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Review actions and follow-up</summary>
    {history.loading ? <p role="status">Checking follow-up history…</p> : history.error ? <p role="alert">{history.error}</p> : history.data && <>
      {options.length ? <label>Review subject<select value={gap?.key} onChange={e=>{setSelected(e.target.value);setReason('');}}>
        {options.map(g=><option key={g.key} value={g.key}>{g.label}</option>)}</select></label> : <p>No open discrepancies or recorded follow-up.</p>}
      {actions.length > 0 && <ul>{actions.map(a=><li key={a.id}><strong>{displayState(a.action)}</strong> · {new Date(a.createdAt).toLocaleString()} · Revision {a.proofRevision}
        <p>{a.reason}</p><small>Recorded by {a.actorUserId}{a.ownerMembershipId ? ' · Assigned to ' + a.ownerMembershipId : ''}</small></li>)}</ul>}
      {gap && canAct && (gap.open || (actions.length > 0 && actions[0].action !== 'resolve')) && <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <label>Next action<select value={decision} onChange={e=>setChoice(e.target.value)}>
          {gap.open ? <><option value="request_receipt">Record a receipt request</option><option value="clarify_mapping">Request mapping clarification</option><option value="assign">Assign follow-up</option></> : <option value="resolve">Confirm verified recovery</option>}
        </select></label>
        {decision === 'assign' && <label>Reviewer<select value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Choose a reviewer</option>
          {people.data?.reviewers.map(p=><option key={p.membershipId} value={p.membershipId}>{p.label}</option>)}</select></label>}
        {people.error && <p role="alert">{people.error}</p>}
        <label>Reason<textarea required maxLength={1024} value={reason} onChange={e=>setReason(e.target.value)}/></label>
        <button className="records-button" disabled={!reason.trim() || command.busy || (decision === 'assign' && !owner)}>Save follow-up</button>
        {command.error && <p role="alert">{command.error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>Refresh review</button></p>}
      </form>}
    </>}
  </details>;
}
