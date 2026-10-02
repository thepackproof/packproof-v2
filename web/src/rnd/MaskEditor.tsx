import {useEffect,useRef,useState} from 'react';
import type {SourcePreview} from './types';
export interface Mask {x:number;y:number;width:number;height:number;}
export function MaskEditor({source,onSubmit,disabled}:{source:SourcePreview;onSubmit:(masks:Mask[],kind:'still'|'video')=>void;disabled:boolean}) {
 const [masks,setMasks]=useState<Mask[]>([]);const [rect,setRect]=useState<Mask>({x:0,y:0,width:100,height:100});const [dimensions,setDimensions]=useState({width:0,height:0});const image=useRef<HTMLImageElement>(null);const video=useRef<HTMLVideoElement>(null);
 useEffect(()=>{setMasks([]);setDimensions({width:0,height:0});},[source.url]);
 const valid=[rect.x,rect.y,rect.width,rect.height].every(Number.isSafeInteger)&&rect.x>=0&&rect.y>=0&&rect.width>0&&rect.height>0&&rect.x+rect.width<=dimensions.width&&rect.y+rect.height<=dimensions.height;
 return <div className="rnd-mask-editor"><h3>Privacy mask review</h3><p>Opaque rectangles apply to the original pixel coordinates. For video, these masks cover the same area throughout the clip; inspect the full preview for moving private details. Audio is removed.</p>
  <div style={{position:'relative',display:'inline-block',maxWidth:'100%'}}>{source.mimeType.startsWith('image')?<img ref={image} src={source.url} alt="Original being reviewed for redaction" style={{display:'block',maxWidth:'100%',maxHeight:480}} onLoad={()=>setDimensions({width:image.current?.naturalWidth??0,height:image.current?.naturalHeight??0})}/>:<video ref={video} src={source.url} controls style={{display:'block',maxWidth:'100%',maxHeight:480}} onLoadedMetadata={()=>setDimensions({width:video.current?.videoWidth??0,height:video.current?.videoHeight??0})}/>}
  {dimensions.width>0&&masks.map((mask,i)=><span key={i} aria-label={`Mask ${i+1}`} style={{position:'absolute',pointerEvents:'none',background:'rgba(0,0,0,.85)',outline:'2px solid #1769d2',left:`${100*mask.x/dimensions.width}%`,top:`${100*mask.y/dimensions.height}%`,width:`${100*mask.width/dimensions.width}%`,height:`${100*mask.height/dimensions.height}%`}}/>)}</div>
  <p>Original dimensions: {dimensions.width} × {dimensions.height} pixels.</p><div className="rnd-actions">{(['x','y','width','height'] as const).map(key=><label key={key}>{key}<input aria-label={`Mask ${key}`} style={{width:85,display:'block'}} type="number" min={key==='width'||key==='height'?1:0} value={rect[key]} onChange={e=>setRect({...rect,[key]:Number(e.target.value)})}/></label>)}</div>
  <button disabled={disabled||!valid||masks.length>=32} onClick={()=>setMasks([...masks,rect])}>Add opaque mask</button>{masks.length>0&&<button disabled={disabled} onClick={()=>setMasks(masks.slice(0,-1))}>Remove last mask</button>}
  <p>Masking an identifier, seal, or condition region may prevent a recipient from evaluating the related observation.</p>
  <button disabled={disabled||masks.length===0} onClick={()=>onSubmit(masks,source.mimeType.startsWith('image')?'still':'video')}>Create derivative for review</button>
 </div>;
}
