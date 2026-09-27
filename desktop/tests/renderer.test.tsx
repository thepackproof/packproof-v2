import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Auth } from '../src/renderer/Auth';
import { PackingStation } from '../src/renderer/PackingStation';
import { appearsTracking, presentation, trackingMatch } from '../src/renderer/presentation';
import type { ProofCollectionItem, SystemView } from '../src/shared/contracts';

const system:SystemView={version:'1.0.0',platform:'darwin',environment:'staging',online:true,configured:false,secureStorage:false,pendingOtherAccounts:false,update:{state:'idle'},settings:{cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,notifications:true,scannerSuffix:'Enter',theme:'system'}};
describe('desktop renderer safety and shared presentation',()=>{
  it('disables sign-in when protected storage or environment configuration is absent',()=>{
    const html=renderToStaticMarkup(<Auth system={system} onSignedIn={()=>{}}/>);
    expect(html).toContain('Protected credential storage is unavailable');
    expect(html).toContain('has not been configured');
    expect(html).toMatch(/class="primary full" disabled=""/);
    expect(html).not.toContain('value="Bearer');
  });
  it('offers no enabled record action before the camera and a Proof are ready',()=>{
    const html=renderToStaticMarkup(<PackingStation proofId={null} orders={[]} settings={system.settings} chooseProof={()=>{}} onBusy={()=>{}} onSaved={()=>{}} onSettings={()=>{}}/>);
    expect(html).toContain('Camera needs attention');
    expect(html).toMatch(/class="primary" disabled=""/);
    expect(html).toContain('Select a synchronized order');
    expect(html).not.toContain('Secured by PackProof');
  });
  it('uses the backend shipping normalization and never accepts a partial tracking match',()=>{
    const tracking='9400111899223856928877';
    expect(trackingMatch(`]C142043054\u001d${tracking}`,tracking)).toBe(true);
    expect(trackingMatch(`420430540001${tracking}`,tracking)).toBe(true);
    expect(trackingMatch(tracking,tracking.slice(2))).toBe(false);
    expect(trackingMatch('1Z999AA10123456784','1Z999AA10123456785')).toBe(false);
    expect(trackingMatch('', '')).toBe(false);
    expect(appearsTracking('012345678905')).toBe(false);
  });
  it('does not label an unfinalized record complete from status alone',()=>{
    const proof={proofId:'proof-a',status:'FINALIZED',role:'SELLER',finalizedAt:null} as ProofCollectionItem;
    expect(presentation(proof).completed).toBe(false);
    expect(presentation({...proof,finalizedAt:'2026-09-27T00:00:00Z'}).completed).toBe(true);
  });
});
