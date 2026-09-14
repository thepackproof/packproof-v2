import { useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { orderShare, type SharedOrder } from '../../modules/packproof-order-share';

/** Keep native source files until review succeeds or the person explicitly discards them.
 * Leaving the screen is a deferral; app termination also leaves the inbox intact. */
export function useSharedOrder(enabled: boolean) {
  const [sharedOrder, setSharedOrder] = useState<SharedOrder | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<SharedOrder | null>(null);
  const deferred = useRef(new Set<string>());
  const loading = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!orderShare) return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') { deferred.current.clear(); setRevision(value => value + 1); }
    });
    return () => listener.remove();
  }, []);

  useEffect(() => {
    if (!enabled || !orderShare || active.current || loading.current) return;
    let disposed = false;
    const native = orderShare;
    loading.current = true;
    void native.listPending().then(async pending => {
      const next = pending.find(item => !deferred.current.has(item.id));
      if (!next || disposed || !enabledRef.current) return;
      try {
        const order = await native.readOrder(next.id);
        // A recording/login/navigation may have started while text recognition ran.
        if (disposed || !enabledRef.current) return;
        active.current = order; setSharedOrder(order);
      } catch {
        deferred.current.add(next.id);
        if (disposed || !enabledRef.current) return;
        Alert.alert('Shared order needs attention', 'We could not read this shared order. It is still saved on this device. Try again, or discard it and share the original again.', [
          { text: 'Later', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => {
            void native.acknowledge(next.id).then(() => setRevision(value => value + 1))
              .catch(() => Alert.alert('Could not discard', 'Open PackProof again and try discarding this shared order.'));
          } },
          { text: 'Try again', onPress: () => { deferred.current.delete(next.id); setRevision(value => value + 1); } },
        ]);
      }
    }).catch(() => {
      // Availability/locked-device errors are retried on the next foreground transition.
    }).finally(() => {
      loading.current = false;
      // If a screen changed during recognition, schedule a fresh read on the allowed route.
      if (disposed && enabledRef.current) setRevision(value => value + 1);
    });
    return () => { disposed = true; };
  }, [enabled, revision]);

  function defer() {
    if (active.current) deferred.current.add(active.current.id);
    active.current = null; setSharedOrder(null);
  }

  async function acknowledge() {
    const order = active.current;
    if (order && orderShare) await orderShare.acknowledge(order.id);
    active.current = null; setSharedOrder(null);
    // Advance to another queued item only when navigation reaches a permitted screen.
    setRevision(value => value + 1);
  }

  return { sharedOrder, acknowledge, defer };
}
