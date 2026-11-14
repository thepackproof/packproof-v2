import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { PackProofApi } from '../api/client';
import type { OperationalCaseDetail, ProofPagination } from './operational-types';
import { useWorkflowData } from './workflow';

/** The case reader signs this separate cursor for currently authorized Proofs.
 * Loading another page never treats an unrequested page as restricted access. */
export function CaseProofs({ api, caseId, query, initialIds, initialPagination, initiallyRestricted, renderProof, onRefresh }: { api: PackProofApi; caseId: string; query: string; initialIds: string[]; initialPagination?: ProofPagination; initiallyRestricted: boolean; renderProof: (id: string) => ReactNode; onRefresh: () => void }) {
  const [ids, setIds] = useState(initialIds), [nextCursor, setNextCursor] = useState(initialPagination?.nextCursor || null), [restricted, setRestricted] = useState(initiallyRestricted);
  const [cursor, setCursor] = useState<string | null>(null), [attempt, setAttempt] = useState(0), [changed, setChanged] = useState(false);
  const request = new URLSearchParams(query); request.set('section', 'proofs'); request.set('limit', String(initialPagination?.limit || 50)); if (cursor) request.set('cursor', cursor);
  const result = useWorkflowData<OperationalCaseDetail>(api, cursor ? `/cases/${encodeURIComponent(caseId)}?${request}` : null, attempt);
  useEffect(() => {
    if (!cursor || !result.data || result.loading) return;
    const page = result.data.proofPagination;
    if (!initialPagination || !page || result.data.case.id !== caseId || page.projectionVersion !== initialPagination?.projectionVersion || page.limit !== initialPagination.limit || page.total !== initialPagination.total) { setChanged(true); return; }
    setIds(previous => [...new Set([...previous, ...(result.data!.case.proofIds || [])])]);
    setRestricted(previous => previous || result.data!.case.restrictedMembers === true);
    setNextCursor(page.nextCursor); setCursor(null);
  }, [cursor, result.data, result.loading, caseId, initialPagination]);
  function loadMore() { if (nextCursor && !result.loading && !changed) { setCursor(nextCursor); setAttempt(value => value + 1); } }
  if (!ids.length && !restricted && !initialPagination) return null;
  return <div className="case-proof-memberships">{initialPagination && <p>{ids.length.toLocaleString()} of {initialPagination.total.toLocaleString()} permitted Proofs shown</p>}{!!ids.length && <div className="records-actions">{ids.map(id => <Fragment key={id}>{renderProof(id)}</Fragment>)}</div>}{restricted && <p>Additional related shipment records are outside your current access.</p>}{result.loading && <p role="status">Loading more permitted Proofs…</p>}{changed ? <div role="alert"><p>The authorized Proof membership changed. Refresh the case before continuing.</p><button className="records-button secondary" onClick={onRefresh}>Refresh Proof membership</button></div> : result.error ? <div role="alert"><p>{result.error}</p><button className="records-button secondary" onClick={loadMore}>Retry Proof page</button></div> : nextCursor && <button className="records-button secondary" disabled={result.loading} onClick={loadMore}>Show more Proofs</button>}</div>;
}
