import { useEffect, useMemo, useState } from 'react';
import { SurfaceFingerprintPanel } from '../../../web/src/components/SurfaceFingerprintPanel';
import type { SurfaceTransport } from '../../../web/src/api/surface-types';

export function SurfaceResearchReview({ proofId }: { proofId: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { let alive = true; void window.packproof.system.state().then(system => { if (alive) setEnabled(system.research?.surfaceReview === true); }).catch(() => {}); return () => { alive = false; }; }, []);
  const transport = useMemo<SurfaceTransport>(() => ({
    read: id => window.packproof.surfaces.read(id),
    compare: (id, input) => window.packproof.surfaces.compare(id, input),
    export: async id => { const result = await window.packproof.surfaces.export(id); if (!result.saved) throw new Error('Research export was canceled.'); },
    source: async (id, source) => ({ url: await window.packproof.surfaces.sourceUrl(id, source.sourceId) }),
    saveSource: async (id, source) => { const result = await window.packproof.surfaces.saveSource(id, source.sourceId); if (!result.saved) throw new Error('Saving the selected original was canceled.'); },
  }), []);
  return <SurfaceFingerprintPanel key={proofId} proofId={proofId} enabled={enabled} transport={transport} platform="desktop" />;
}
