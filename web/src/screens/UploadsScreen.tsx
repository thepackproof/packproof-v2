import type { ReactNode } from "react";
import type { LocalRecordingSummary } from "../capture-queue";
import { Glyph } from "../site/Brand";
import "./workstation-secondary.css";

export interface UploadsScreenProps {
  recordings: LocalRecordingSummary[];
  loading?: boolean;
  error?: string | null;
  recoveryPanel?: ReactNode;
  onRefresh: () => void;
  onOpenStation: () => void;
}

export function UploadsScreen(props: UploadsScreenProps) {
  const pending = props.recordings.filter(recording => !(recording.finalized && recording.preserved));
  const review = pending.filter(recording => !recording.accepted || recording.errorMessage || recording.retryStopped);
  const totalBytes = props.recordings.reduce((total, recording) => total + (recording.file?.size || 0), 0);
  return <main className="page workstation-secondary uploads-page" aria-busy={props.loading}>
    <header className="workspace-heading secondary-heading"><div><span className="secondary-eyebrow">YOUR WORKSTATION</span><h1 className="page-title">Uploads</h1><p>Local recordings and their progress to a completed Proof.</p></div><button className="btn btn-secondary" disabled={props.loading} onClick={props.onRefresh}>Refresh</button></header>
    <section className="secondary-upload-summary">
      <div><span className="secondary-eyebrow">SAVED ON THIS BROWSER</span><h2>{props.loading ? "Checking saved recordings…" : props.error ? "Saved recordings unavailable" : `${pending.length} recording${pending.length === 1 ? "" : "s"} pending`}</h2><p>Confirmed recordings resume uploading when this browser is open and online. Keep local originals until preservation is confirmed.</p></div>
      {!props.loading && !props.error && <div className="secondary-storage-summary"><strong>{(totalBytes / 1_000_000).toFixed(1)} MB</strong><span>{props.recordings.length} saved original{props.recordings.length === 1 ? "" : "s"}</span></div>}
    </section>
    {props.error && <div className="secondary-load-error" role="alert"><strong>Saved recordings could not be loaded</strong><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRefresh}>Try again</button></div>}
    {!props.loading && !props.error && review.length > 0 && <div className="secondary-attention-note" role="status"><Glyph name="alert" size={20} /><p>{review.length} recording{review.length === 1 ? " needs" : "s need"} attention. Open the saved recordings below to review the next step.</p></div>}
    {(props.recoveryPanel || props.loading || (!props.error && props.recordings.length === 0)) && <section className="secondary-panel secondary-recovery" aria-label="Local recording queue">
      {props.loading && <p className="secondary-loading" role="status">Loading local recordings…</p>}
      {props.recoveryPanel}
      {!props.loading && !props.error && props.recordings.length === 0 && <div className="secondary-empty" role="status"><span className="secondary-empty-icon"><Glyph name="download" size={26} /></span><h2>No saved recordings in this browser</h2><p>Record a shipment in the Packing Station. Saved originals and upload recovery will appear here.</p><button className="btn btn-secondary" onClick={props.onOpenStation}>Open Packing Station<Glyph name="arrow" size={16} /></button></div>}
    </section>}
    <p className="secondary-footnote"><Glyph name="info" size={17} />Clearing browser data can remove recordings that are saved only on this device.</p>
  </main>;
}
