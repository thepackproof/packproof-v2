import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { Glyph } from '../site/Brand';
export function RecordThumbnail({api,proofId,derivativeId}:{api?:PackProofApi;proofId:string;derivativeId?:string|null}) {
  const element=useRef<HTMLSpanElement>(null),[visible,setVisible]=useState(false),[url,setUrl]=useState<string|null>(null);
  useEffect(()=>{
    if(!element.current)return;
    if(!('IntersectionObserver' in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'100px'});
    observer.observe(element.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!api||!derivativeId||!visible)return;
    let active=true,objectUrl:string|undefined;setUrl(null);
    void api.featureDownload(proofId,`disclosure/thumbnails/${encodeURIComponent(derivativeId)}/media`).then(blob=>{
      if(active){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}
    }).catch(()=>{ /* An optional preview never blocks opening the original. */ });
    return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[api,proofId,derivativeId,visible]);
  return <span ref={element} className="record-thumbnail">{url?<img src={url} alt="Preview from the packing recording"/>:<Glyph name="film" size={26}/>}<span className="record-thumbnail-play" aria-hidden="true">▶</span></span>;
}
