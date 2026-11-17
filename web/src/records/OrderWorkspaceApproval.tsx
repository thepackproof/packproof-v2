import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { connectApprovalReturnPath } from '../auth/connect-approval-return';
import { useWorkflowCommand, useWorkflowData } from './workflow';

type ApprovalSession = {
  id: string;
  state: string;
  scopeDigest: string;
  expiresAt: string;
  deviceName: string;
  scope: {
    history: string;
    outputName?: string;
    sources: { id: string; displayName?: string; roles: string[] }[];
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
    if (!path || !session || expired || result.error || session.state !== 'pending' || notice) return;
    const accepted = await command.run(path + '/decision' + query, { organizationId, environment, scopeDigest: session.scopeDigest, decision });
    if (accepted) {
      setNotice(decision === 'approve' ? 'Access approved. PackProof Connect will continue automatically.' : 'Access declined. You can change the selection in PackProof Connect.');
      setRefresh(value => value + 1);
    }
  }
  if (!canManage || !valid) return <p role="alert">{canManage ? 'Reopen this request from the computer where you selected the sources.' : 'Sign in as an administrator of this workspace to review collection.'}</p>;
  return <section className="records-panel agent-approval">
    <h1>Allow collection on this computer?</h1>
    {result.error ? <div role="alert"><p>{result.error}</p><button className="records-button secondary" onClick={() => setRefresh(n => n + 1)}>Try again</button></div>
      : !session ? <p role="status">{result.loading ? 'Opening the request…' : 'The request changed. Reopen it from PackProof Connect.'}</p>
      : <>
        <h2>{session.deviceName}</h2>
        <p>PackProof will read reports from these sources and retain their original files online for this workspace.</p>
        <ul>{session.scope.sources.map(source => <li key={source.id}>{source.displayName || 'Selected source'}</li>)}</ul>
        <dl className="records-facts">
          <div><dt>Records included</dt><dd>{session.scope.history === 'existing_and_future' ? 'Existing files and future changes' : session.scope.history}</dd></div>
          <div><dt>Offline collection</dt><dd>Up to one hour after the last successful access check</dd></div>
          <div><dt>Saved proofs</dt><dd>{session.scope.outputName || 'The folder selected on this computer'}</dd></div>
        </dl>
        {notice ? <p role="status">{notice}</p> : session.state === 'active' ? <p role="status">Access approved. PackProof Connect will continue automatically.</p>
          : session.state !== 'pending' || expired ? <p role="status">This request is closed. Return to PackProof Connect to review its status or start again.</p>
          : <div className="records-actions">
            <button className="records-button" disabled={command.busy || !session.scopeDigest} onClick={() => void decide('approve')}>{command.busy ? 'Saving decision…' : 'Approve collection'}</button>
            <button className="records-button secondary" disabled={command.busy} onClick={() => void decide('deny')}>Decline</button>
          </div>}
      </>}
    {command.error && <p role="alert">{command.error}</p>}
  </section>;
}
