import {useState} from 'react';
import type {PackProofApi} from '../api/client';
import type {SourceSubscription} from './SourceSubscriptions';
import {nextSourceConfig} from './source-config-revision';
import {useWorkflowCommand} from './workflow';

export function SourceHeaderPolicy({api, source, organizationId, environment, onSaved}: {
  api: PackProofApi; source: SourceSubscription; organizationId: string; environment: string;
  onSaved: (source: SourceSubscription) => void;
}) {
  const scope = new URLSearchParams({organizationId, environment}).toString();
  const command = useWorkflowCommand(api, `${scope}.${source.id}.${source.configurationRevision}.headers`);
  const [consentedRevision, setConsentedRevision] = useState<number | null>(null);
  if (!source.config.expectedHeaders.length) return null;
  const reorder = source.config.headerPolicy === 'same_names_any_order/v1';
  async function propose() {
    if (consentedRevision !== source.configurationRevision || command.busy) return;
    const config = nextSourceConfig(source, {headerPolicy: reorder ? undefined : 'same_names_any_order/v1'});
    const result = await command.run<SourceSubscription>(`/source-subscriptions/${encodeURIComponent(source.id)}/actions?${scope}`, {
      organizationId, environment, action: 'revise', configurationRevision: source.configurationRevision, config,
    });
    if (result) { setConsentedRevision(null); onSaved(result); }
  }
  return <section>
    <h3>Report columns</h3>
    <p>{reorder ? 'The same columns can appear in a different order.' : 'The columns must appear in their approved order.'} New, renamed or missing columns require review before upload.</p>
    {source.capabilities?.csvHeaderReorder && source.state !== 'revoked' && <details><summary>Change the column order policy</summary>
      <p>{source.config.expectedHeaders.join(', ')}</p>
      <p>Each field keeps its exact column name. Saving this change pauses collection for separate source approval.</p>
      <label><input type="checkbox" checked={consentedRevision === source.configurationRevision} onChange={event=>setConsentedRevision(event.target.checked ? source.configurationRevision : null)}/>
        {reorder ? 'Require the listed order.' : 'Allow the listed columns in any order.'}</label>
      <button className="records-button secondary" disabled={command.busy || consentedRevision !== source.configurationRevision} onClick={()=>void propose()}>Propose column policy</button>
      {command.error && <p role="alert">{command.error}</p>}
    </details>}
  </section>;
}
