import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PackProofApi } from '../api/client';
import { connectApprovalReturnPath } from '../auth/connect-approval-return';
import { useWorkflowCommand, useWorkflowData } from './workflow';

import './order-workspace-approval.css';
function Icon({name,size=36}:{name:string;size?:number}) {
  return <img className="pp-approval-icon" src={'/brand/connect/'+name+'.svg'} width={size} height={size} alt=""/>;
}
function Info({name,title,children}:{name:string;title:string;children:ReactNode}) {
  return <div className="pp-approval-row"><Icon name={name}/><div><h2>{title}</h2>{children}</div></div>;
}

export function ApprovalFrame({children,account,organization,onSwitch}:{children:ReactNode;account:string;organization?:string;onSwitch:()=>void}) {
  const [accounts,setAccounts]=useState(false);
  const title=useRef<HTMLHeadingElement>(null),link=useRef<HTMLButtonElement>(null),navigated=useRef(false);
  useEffect(()=>{if(navigated.current){if(accounts)title.current?.focus();else link.current?.focus();}},[accounts]);
  function select(next:boolean){navigated.current=true;setAccounts(next);}
  return <div className="pp-approval-page"><header className="pp-approval-bar"><div><Icon name="browser" size={33}/><b>Browser</b></div>
    <div><span className="pp-approval-logo"><img src="/brand/connect/packproof.png" alt=""/></span><span>PackProof Connect &nbsp;/&nbsp; Connection approval</span></div></header>
    <main className="pp-approval-panel"><div className="pp-approval-crumb"><Icon name={accounts?"computer":"approval"} size={48}/><span>Browser &nbsp;/&nbsp; {accounts?"Work account":"Connection request"}</span></div>
    {accounts?<><h1 ref={title} tabIndex={-1}>Choose your work account.</h1><p>Use an account with permission to approve sources in this workspace.</p>
      <Info name="computer" title={account}><p>{organization||"Signed-in account"}</p></Info>
      <div className="pp-approval-actions"><button className="pp-approval-primary" onClick={()=>select(false)}>Continue with this account</button><button className="pp-approval-secondary" onClick={onSwitch}>Sign in with another account</button></div></>:
      <>{children}<button ref={link} className="pp-approval-link" onClick={()=>select(true)}>Use another work account</button></>}</main></div>;
}

type ApprovalSession = {
  id: string;
  state: string;
  scopeDigest: string;
  expiresAt: string;
  deviceName: string;
  scope: {
    history: string;
    outputName?: string;
    sources: { id: string; displayName?: string; roles: string[]; transport?: 'folder' | 'api'; sourceNamespace?: string }[];
  };
};

export function OrderWorkspaceApproval({ api, organizationId, environment, params, canManage }: {
  api: PackProofApi; organizationId: string; environment: string; params: URLSearchParams; canManage: boolean;
}) {
  const sessionId = params.get('workspaceSession');
  const installationId = params.get('installationId');
  const exactScope = params.get('organizationId') === organizationId && params.get('environment') === environment;
  const valid = exactScope && connectApprovalReturnPath('/app/records/connect/approve?' + params) !== null;
  const path = sessionId && installationId && valid && canManage
    ? '/agent-installations/' + encodeURIComponent(installationId) + '/order-workspace/' + encodeURIComponent(sessionId) : null;
  const query = '?' + new URLSearchParams({ organizationId, environment });
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const result = useWorkflowData<ApprovalSession>(api, path && path + query, refresh, value => value.state === 'pending');
  const session = result.data?.id === sessionId ? result.data : null;
  const command = useWorkflowCommand(api, String(path) + query + session?.scopeDigest);
  useEffect(() => {
    if (!session || session.state !== 'pending') return;
    const deadline = Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [session?.state, session?.expiresAt]);
  const expired = session && (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now);
  async function decide(decision: 'approve' | 'deny') {
    if (!path || !session || expired || Date.parse(session.expiresAt) <= Date.now() || result.error || session.state !== 'pending' || notice) return;
    const accepted = await command.run(path + '/decision' + query, { organizationId, environment, scopeDigest: session.scopeDigest, decision });
    if (accepted) {
      setNotice(decision === 'approve' ? 'Access approved. PackProof Connect will continue automatically.' : 'Access declined. You can change the selection in PackProof Connect.');
      setRefresh(value => value + 1);
    }
  }
  if (!canManage || !valid) return <><h1>Check workspace access</h1><p role="alert">{canManage ? 'Reopen this request from the computer where you selected the sources.' : 'Sign in as an administrator of this workspace to review collection.'}</p></>;
  return <section aria-label="PackProof Connect approval">
    <h1>{session?.state === 'active' ? 'Collection approved' : 'Allow PackProof to read orders?'}</h1>
    {result.error ? <div role="alert"><p>{result.error}</p><button className="pp-approval-secondary" onClick={() => setRefresh(n => n + 1)}>Try again</button></div>
      : !session ? <p role="status">{result.loading ? 'Opening the request…' : 'The request changed. Reopen it from PackProof Connect.'}</p> : <>
        <p>Review the request you started from PackProof Connect on <strong>{session.deviceName}</strong>.</p>
        <div className="pp-approval-sources">{session.scope.sources.map(source =>
          <Info key={source.id} name={source.transport==='api'?'computer':'folder'} title={source.displayName || 'Selected source'}>
            {source.transport==='api' ? <p>Connected system{source.sourceNamespace?' · '+source.sourceNamespace:''}. Earlier orders may contain only a saved summary.</p>:
              <p>Read files in this folder and retain the originals online.</p>}
            <small>Records included · {source.roles.join(', ')}</small>
          </Info>)}<Info name="approval" title="Read access"><p>PackProof reads the selected records and keeps the originals in your source system.</p></Info></div>
        <dl className="pp-approval-facts"><div><dt>Collection period</dt><dd>{session.scope.history==='existing_and_future'?'Existing records and future changes':session.scope.history}</dd></div>
          <div><dt>Offline collection</dt><dd>Up to one hour after the last successful access check</dd></div>
          <div><dt>Saved proofs</dt><dd>{session.scope.outputName||'The folder selected on this computer'}</dd></div></dl>
        {notice ? <p role="status" className="pp-approval-notice">{notice}</p>:session.state==='active'?<p role="status" className="pp-approval-notice">Access approved. PackProof Connect will continue automatically.</p>:
          session.state!=='pending'||expired?<p role="status">This request is closed. Return to PackProof Connect to review its status or start again.</p>:
          <div className="pp-approval-actions"><button className="pp-approval-primary" disabled={command.busy || !session.scopeDigest} onClick={()=>void decide('approve')}>{command.busy?'Saving decision…':'Approve collection'}</button>
            <button className="pp-approval-secondary" disabled={command.busy} onClick={()=>void decide('deny')}>Decline</button></div>}
      </>}{command.error && <p role="alert">{command.error}</p>}
  </section>;
}
