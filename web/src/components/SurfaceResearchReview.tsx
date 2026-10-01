import { useMemo, useState, useEffect } from 'react';
import type { PackProofApi } from '../api/client';
import type { SurfaceTransport } from '../api/surface-types';
import { SurfaceFingerprintPanel } from './SurfaceFingerprintPanel';

export const surfaceReviewEnabled = () => import.meta.env.VITE_SURFACE_FINGERPRINT_REVIEW === 'true' && ['development', 'research', 'rnd', 'test'].includes(import.meta.env.MODE);
const toggleEvent = 'packproof:research-review-setting';
const toggleKey = 'packproof.rnd.surface-review';
function reviewerEnabled() { try { return sessionStorage.getItem(toggleKey) === 'true'; } catch { return false; } }

export function ResearchBuildBanner() {
  const [enabled, setEnabled] = useState(reviewerEnabled);
  if (import.meta.env.VITE_PACKPROOF_RESEARCH_BUILD !== 'true') return null;
  return <aside className="surface-build-banner" aria-label="Research build"><strong>PackProof R&amp;D</strong><span>Experimental build · no qualified physical findings</span>{surfaceReviewEnabled() && <label><input type="checkbox" checked={enabled} onChange={event => { const value = event.target.checked; setEnabled(value); try { sessionStorage.setItem(toggleKey, String(value)); } catch { /* stays off if storage is unavailable */ } window.dispatchEvent(new Event(toggleEvent)); }} />Enable surface research panels</label>}</aside>;
}

export function SurfaceResearchReview({ proofId, api }: { proofId: string; api: PackProofApi }) {
  const [reviewEnabled, setReviewEnabled] = useState(reviewerEnabled);
  useEffect(() => { const sync = () => setReviewEnabled(reviewerEnabled()); window.addEventListener(toggleEvent, sync); return () => window.removeEventListener(toggleEvent, sync); }, []);
  const transport = useMemo<SurfaceTransport>(() => ({
    read: id => api.getSurfaceResearch(id),
    compare: (id, input) => api.compareSurfaceResearch(id, input),
    export: async id => {
      const blob = await api.exportSurfaceResearch(id); const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `PackProof-RnD-${id}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    source: async (id, source) => { const url = URL.createObjectURL(await api.getSurfaceOriginal(id, source.sourceId)); return { url, release: () => URL.revokeObjectURL(url) }; },
    saveSource: async (id, source) => { const url = URL.createObjectURL(await api.getSurfaceOriginal(id, source.sourceId)); const link = document.createElement('a'); link.href = url; link.download = `surface-${source.sourceId}${source.contentType === 'image/png' ? '.png' : '.jpg'}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); },
  }), [api]);
  return <SurfaceFingerprintPanel key={`${proofId}.${api.recoveryScope}`} enabled={surfaceReviewEnabled() && reviewEnabled} proofId={proofId} transport={transport} />;
}
