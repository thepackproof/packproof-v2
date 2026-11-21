// Assemble connector-observed AWS responses. No AWS CLI or credential access.
// The input timestamps belong to the original observations; assembling does not renew them.
import {observeRuntime} from './connect-hosted-runtime-observe.mjs';
import {normalizeLogisticsSnapshot,logisticsConfigurationLease} from './logistics-runtime-release.mjs';

export async function assembleLogisticsRuntimeObservation({services,discovery,publicChecks,observedAt},now=Date.now()) {
  const started=Date.parse(observedAt);
  if(!Number.isFinite(started)||started>now||now-started>900000)throw Error('LOGISTICS_OBSERVE_EXPIRED');
  const normalized=normalizeLogisticsSnapshot({api:services.api,worker:services.worker});
  const result=await observeRuntime({services:async()=>normalized,discovery:async()=>discovery,
    readiness:async()=>publicChecks,clock:()=>started});
  // Force complete task validation, and retain the authoritative CANARY revision.
  logisticsConfigurationLease(result.snapshot);
  return result;
}
