import {useEffect,useMemo,useState} from 'react';
import type {SourcePreview} from './types';
type Point={xyz:number[];color:number[];observations:Array<{sourceRef:{sourceId:string}}>};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function ArtifactPreview({source,onSource}:{source:SourcePreview;onSource:(id:string)=>void}) {
 const [data,setData]=useState<Record<string,unknown>|null>(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setData(null);setError('');
  if(!source.mimeType.includes('json')){setError('This artifact does not have an inline preview. Use the research archive to inspect it.');return;}
  void (async()=>{const response=await fetch(source.url,{signal:controller.signal});if(!response.ok)throw new Error('Artifact unavailable.');const blob=await response.blob();if(blob.size>16*1024*1024)throw new Error('Artifact exceeds the preview limit.');const parsed=object(JSON.parse(await blob.text()));if(!controller.signal.aborted)setData(parsed);})().catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Artifact unavailable.');});
  return()=>controller.abort();
 },[source.url,source.mimeType]);
 if(error)return <p role="status">{error}</p>;
 if(!data)return <p role="status">Loading artifact…</p>;
 if(data.schemaVersion==='packproof.sparse-geometry.v1')return <SparseGeometry data={data} onSource={onSource}/>;
 return <pre aria-label="Derived artifact data">{JSON.stringify(data,null,2)}</pre>;
}
function SparseGeometry({data,onSource}:{data:Record<string,unknown>;onSource:(id:string)=>void}) {
 const [yaw,setYaw]=useState(30),[pitch,setPitch]=useState(15),[mode,setMode]=useState('rotate'),[selected,setSelected]=useState<number|null>(null);
 const points=useMemo(()=>Array.isArray(data.points)?(data.points as Point[]).filter(p=>Array.isArray(p.xyz)&&p.xyz.length===3&&p.xyz.every(Number.isFinite)).slice(0,20000):[],[data]);
 const geometry=useMemo(()=>{if(!points.length)return [];
  const center=[0,1,2].map(axis=>(Math.min(...points.map(p=>p.xyz[axis]))+Math.max(...points.map(p=>p.xyz[axis])))/2);
  const extent=Math.max(...points.flatMap(p=>p.xyz.map((value,axis)=>Math.abs(value-center[axis]))),1e-9);
  const y=yaw*Math.PI/180,p=pitch*Math.PI/180;
  return points.map((point,index)=>{const [x,v,z]=point.xyz.map((n,a)=>(n-center[a])/extent);const rx=x*Math.cos(y)+z*Math.sin(y),rz=-x*Math.sin(y)+z*Math.cos(y);const ry=v*Math.cos(p)-rz*Math.sin(p);
   const xy=mode==='xy'?[x,v]:mode==='xz'?[x,z]:mode==='yz'?[v,z]:[rx,ry];
   const rgb=Array.isArray(point.color)?point.color.slice(0,3).map(n=>Math.max(0,Math.min(255,Number(n)||0))):[20,100,180];
   return {index,x:250+xy[0]*190,y:210-xy[1]*190,color:`rgb(${rgb.join(',')})`};});
 },[points,yaw,pitch,mode]);
 const selectedSources=selected===null?[]:Array.from(new Set((points[selected]?.observations??[]).map(o=>o.sourceRef?.sourceId).filter(Boolean)));
 return <div><h4>Observed sparse geometry</h4><p>{points.length} reconstructed points. Metric scale is unknown. Hidden faces are unobserved; no surface is filled.</p>
  <label>Projection <select value={mode} onChange={e=>setMode(e.target.value)}><option value="rotate">Rotate 3D points</option><option value="xy">2D · XY</option><option value="xz">2D · XZ</option><option value="yz">2D · YZ</option></select></label>
  {mode==='rotate'&&<div className="rnd-actions"><label>Horizontal angle <input type="range" min={-180} max={180} value={yaw} onChange={e=>setYaw(Number(e.target.value))}/></label><label>Vertical angle <input type="range" min={-90} max={90} value={pitch} onChange={e=>setPitch(Number(e.target.value))}/></label></div>}
  <svg viewBox="0 0 500 420" role="img" aria-label="Sparse reconstructed points in arbitrary coordinates" style={{width:'100%',maxHeight:440,background:'#eef2f6'}}>{geometry.map(point=><circle key={point.index} cx={point.x} cy={point.y} r={selected===point.index?5:2} fill={point.color} stroke={selected===point.index?'#000':'none'} onClick={()=>setSelected(point.index)}/>)}</svg>
  <label>Inspect point <select value={selected??''} onChange={e=>setSelected(e.target.value===''?null:Number(e.target.value))}><option value="">Select a reconstructed point</option>{points.map((_,index)=><option key={index} value={index}>Point {index+1}</option>)}</select></label>
  {selectedSources.map(id=><button key={id} onClick={()=>onSource(id)}>Open point's supporting source {id.slice(-8)}</button>)}
  <details><summary>Geometry metadata</summary><pre>{JSON.stringify({coordinateFrame:data.coordinateFrame,scaleProvenance:data.scaleProvenance,intrinsicsProvenance:data.intrinsicsProvenance,renderingRules:data.renderingRules},null,2)}</pre></details>
 </div>;
}
