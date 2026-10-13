import {useEffect,useState} from 'react';
import type {WorkspaceUpdate} from '../shared/contracts';
import {ErrorNotice} from './components';
import {dateTime,errorMessage} from './presentation';

export function ActivityHistory({onOpen}:{onOpen:(id:string)=>void}) {
  const [updates,setUpdates]=useState<WorkspaceUpdate[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[generation,setGeneration]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void window.packproof.activity.list().then(result=>{if(active)setUpdates(result.notifications);}).catch(reason=>{if(active)setError(errorMessage(reason));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[generation]);
  useEffect(()=>window.packproof.events.subscribe(event=>{if(event.type==='notification')setGeneration(value=>value+1);}),[]);
  return <section className="panel" aria-label="Recent updates"><div className="section-heading"><h2>Recent updates</h2><button disabled={loading} onClick={()=>setGeneration(value=>value+1)}>{loading?'Loading updates…':error?'Retry updates':'Refresh updates'}</button></div>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {!loading&&!error&&!updates.length&&<p>Proof updates will appear here.</p>}
    <ul className="notification-history">{updates.map(update=><li key={update.id}><button className="text-button" onClick={()=>onOpen(update.proofId)}>{update.title}</button><time dateTime={update.createdAt}>{dateTime(update.createdAt)}</time></li>)}</ul>
  </section>;
}
