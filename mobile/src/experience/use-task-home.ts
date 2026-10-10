import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import type { FulfillmentQueueItem } from '../v2-api';
import { workspaceProofRows, recentWorkspaceProofs, workspaceRecordings } from '../copy/workspace-summary';
import type { PresentedProof } from '../copy/proof-list';
import { nativeHomeInput } from './home-adapter';
import { selectTaskHome, stableRecommendation, actionIdentity, type HomeAction } from './task-home';
import { recordMobileUxEvent } from '../analytics/mobile-ux-events';

export function useTaskHome() {
  const app=usePackProof();
  const latest=useRef(app);latest.current=app;
  const alive=useRef(true), generation=useRef(0), actionBusy=useRef(false), refreshLock=useRef(false);
  const [loading,setLoading]=useState(!app.workspaceFreshAt);
  const [refreshing,setRefreshing]=useState(false);
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const [orders,setOrders]=useState<FulfillmentQueueItem[]>([]);
  const [interacting,setInteracting]=useState(false);
  const scope=`${app.apiBaseUrl}:${app.session?.userId}`;
  async function refresh() {
    if(refreshLock.current)return;
    const token=++generation.current, context=latest.current, account=context.session;
    if(!account)return;
    refreshLock.current=true;setRefreshing(true);setRefreshError(null);
    try {
      await context.syncWorkspace();
      if(!alive.current || generation.current!==token)return;
      try {
        const result=await context.client.listFulfillmentQueue('ready');
        context.client.assertCaptureAccount(account.userId,account.apiBaseUrl);
        if(alive.current && generation.current===token)setOrders(result.items);
      } catch { /* Queue is optional; existing Proofs and device work remain available. */ }
    } catch {
      if(alive.current&&generation.current===token)setRefreshError("Your records could not be refreshed. Saved work remains available. Try again.");
    }
    if(alive.current&&generation.current===token){setLoading(false);setRefreshing(false);refreshLock.current=false;}
  }
  useEffect(()=>{
    alive.current=true;setOrders([]);refreshLock.current=false;setLoading(!latest.current.workspaceFreshAt);void refresh();
    const listener=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});
    return ()=>{alive.current=false;generation.current++;refreshLock.current=false;listener.remove();};
  },[scope]);
  const rows=useMemo(()=>workspaceProofRows({proofs:app.proofCollection,invitations:app.pendingInvites,recordings:app.savedRecordings,localCapture:app.localCapture,captureProofId:app.session?.captureProofId,captureStatus:app.captureStatus,uploadProgressByProof:app.uploadProgressByProof}),[app.proofCollection,app.pendingInvites,app.savedRecordings,app.localCapture,app.captureStatus,app.uploadProgressByProof]);
  const model=selectTaskHome(nativeHomeInput({proofs:app.proofCollection,invitations:app.pendingInvites,captures:workspaceRecordings(app.savedRecordings,app.localCapture),orders,progress:app.uploadProgressByProof,userId:app.session?.userId??'',apiBaseUrl:app.apiBaseUrl,online:!app.offline,reconciled:app.workspaceReconciled,selection:app.selectedTask,interactions:app.readTaskInteractions()}));
  const previous=useRef<HomeAction|null>(null);
  const recommendation=stableRecommendation(previous.current,model,interacting);
  previous.current=recommendation;
  const displayIdentity=actionIdentity(recommendation);
  useEffect(()=>{if(!loading)recordMobileUxEvent('recommendation_displayed');},[displayIdentity,loading]);
  const attention=model.actions.map(action=>({action,proof:rows.find(p=>p.proofId===action.targetId)!})).filter(row=>Boolean(row.proof));
  const attentionIds=new Set(attention.map(row=>row.proof.proofId));
  const recent=recentWorkspaceProofs(rows.filter(p=>!attentionIds.has(p.proofId)));
  async function openProof(row:PresentedProof) {
    app.rememberTaskInteraction(row.proofId);
    if(row.accessKind==='RECEIVER'){app.openReceipt(row.proofId);return;}
    const invite=app.pendingInvites.find(i=>i.proofId===row.proofId);
    if(invite){app.openInvitation(invite);return;}
    await app.run(()=>app.openProof(row.proofId));
  }
  async function runAction(action:HomeAction) {
    if(actionBusy.current)return;
    actionBusy.current=true;
    recordMobileUxEvent('recommendation_selected');
    try {
      if(action.kind==='create_proof') {app.go('create');return;}
      if(action.kind==='reconcile'){await refresh();return;}
      if(!action.targetId)return;
      app.rememberTaskInteraction(action.targetId);
      if(action.kind==='review_upload') {app.go('activity',{activityFilter:'attention',activitySessionId:action.sessionId});return;}
      if(action.kind==='review_evidence') {
        const capture=workspaceRecordings(latest.current.savedRecordings,latest.current.localCapture).find(c=>(c.captureSessionId||c.uri)===action.sessionId && c.captureProofId===action.targetId);
        if(!capture){app.setError('This recording changed. Refresh to check its next step.');await refresh();return;}
        await app.resumeSavedCapture(capture);return;
      }
      await app.openProofAction(action.targetId);
    } finally {actionBusy.current=false;setInteracting(false);}
  }
  const freshnessLabel=app.workspaceReconciled&&!app.offline ? (app.workspaceFreshAt?`Updated ${new Date(app.workspaceFreshAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`:'Current workspace') : app.workspaceFreshAt ? `Cached records · last updated ${new Date(app.workspaceFreshAt).toLocaleString()}` : 'Waiting for workspace reconciliation';
  return {loading,refreshing,freshnessLabel,error:refreshError ?? app.error,recommendation,attention,recent,counts:model.counts,refresh,runAction,openProof,setInteracting};
}
