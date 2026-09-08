import { randomId } from "../random-id";
import { useEffect, useRef, useState, type RefObject } from "react";
export type CaptureBookmark = { id: string; label: string; startMs: number; sourceType: "USER_MARKED" | "SCANNER_TRIGGERED"; recipeVersion?:string };
const recipes:Record<string,string[]>={universal:["Item front","Item reverse","Identifier","Packing","Closed box","Shipping label"],collectible:["Front surface","Reverse surface","Edges and corners","Identifier","Packing","Closed box","Shipping label"],electronics:["Device front","Ports and reverse","Serial identifier","Included accessories","Packing","Closed box","Shipping label"]};
export function CaptureCoach({ video, recording, startedAt, bookmarks, onBookmark }: {
  video: RefObject<HTMLVideoElement | null>; recording: boolean; startedAt: number;
  bookmarks: CaptureBookmark[]; onBookmark: (mark: CaptureBookmark) => void;
}) {
  const [recipe,setRecipe]=useState("universal"),[scan,setScan]=useState(""),[scanNotice,setScanNotice]=useState("");
  const steps=recipes[recipe];
  const [enabled, setEnabled] = useState(true);
  const [hint, setHint] = useState("");
  const [slow, setSlow] = useState(false);
  const lastHint = useRef(0);
  useEffect(() => {
    if (!enabled || !recording || !window.Worker) return;
    const worker = new Worker(new URL("../coach-worker.ts", import.meta.url), { type: "module" });
    const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 72;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let waiting = false;
    const timer = window.setInterval(() => {
      if (waiting || document.hidden || !context || !video.current?.videoWidth) return;
      const start = performance.now();
      try {
        context.drawImage(video.current, 0, 0, 96, 72);
        const data = context.getImageData(0, 0, 96, 72);
        if (performance.now() - start > 25) { setSlow(true); setEnabled(false); return; }
        waiting = true; worker.postMessage({ pixels: data.data, width: 96, height: 72 }, [data.data.buffer]);
      } catch { setEnabled(false); }
    }, 1500);
    worker.onmessage = ({ data }: MessageEvent<{ brightness: number; detail: number }>) => {
      waiting = false;
      if (performance.now() - lastHint.current < 5000) return;
      lastHint.current = performance.now();
      setHint(data.brightness < 45 ? "The frame looks dim. More light may help." : data.brightness > 230 ? "The frame looks very bright. Check for glare." : data.detail < 3 ? "Few details are visible. Check focus and hold steady." : "");
    };
    worker.onerror = () => setEnabled(false);
    return () => { clearInterval(timer); worker.terminate(); };
  }, [enabled, recording, video]);
  return <section className="capture-coach" aria-label="Capture Coach"><div className="section-head"><strong>Capture Coach</strong><button type="button" aria-pressed={enabled} onClick={() => { setEnabled(!enabled); setHint(""); }}>{enabled ? "Turn hints off" : "Turn hints on"}</button></div>
    <label className="field"><span>Views for this item · same evidence standard</span><select value={recipe} onChange={e=>setRecipe(e.target.value)}><option value="universal">General shipment</option><option value="collectible">Collectible</option><option value="electronics">Electronics</option></select></label>
    <p>{recording ? "Keep the item and packing in view. Mark useful moments as you go." : "Show the item, its identifier, the packing, and the closed box. Avoid private address details where practical."}</p>
    {hint && enabled && <p className="coach-hint" role="status">{hint}</p>}{slow && <p>Hints paused to keep recording responsive.</p>}
    <div className="coach-steps">{steps.map(label => <button type="button" key={label} disabled={!recording} aria-pressed={bookmarks.some(m => m.label === label)} onClick={() => onBookmark({ id: randomId(), label, startMs: Math.max(0, Math.round(performance.now()-startedAt)), sourceType: "USER_MARKED",recipeVersion:`packproof-${recipe}-v1` })}>{label}{bookmarks.some(m => m.label === label) ? " · marked" : ""}</button>)}</div>
    {recording&&<form className="row" onSubmit={e=>{e.preventDefault();if(!scan.trim())return;onBookmark({id:randomId(),label:"Barcode read · confirm identifier in original",startMs:Math.max(0,Math.round(performance.now()-startedAt)),sourceType:"SCANNER_TRIGGERED",recipeVersion:`packproof-${recipe}-v1`});setScanNotice("Scanner input read. Check it against the visible item; it is not proof of identity or contents.");setScan("");}}><label className="field"><span>Barcode scanner input · Enter to mark this moment</span><input value={scan} onChange={e=>setScan(e.target.value)} maxLength={200} autoComplete="off"/></label><button type="submit" disabled={!scan.trim()}>Mark scanner read</button></form>}{scanNotice&&<p role="status">{scanNotice}</p>}
    <small>Optional guidance and your bookmarks. These do not verify the item or finish a required step.</small>
  </section>;
}
