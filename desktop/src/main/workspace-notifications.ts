import type { CommerceConnectionView, ProofCollectionItem } from '../../../web/src/api/types';

export interface WorkspaceNotice { title: string; message: string }
const attentionNotice:WorkspaceNotice={title:'PackProof Proofs need attention',message:'A shipment record needs action. Open Proofs to review it.'};
const syncNotice:WorkspaceNotice={title:'Marketplace synchronization needs attention',message:'A marketplace could not synchronize. Open Integrations or Orders to review the connection and retry.'};

/** Main-process account-scoped monitor. Notification text never comes from API/renderer content. */
export class WorkspaceNotifications {
  private account:string|null=null;
  private generation=0;
  private stopped=false;
  private running=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private request:AbortController|null=null;
  private attention:Set<string>|null=null;
  private syncErrors:Set<string>|null=null;
  private manualSyncErrors=new Set<string>();
  constructor(private readonly options:{
    listAttention:(signal:AbortSignal)=>Promise<ProofCollectionItem[]>;
    listConnections:(signal:AbortSignal)=>Promise<{connections:CommerceConnectionView[]}>;
    notify:(notice:WorkspaceNotice)=>void;
    intervalMs?:number;
    requestTimeoutMs?:number;
  }){}
  setAccount(account:string|null){
    if(this.stopped||account===this.account)return;
    this.account=account;this.generation++;this.attention=null;this.syncErrors=null;this.manualSyncErrors.clear();
    clearTimeout(this.timer);this.request?.abort();
    if(account&&!this.running)void this.poll();
  }
  stop(){this.setAccount(null);this.stopped=true;clearTimeout(this.timer);this.request?.abort();}
  private schedule(delay=this.options.intervalMs??120_000){
    if(this.stopped||!this.account)return;
    clearTimeout(this.timer);this.timer=setTimeout(()=>void this.poll(),delay);this.timer.unref?.();
  }
  private async poll(){
    if(this.running||this.stopped||!this.account)return;
    this.running=true;const account=this.account,generation=this.generation,request=new AbortController();this.request=request;
    const timeout=setTimeout(()=>request.abort(),this.options.requestTimeoutMs??25_000);timeout.unref?.();
    try{
      const [proofs,connections]=await Promise.allSettled([Promise.resolve().then(()=>this.options.listAttention(request.signal)),Promise.resolve().then(()=>this.options.listConnections(request.signal))]);
      if(request.signal.aborted||generation!==this.generation||account!==this.account||this.stopped)return;
      if(proofs.status==='fulfilled')this.observeAttention(proofs.value);
      if(connections.status==='fulfilled')this.observeConnections(connections.value.connections);
      // Connectivity/auth failures preserve the previous baseline. A failed read
      // is not a Proof transition or evidence of a marketplace sync failure.
    }finally{
      clearTimeout(timeout);if(this.request===request)this.request=null;this.running=false;
      this.schedule(generation!==this.generation?0:undefined);
    }
  }
  private observeAttention(proofs:ProofCollectionItem[]){
    // This is the backend's complete attention-filtered collection, not a local
    // reinterpretation of Proof status. The first successful snapshot is silent.
    const current=new Set(proofs.map(proof=>proof.proofId));
    const changed=this.attention!==null&&[...current].some(id=>!this.attention!.has(id));
    this.attention=current;if(changed)this.options.notify({...attentionNotice});
  }
  private observeConnections(connections:CommerceConnectionView[]){
    const current=new Set(connections.filter(connection=>Boolean(connection.lastErrorCode)||['ERROR','FAILED','RECONNECT_REQUIRED'].includes(connection.status)).map(connection=>connection.connectionId));
    if(this.syncErrors!==null){
      const changed=[...current].some(id=>!this.syncErrors!.has(id)&&!this.manualSyncErrors.has(id));
      for(const id of this.syncErrors)if(!current.has(id))this.manualSyncErrors.delete(id);
      if(changed)this.options.notify({...syncNotice});
    }
    this.syncErrors=current;
  }
  syncFailed(account:string,scope:string){
    if(this.stopped||account!==this.account||this.manualSyncErrors.has(scope)||this.syncErrors?.has(scope))return;
    this.manualSyncErrors.add(scope);this.options.notify({...syncNotice});
  }
  syncSucceeded(account:string,scope:string){
    if(this.stopped||account!==this.account)return;
    this.manualSyncErrors.delete(scope);this.syncErrors?.delete(scope);
  }
}
