import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import { listRecoverableRecordings, removePreservedLocalRecording, type LocalRecordingSummary } from "../capture-queue";

export function RecordingsSettingsPanel({ api, userId, onOpenProof }: { api: PackProofApi; userId: string; onOpenProof: (proofId: string) => void }) {
  const [items, setItems] = useState<LocalRecordingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setItems(null); setError(null); setBusy(false);
    const refresh = () => { void listRecoverableRecordings(userId, api).then(next => { if (current === generation.current) setItems(next); }).catch(() => { if (current === generation.current) setError("Local recordings could not be checked. Keep this browser's data and try again."); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { generation.current++; window.removeEventListener("focus", refresh); };
  }, [api, userId]);
  const pendingUploads = items?.filter(item => item.accepted && !item.committed && !item.submitted && !item.finalized).length ?? 0;
  const awaitingReview = items?.filter(item => !item.accepted && !item.committed && !item.submitted && !item.finalized).length ?? 0;
  const finishing = items?.filter(item => (item.committed || item.submitted) && !item.finalized).length ?? 0;
  const retained = items?.filter(item => item.finalized).length ?? 0;
  return <div className="stack">
    <p className="note">These are copies held in this browser for your account. Clearing browser data or losing this device can remove work that has not been preserved by PackProof.</p>
    {error && <p role="alert" className="banner banner-error">{error}</p>}
    {items === null ? <p role="status">Checking local recordings…</p> : <>
      <p>{pendingUploads === 0 ? "No recordings waiting to upload" : `${pendingUploads} ${pendingUploads === 1 ? "recording" : "recordings"} waiting to upload`}</p>
      {awaitingReview > 0 && <p>{awaitingReview} {awaitingReview === 1 ? "recording needs" : "recordings need"} review before upload.</p>}
      {finishing > 0 && <p>{finishing} {finishing === 1 ? "recording needs" : "recordings need"} confirmation or final saving.</p>}
      <p className="meta">{retained} completed local {retained === 1 ? "copy" : "copies"} retained · {(items.reduce((sum, item) => sum + item.file.size, 0) / 1_000_000).toFixed(1)} MB total</p>
      <ul className="recording-settings-list">{items.map((item, index) => <li className="stack" key={item.key}>
        <strong>Recording {index + 1} · {(item.file.size / 1_000_000).toFixed(1)} MB</strong>
        <p className="meta">{item.finalized && item.preserved ? "Proof saved; completed local copy retained" : item.finalized ? "Proof finalized; preservation still needs confirmation" : item.submitted ? "Submitted; final saving needs confirmation" : item.committed ? "Recording received; finish saving this Proof" : item.accepted ? "Upload pending" : "Review and confirmation needed"}</p>
        {item.errorMessage && <p className="note">Saving needs attention. Open the Proof to continue.</p>}
        <div className="btn-row"><button className="btn btn-secondary" type="button" onClick={() => onOpenProof(item.proofId)}>Open Proof</button>
          <button className="btn btn-secondary" type="button" onClick={() => { const url = URL.createObjectURL(item.file); const link = document.createElement("a"); link.href = url; link.download = `packproof-local-recording.${item.file.type.includes("mp4") ? "mp4" : "webm"}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export local original</button>
          {item.finalized && item.preserved && <button className="btn btn-tertiary" type="button" disabled={busy} onClick={async () => {
            const current = generation.current; setBusy(true); setError(null);
            try { await removePreservedLocalRecording(userId, item.key, api); const next = await listRecoverableRecordings(userId, api); if (current === generation.current) setItems(next); }
            catch { if (current === generation.current) setError("This copy could not be removed safely. Keep it and try again."); }
            finally { if (current === generation.current) setBusy(false); }
          }}>Remove completed local copy</button>}
        </div>
      </li>)}</ul>
    </>}
  </div>;
}
