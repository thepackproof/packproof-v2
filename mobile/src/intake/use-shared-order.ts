import { useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { orderShare, type SharedOrder } from '../../modules/packproof-order-share';
import { usePackProof } from '../app/PackProofProvider';
import { IntakeApi } from './api';
import { refreshNativeIntakeSession, stopNativeIntakeSession } from './native-session';
import { maySubmitLocalOrder, visibleLocalOrders, type IntakeSubmission } from './submissions';
import { deliverSharedOrder } from './delivery';
import { ApiError } from '../v2-api';

/** One foreground drain, backed by the native durable outbox. Native background delivery
 * uses the same clientSubmissionId, so simultaneous/lost replies converge server-side. */
export function useSharedOrder(ready: boolean) {
  const app = usePackProof();
  const [sharedOrder, setSharedOrder] = useState<SharedOrder | null>(null);
  const [submission, setSubmission] = useState<IntakeSubmission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const current = useRef(app); current.current = app;
  const active = useRef<SharedOrder | null>(null);
  const deferred = useRef(new Set<string>());
  const loading = useRef(false);
  const stoppedRetries = useRef(new Set<string>());
  const account = app.session?.userId ?? null;
  const scope = `${app.apiBaseUrl}:${account ?? ''}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const refresh = () => setRevision(value => value + 1);
  const retry = () => { stoppedRetries.current.clear(); refresh(); };
  const resume = () => { deferred.current.clear(); retry(); };

  useEffect(() => {
    const state = AppState.addEventListener('change', value => { setForeground(value === 'active'); if (value === 'active') { deferred.current.clear(); refresh(); } });
    const link = Linking.addEventListener('url', event => { if (/^packproof-v2:\/\/intake(?:[/?]|$)/.test(event.url)) refresh(); });
    const network = NetInfo.addEventListener(value => { if (value.isConnected && value.isInternetReachable !== false) refresh(); });
    return () => { state.remove(); link.remove(); network(); };
  }, []);
  useEffect(() => {
    active.current = null; deferred.current.clear(); stoppedRetries.current.clear(); setSharedOrder(null); setSubmission(null); setError(null);
  }, [scope]);
  useEffect(() => {
    if (!ready || !orderShare) return;
    let alive = true;
    void (account ? orderShare.setActiveAccount(account) : stopNativeIntakeSession()).then(async () => {
      if (account && alive && foreground) {
        await current.current.ensureAuth();
        current.current.client.assertCaptureAccount(account, current.current.apiBaseUrl);
        if (scopeRef.current !== scope) return;
        await refreshNativeIntakeSession(current.current.client, account, current.current.session?.email ?? current.current.session?.displayName ?? 'PackProof account');
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [ready, scope, foreground, revision]);

  useEffect(() => {
    if (!ready || !account || !foreground || !orderShare || loading.current) return;
    let alive = true;
    const native = orderShare, client = app.client;
    const sameAccount = () => alive && scopeRef.current === scope;
    loading.current = true;
    void (async () => {
      const rows = visibleLocalOrders(await native.listPending(), account);
      for (const receipt of rows) {
        if (!sameAccount()) return;
        if (deferred.current.has(receipt.id)) continue;
        let local: SharedOrder;
        try { local = await native.readOrder(receipt.id); } catch {
          if (!receipt.errorCode) continue;
          local = { ...receipt, text: '', payloadKind: 'TEXT', payloadHash: '', warnings: [] };
        }
        if (!sameAccount()) return;
        let accepted: IntakeSubmission | null = null;
        if (maySubmitLocalOrder(local, account) && !stoppedRetries.current.has(local.id)) {
          try {
            accepted = await deliverSharedOrder({ order: local, accountId: account,
              ensureAccount: async () => { await current.current.ensureAuth(); if (!sameAccount()) throw new Error('Account changed'); client.assertCaptureAccount(account, client.apiBaseUrl); },
              submit: envelope => { if (!sameAccount()) throw new Error('Account changed'); client.assertCaptureAccount(account, client.apiBaseUrl); return new IntakeApi(client).submit(envelope); },
              acknowledge: (id, serverId) => native.acknowledge(id, serverId),
            });
            local = { ...local, text: '', deliveryState: 'SERVER_ACCEPTED', serverSubmissionId: accepted.submissionId };
          } catch (reason) {
            const invalid = reason instanceof ApiError && [400, 403, 409, 413, 422].includes(reason.status);
            if (invalid) stoppedRetries.current.add(local.id);
            if (sameAccount() && (!active.current || active.current.id === local.id)) setError(invalid ? 'Saved on this device. The shared content could not be added. Check the details or enter the order yourself.' : 'Saved on this device. We could not finish adding it. Reconnect or sign in again, then retry.');
          }
        } else if (local.deliveryState === 'SERVER_ACCEPTED' && local.serverSubmissionId) {
          try { await current.current.ensureAuth(); if (!sameAccount()) return; client.assertCaptureAccount(account, client.apiBaseUrl); accepted = await new IntakeApi(client).submission(local.serverSubmissionId); }
          catch { /* Retain its receipt until the authorized server can be read again. */ }
        }
        if (!sameAccount()) return;
        if (accepted?.state === 'DISMISSED') { await native.discard(local.id); continue; }
        if (!active.current || active.current.id === local.id) {
          active.current = local; setSharedOrder(local); setSubmission(accepted);
          if (accepted) setError(null);
        }
      }
    })().catch(() => { if (sameAccount()) setError('Saved orders could not be read. Open PackProof again to retry.'); })
      .finally(() => { loading.current = false; if (!alive) refresh(); });
    return () => { alive = false; };
  }, [ready, scope, revision, foreground]);

  // Short foreground retries cover transient connectivity and server-pending resolution.
  useEffect(() => {
    if (!foreground || !account || !sharedOrder || stoppedRetries.current.has(sharedOrder.id) || (submission && !['RECEIVED', 'RESOLVING'].includes(submission.state))) return;
    const timer = setTimeout(refresh, 15000); return () => clearTimeout(timer);
  }, [foreground, account, sharedOrder, submission, revision]);

  async function assign() {
    const local = active.current;
    if (!account || !local || local.accountId !== null || !orderShare) return;
    setBusy(true);
    try {
      current.current.client.assertCaptureAccount(account, current.current.apiBaseUrl);
      await orderShare.assignAccount(local.id, account);
      if (scopeRef.current !== scope) return;
      active.current = { ...local, accountId: account }; setSharedOrder(active.current); setError(null); refresh();
    } catch { setError('The account changed. Sign in to the intended account and try again.'); }
    finally { setBusy(false); }
  }
  async function defer() {
    const local = active.current;
    if (local) {
      deferred.current.add(local.id);
      // The accepted server workflow remains in the account queue; only its native receipt is removed.
      if (local.deliveryState === 'SERVER_ACCEPTED') await orderShare?.discard(local.id);
    }
    active.current = null; setSharedOrder(null); setSubmission(null); setError(null); refresh();
  }
  async function discard() {
    const local = active.current;
    if (!local) return;
    if (local.serverSubmissionId && account && submission?.state !== 'READY') {
      await current.current.ensureAuth(); current.current.client.assertCaptureAccount(account, current.current.apiBaseUrl);
      await new IntakeApi(current.current.client).dismissSubmission(local.serverSubmissionId);
    }
    await orderShare?.discard(local.id);
    active.current = null; setSharedOrder(null); setSubmission(null); setError(null); refresh();
  }
  async function paste(text: string) {
    if (!orderShare) throw new Error('Install the latest PackProof app to save shared orders. You can still enter order details manually.');
    await orderShare.setActiveAccount(account);
    const local = await orderShare.enqueue(text, 'TEXT', 'EXPLICIT_PASTE');
    if (scopeRef.current !== scope) return;
    active.current = local; setSharedOrder(local); setSubmission(null); setError(null); refresh();
  }
  return { sharedOrder, submission, error, busy, assign, defer, discard, paste, refresh: retry, resume, setSubmission };
}
export type SharedOrderCoordinator = ReturnType<typeof useSharedOrder>;
