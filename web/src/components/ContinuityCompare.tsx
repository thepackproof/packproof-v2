import { useEffect, useState } from "react";
import {
  comparisonPairs,
  comparisonSlotLabel,
  continuityResultLabel,
  type ComparisonPair,
} from "@packproof/copy/custody";
import type { CanonicalProof } from "../api/types";

export function ContinuityCompare(props: {
  proof: CanonicalProof;
  loadEvidence?: (evidenceId: string) => Promise<Blob>;
}) {
  const latest = props.proof.continuityObservations?.[props.proof.continuityObservations.length - 1];
  const pairs = comparisonPairs({
    continuity: props.proof.continuityObservations,
    observations: props.proof.observations,
  });
  if (pairs.length === 0 && !latest) {
    return null;
  }

  return (
    <section className="section stack">
      <h2>Before sending versus when received</h2>
      {latest ? (
        <>
          <p className="card-title">{continuityResultLabel(latest.result)}</p>
          <p>{latest.summary}</p>
        </>
      ) : (
        <p className="note">Compare these captures. PackProof records them; it does not judge what they depict.</p>
      )}
      {pairs.map((pair) => (
        <ComparisonRow
          key={pair.slot}
          pair={pair}
          proofId={props.proof.proofId}
          contentTypeById={contentTypes(props.proof)}
          loadEvidence={props.loadEvidence}
        />
      ))}
    </section>
  );
}

function ComparisonRow(props: {
  pair: ComparisonPair;
  proofId: string;
  contentTypeById: Map<string, string>;
  loadEvidence?: (evidenceId: string) => Promise<Blob>;
}) {
  return (
    <div>
      <p className="kicker">{comparisonSlotLabel(props.pair.slot)}</p>
      <div className="grid-2">
        <CaptureFrame
          heading="Before sending"
          evidenceId={props.pair.originEvidenceId}
          contentType={props.pair.originEvidenceId ? props.contentTypeById.get(props.pair.originEvidenceId) : undefined}
          loadEvidence={props.loadEvidence}
        />
        <CaptureFrame
          heading="When received"
          evidenceId={props.pair.receivedEvidenceId}
          contentType={props.pair.receivedEvidenceId ? props.contentTypeById.get(props.pair.receivedEvidenceId) : undefined}
          loadEvidence={props.loadEvidence}
        />
      </div>
    </div>
  );
}

function CaptureFrame(props: {
  heading: string;
  evidenceId: string | null;
  contentType?: string;
  loadEvidence?: (evidenceId: string) => Promise<Blob>;
}) {
  const media = useEvidenceObjectUrl(props.evidenceId, props.loadEvidence);
  return (
    <article className="continuity-frame">
      <p className="meta">{props.heading}</p>
      {props.evidenceId && media.url ? (
        isVideo(props.contentType) ? (
          <video src={media.url} controls playsInline />
        ) : (
          <img src={media.url} alt={props.heading} />
        )
      ) : props.evidenceId && !props.loadEvidence ? (
        <p className="continuity-missing">Capture is recorded.</p>
      ) : props.evidenceId && media.error ? (
        <p className="continuity-missing">Capture is recorded. It could not be displayed here.</p>
      ) : props.evidenceId ? (
        <p className="continuity-missing">Loading capture…</p>
      ) : (
        <p className="continuity-missing">No PackProof observation exists for this capture.</p>
      )}
    </article>
  );
}

function useEvidenceObjectUrl(
  evidenceId: string | null,
  loadEvidence?: (evidenceId: string) => Promise<Blob>,
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!evidenceId || !loadEvidence) {
      setUrl(null);
      setError(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(false);
    void loadEvidence(evidenceId)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [evidenceId, loadEvidence]);

  return { url, error };
}

function contentTypes(proof: CanonicalProof): Map<string, string> {
  return new Map(
    proof.evidence
      .filter((row) => row.evidenceId && row.contentType)
      .map((row) => [row.evidenceId, row.contentType as string]),
  );
}

function isVideo(contentType?: string): boolean {
  return (contentType ?? "").startsWith("video/");
}
