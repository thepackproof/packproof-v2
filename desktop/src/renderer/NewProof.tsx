import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ErrorNotice,Modal} from './components';
import {errorMessage} from './presentation';
import {completeManualProof,emptyManualProof,manualProofFields,manualProofKey,pendingManualProof,restoreManualProof,saveManualProof,submitManualProof,type ManualProofFields} from './manual-proof';

export function NewProof({userId,close,onCreated}:{userId:string;close:()=>void;onCreated:(id:string)=>void}){
  const [fields,setFields]=useState<ManualProofFields>({...emptyManualProof}),[key,setKey]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const sending=useRef(false),alive=useRef(true);
  useEffect(()=>{let current=true;alive.current=true;setKey(null);
    void window.packproof.proofs.scope(userId).then(scope=>{if(!current)return;const next=manualProofKey(scope,userId);setFields(restoreManualProof(next));setKey(next);}).catch(reason=>{if(current)setError(errorMessage(reason));});
    return()=>{current=false;alive.current=false;};
  },[userId]);
  const pending=key?pendingManualProof(key,fields):null;
  function change(name:keyof ManualProofFields,value:string){const next={...fields,[name]:value};setFields(next);if(key)try{saveManualProof(key,next);}catch(reason){setError(errorMessage(reason));}}
  function recover(){if(!pending||!key)return;const next=manualProofFields(pending);try{saveManualProof(key,next);setFields(next);setError('');}catch(reason){setError(errorMessage(reason));}}
  async function submit(event:FormEvent){event.preventDefault();if(!key||sending.current)return;sending.current=true;setBusy(true);setError('');
    try{const proof=await submitManualProof(key,userId,fields,(input,owner)=>window.packproof.proofs.create(input,owner));
      if(!alive.current)return;onCreated(proof.proofId);completeManualProof(key);
    }catch(reason){if(alive.current)setError(errorMessage(reason));}finally{sending.current=false;if(alive.current)setBusy(false);}
  }
  return <Modal title="New shipment Proof" close={()=>{if(!busy)close();}}><p>For synchronized marketplace orders, select the existing order from your fulfillment queue.</p><p className="help">Your draft is saved on this computer for this account.</p>{error&&<ErrorNotice>{error}</ErrorNotice>}{pending&&<div className="notice warning"><span>A previous creation request is still pending. Recover its submitted details to retry safely.</span><button type="button" disabled={busy} onClick={recover}>Recover submitted draft</button></div>}<form onSubmit={event=>void submit(event)}><fieldset disabled={busy||!key} style={{border:0,padding:0,margin:0}}><label>Item or shipment name<input required maxLength={250} value={fields.title} onChange={event=>change('title',event.target.value)} placeholder="e.g. Graded comic shipment" autoFocus/></label><label>Order reference <span className="optional">Optional</span><input maxLength={250} value={fields.reference} onChange={event=>change('reference',event.target.value)}/></label><div className="form-columns"><label>Tracking number <span className="optional">Optional</span><input maxLength={150} value={fields.tracking} onChange={event=>change('tracking',event.target.value)}/></label><label>Carrier <span className="optional">Optional</span><input maxLength={64} value={fields.carrier} onChange={event=>change('carrier',event.target.value)}/></label></div></fieldset><div className="modal-actions"><button type="button" onClick={close} disabled={busy}>Close</button><button className="primary" disabled={busy||!key||!!pending}>{busy?'Creating…':!key?'Loading draft…':'Create & open camera'}</button></div></form></Modal>;
}
