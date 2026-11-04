import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { randomId } from '../random-id';
import { displayState, stateTone } from './model';

export function workflowError(error: unknown): string { return error instanceof Error ? error.message : 'The request could not be confirmed. Retry using the same choices.'; }
export function workflowDate(value?: string | null): string { return value ? new Date(value).toLocaleString() : 'Not reported'; }
export function WorkflowStatus({ state }: { state: string }) { return <span className={`records-status ${stateTone(state)}`}>{displayState(state)}</span>; }

/** Responses are visible only within the API and scoped path that requested them. */
export function useWorkflowData<T>(api: PackProofApi, path: string | null, revision = 0, pollWhen?: (value: T) => boolean) {
  const [state, setState] = useState<{ api: PackProofApi; path: string; data: T | null; error: string | null; loading: boolean } | null>(null);
  const poll = useRef(pollWhen); poll.current = pollWhen;
  useEffect(() => {
    if (!path) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    setState(previous => ({ api, path, data: previous?.api === api && previous.path === path ? previous.data : null, error: null, loading: true }));
    async function load() {
      try {
        const data = await api.recordsRequest<T>(path!);
        if (!active) return;
        setState({ api, path: path!, data, error: null, loading: false });
        if (poll.current?.(data)) timer = setTimeout(() => void load(), 2000);
      } catch (error) {
        if (active) setState(previous => ({ api, path: path!, data: previous?.api === api && previous.path === path ? previous.data : null, error: workflowError(error), loading: false }));
      }
    }
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, path, revision]);
  return path && state?.api === api && state.path === path ? state : { data: null, error: null, loading: !!path };
}

/** A failed response preserves the command identity; changed choices receive a new key. */
export function useWorkflowCommand(api: PackProofApi, boundary: string) {
  const [state, setState] = useState({ boundary, busy: false, error: null as string | null });
  const current = useRef({ boundary, generation: 0 });
  if (current.current.boundary !== boundary) current.current = { boundary, generation: current.current.generation + 1 };
  useEffect(() => { const target = current.current; return () => { if (current.current === target) current.current = { ...target, generation: target.generation + 1 }; }; }, [api, boundary]);
  const receipt = useRef({ fingerprint: '', key: '' }), pending = useRef(false);
  async function run<T>(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<T | null> {
    if (pending.current) return null;
    const target = current.current, fingerprint = JSON.stringify({ boundary, path, body, headers, method });
    if (receipt.current.fingerprint !== fingerprint) receipt.current = { fingerprint, key: randomId() };
    pending.current = true; setState({ boundary, busy: true, error: null });
    try { const value = await api.recordsRequest<T>(path, method, body, { 'Idempotency-Key': receipt.current.key, ...headers }); if (current.current !== target) return null; setState({ boundary, busy: false, error: null }); return value; }
    catch (error) { if (current.current === target) setState({ boundary, busy: false, error: workflowError(error) }); return null; }
    finally { pending.current = false; }
  }
  return { ...(state.boundary === boundary ? state : { busy: false, error: null }), run };
}
