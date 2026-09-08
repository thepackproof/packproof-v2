import type { RequestHandler } from 'express';
export interface DependencyProbe { name:string; required?:boolean; check:()=>Promise<unknown>; }
export interface ReadinessResult { status:'ready'|'unavailable'; checkedAt:string; dependencies:Record<string,'available'|'unavailable'>; }
/** Single-flight, bounded public readiness. Dependency details are reserved for the internal view. */
export function createReadiness(probes:DependencyProbe[],options:{timeoutMs?:number;cacheMs?:number}={}) {
  const inFlight=new Map<string,Promise<unknown>>();
  let cached:ReadinessResult|undefined;let expires=0;let active:Promise<ReadinessResult>|undefined;
  const check=():Promise<ReadinessResult>=>{
    if(cached&&Date.now()<expires)return Promise.resolve(cached);
    if(active)return active;
    active=(async()=>{
      const values=await Promise.all(probes.map(async probe=>{
        let timer:NodeJS.Timeout|undefined;
        try{
          if(!inFlight.has(probe.name))inFlight.set(probe.name,Promise.resolve().then(probe.check).finally(()=>inFlight.delete(probe.name)));
          await Promise.race([inFlight.get(probe.name),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Dependency timeout')),options.timeoutMs??1500);})]);return [probe.name,'available'] as const;}
        catch{return [probe.name,'unavailable'] as const;}
        finally{clearTimeout(timer);}
      }));
      const dependencies=Object.fromEntries(values);
      cached={status:probes.some(p=>p.required!==false&&dependencies[p.name]!=='available')?'unavailable':'ready',checkedAt:new Date().toISOString(),dependencies};
      expires=Date.now()+(options.cacheMs??5000);return cached;
    })().finally(()=>{active=undefined;});return active;
  };
  const handler:RequestHandler=(_req,res)=>{void check().then(result=>res.status(result.status==='ready'?200:503).json({status:result.status,checkedAt:result.checkedAt}));};
  return {check,handler};
}
export const liveness:RequestHandler=(_req,res)=>{res.json({status:'alive'});};
