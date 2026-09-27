type ShutdownCode='QUIT_REQUESTED'|'QUIT_EVIDENCE_DRAINED'|'QUIT_REPORTING_CLOSED'|'QUIT_CLOSE_ALLOWED'|'QUIT_NATIVE_REQUESTED'|'QUIT_CANCELED'|'QUIT_FAILED';
interface ShutdownActions {
  stop():void;
  drain():Promise<void>;
  closeReporting():Promise<void>;
  quit():void;
  record(code:ShutdownCode):void;
  nextTurn?():Promise<void>;
}

/** Protect native close until preservation finishes, then leave Electron's current close stack. */
export class ShutdownCoordinator {
  private preparation?:Promise<void>;
  private request?:Promise<void>;
  private generation=0;
  private allowed=false;
  constructor(private readonly actions:ShutdownActions){}
  get closeAllowed(){return this.allowed;}
  get inProgress(){return !!this.preparation;}
  prepare():Promise<void>{
    if(this.preparation)return this.preparation;
    const generation=this.generation;
    this.preparation=Promise.resolve().then(async()=>{
      this.actions.record('QUIT_REQUESTED');this.actions.stop();
      await this.actions.drain();this.actions.record('QUIT_EVIDENCE_DRAINED');
      await this.actions.closeReporting();this.actions.record('QUIT_REPORTING_CLOSED');
      // Electron drains promise microtasks inside its native close event. A promise-only
      // continuation can quit before the original preventDefault cancellation resets it.
      // setImmediate leaves that native stack; queueMicrotask/Promise.resolve do not.
      await (this.actions.nextTurn?.()??new Promise<void>(resolve=>setImmediate(resolve)));
      if(generation!==this.generation)throw new Error('Shutdown was canceled.');
      this.allowed=true;this.actions.record('QUIT_CLOSE_ALLOWED');
    }).catch(error=>{
      if(generation===this.generation){this.allowed=false;this.preparation=undefined;this.actions.record('QUIT_FAILED');}
      throw error;
    });
    return this.preparation;
  }
  quit():Promise<void>{
    if(this.request)return this.request;
    const generation=this.generation;
    this.request=this.prepare().then(()=>{
      if(generation!==this.generation)return;
      this.actions.record('QUIT_NATIVE_REQUESTED');this.actions.quit();
    }).catch(error=>{if(generation===this.generation)this.request=undefined;throw error;});
    return this.request;
  }
  /** Electron/renderer vetoes remain effective; never force a guarded window closed. */
  canceled(){this.generation++;this.allowed=false;this.preparation=undefined;this.request=undefined;this.actions.record('QUIT_CANCELED');}
}
