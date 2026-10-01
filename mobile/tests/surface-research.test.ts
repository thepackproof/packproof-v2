import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, digest, parseSurfaceJournal, sourceBarcodePolygon, surfaceCollectionAllowed, type SurfaceBinding, type SurfaceSource } from '../src/fingerprint/model.ts';
const binding:SurfaceBinding={experimental:true,schemaVersion:'surface-local/1',captureSessionId:'cap_fixture',proofId:'proof_fixture',userId:'user_fixture',apiBaseUrl:'http://localhost:3000',expectedTracking:'123456789',operation:'enrollment',shipmentLegId:'OUTBOUND',contextStage:'unknown',authorizationAt:'2026-10-01T00:00:00Z',qualification:'UNQUALIFIED'};
const source=(n:number):SurfaceSource=>({fileName:`surface-original-${n}.jpg`,sha256:'a'.repeat(64),byteSize:100,width:1280,height:720,rotationDegrees:0,frameTimeMs:n*1600,barcodeBounds:[200,100,800,500]});
function journal(events:Array<[string,unknown]>) {let previous:string|null=null;return events.map(([type,value],sequence)=>{const eventJson=JSON.stringify({sequence,previous,type,value});const sha256=digest(eventJson);previous=sha256;return JSON.stringify({eventJson,sha256});}).join('\n')+'\n';}
const start:['STARTED',unknown]=['STARTED',{binding,profileId:'android-analysis-v1-unqualified'}];
test('surface collection fails closed unless all independent gates permit it',()=>{
  for(let mask=0;mask<32;mask++){const values=[0,1,2,3,4].map(bit=>Boolean(mask&(1<<bit)));assert.equal(surfaceCollectionAllowed(values[0],values[1],values[2],values[3],values[4]),mask===31);}
});
test('native journal retains latest candidates and explicit unavailable reasons without physical claim',()=>{
  const events:Array<[string,unknown]>=[start,...Array.from({length:6},(_,n)=>['SOURCE',source(n)] as [string,unknown]),['SOURCE',source(6)],['SUPERSEDED',{fileName:source(0).fileName}],['UNAVAILABLE',{reason:'THERMAL_PRESSURE'}],['FINISHED',{interrupted:false,selectedCount:6}]];
  const parsed=parseSurfaceJournal(journal(events));assert.equal(parsed.sources.length,6);assert.equal(parsed.sources[0].fileName,source(1).fileName);assert.deepEqual(parsed.unavailable,['THERMAL_PRESSURE']);assert.equal(parsed.finished,true);assert.equal(parsed.binding.qualification,'UNQUALIFIED');
});
test('force-stop is not upgraded into a completed capture',()=>{
  assert.equal(parseSurfaceJournal(journal([start,['SOURCE',source(0)]])).finished,false);
  assert.throws(()=>parseSurfaceJournal(journal([start,['SOURCE',source(0)]]).slice(0,-6)));
});
test('hash changes, path traversal, source over-budget and events after finish reject',()=>{
  assert.throws(()=>parseSurfaceJournal(journal([start,['SOURCE',source(0)]]).replace('123456789','987654321')));
  assert.throws(()=>parseSurfaceJournal(journal([start,['SOURCE',{...source(0),fileName:'../video.mp4'}]])));
  assert.throws(()=>parseSurfaceJournal(journal([start,['SOURCE',{...source(0),byteSize:5*1024*1024}],['SOURCE',{...source(1),byteSize:5*1024*1024}]])));
  assert.throws(()=>parseSurfaceJournal(journal([start,['FINISHED',{interrupted:false}],['SOURCE',source(0)]])));
});
test('all Android rotation coordinates map onto exact preserved source pixels',()=>{
  assert.deepEqual(sourceBarcodePolygon({...source(0),width:100,height:60,rotationDegrees:90,barcodeBounds:[10,20,40,80]}),[[20,20],[80,20],[80,50],[20,50]]);
  assert.deepEqual(sourceBarcodePolygon({...source(0),width:100,height:60,rotationDegrees:270,barcodeBounds:[10,20,40,80]}),[[20,10],[80,10],[80,40],[20,40]]);
  assert.deepEqual(sourceBarcodePolygon({...source(0),width:100,height:60,rotationDegrees:180,barcodeBounds:[10,20,80,40]}),[[20,20],[90,20],[90,40],[20,40]]);
  assert.throws(()=>sourceBarcodePolygon({...source(0),barcodeBounds:[-1,0,2000,9999]}));
});
test('canonical request commitment is stable across key ordering and binds values',()=>{
  assert.equal(digest(canonical({b:2,a:{y:2,x:1}})),digest(canonical({a:{x:1,y:2},b:2})));
  assert.notEqual(digest(canonical({proof:'a'})),digest(canonical({proof:'b'})));
});
