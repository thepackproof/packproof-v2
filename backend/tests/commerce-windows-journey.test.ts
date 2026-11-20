import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {Agent,createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import request from 'supertest';
import {it,expect} from 'vitest';
import {createHarness,createUser,auth} from './helpers.js';
import {sha256Hex} from '../src/hash.js';

it.skipIf(process.platform!=='win32' || process.env.PACKPROOF_JOURNEY_COMMERCE!=='1')(
  'records an Electron camera stream, finalizes it and reopens and shares the same Commerce Proof',async()=>{
    const desktop=fileURLToPath(new URL('../../desktop/',import.meta.url));
    const runtime=JSON.parse(await readFile(new URL('../../connect-windows/dist/commerce/main/runtime-config.json',import.meta.url),'utf8'));
    const webOrigin=new URL(runtime.webBaseUrl);
    if(webOrigin.protocol!=='https:')throw Error('Build the Commerce fixture with an HTTPS PACKPROOF_WEB_BASE_URL for reviewed share links.');
    const root=await mkdtemp(path.join(tmpdir(),'packproof-commerce-'));
    const pipe='\\\\.\\pipe\\packproof-commerce-'+randomUUID();
    const fixture=path.join(root,'commerce-fixture.json');
    const h=await createHarness(undefined,{publicBaseUrl:runtime.apiBaseUrl,corsOrigins:[webOrigin.origin]});
    const http=createServer(h.app),transport=new Agent({socketPath:pipe,keepAlive:false});
    try {
      await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(pipe,resolve);});
      const api=request.agent('http://localhost').use(req=>req.agent(transport)),user=await createUser(h);
      const created=await api.post('/proofs').set(auth(user)).send({workflowType:'COMMERCE_SALE',
        transaction:{itemTitle:'Commerce camera fixture',shipping:{trackingNumber:'PP0000001234',carrier:'OTHER'}}});
      expect(created.status,JSON.stringify(created.body)).toBe(201);
      const proofId=created.body.proofId;
      const admission=await api.post('/proofs/'+proofId+'/capture-sessions/desktop-admission').set(auth(user)).send({schemaVersion:1});
      expect(admission.body).toMatchObject({proofId,reservation:'NOT_REQUIRED'});
      await writeFile(fixture,JSON.stringify({pipe,token:user,proofId,root}),{flag:'wx'});
      const electron=process.env.PACKPROOF_COMMERCE_ELECTRON || createRequire(path.join(desktop,'package.json'))('electron') as string;
      const env={...process.env,PACKPROOF_COMMERCE_FIXTURE:fixture};
      delete env.ELECTRON_RUN_AS_NODE;
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(electron,['--disable-gpu','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
          '--user-data-dir='+path.join(root,'electron'),path.join(desktop,'scripts','commerce-windows-journey.cjs')],
        {cwd:desktop,env,windowsHide:true,stdio:'inherit',timeout:120000});
        child.once('error',reject);
        child.once('exit',(code,signal)=>code===0?resolve():reject(Error('Commerce journey exited '+(signal??code))));
      });
      const result=JSON.parse(await readFile(path.join(root,'commerce-result.json'),'utf8'));
      expect(result).toMatchObject({proofId,renderedHistory:true,previewed:true,shareReviewed:true});
      const saved=(await h.db.query<{object_key:string;object_version_id:string;sha256:string;byte_size:string;content_type:string}>(`
        SELECT object_key,object_version_id,sha256,byte_size,content_type FROM evidence WHERE proof_id=$1
          AND id=$2 AND submitted_by=$3 AND evidence_type='FULFILLMENT_CAPTURE' AND validation_status='COMMITTED'`,[proofId,result.evidenceId,user])).rows[0];
      expect(saved).toBeDefined();
      const object=await h.objectStore.get(saved.object_key,{versionId:saved.object_version_id});
      expect(object && sha256Hex(object.body)).toEqual(result.sha256);
      expect(saved.sha256).toEqual(result.sha256);
      expect(Number(saved.byte_size)).toBe(result.byteSize);
      expect(saved.content_type).toMatch(/^video\//);
      const manifest=(await h.db.query<{sha256:string;canonical_json:string}>(`SELECT m.sha256,m.canonical_json
        FROM proofs p JOIN final_manifests m ON m.id=p.manifest_id AND m.proof_id=p.id WHERE p.id=$1 AND p.status='FINALIZED'`,[proofId])).rows[0];
      expect(sha256Hex(manifest.canonical_json)).toBe(manifest.sha256);
      expect(manifest.canonical_json).toContain(result.sha256);
      if(result.manifestSha256) expect(result.manifestSha256).toBe(manifest.sha256);
      const shares=(await h.db.query<{id:string}>(`SELECT l.id FROM proof_access_links l JOIN proof_disclosure_grants g ON g.access_link_id=l.id
        WHERE l.proof_id=$1 AND g.created_by_user_id=$2 AND g.purpose='SHARED_PROOF' AND l.revoked_at IS NULL`,[proofId,user])).rows;
      expect(shares).toHaveLength(1);
      if(result.accessLinkId)expect(shares[0].id).toBe(result.accessLinkId);
      const trace={proofId,evidenceId:result.evidenceId,byteSize:result.byteSize,contentType:saved.content_type,
        sha256:saved.sha256,manifestSha256:manifest.sha256,renderedHistory:true,shareReviewed:true,exactShareCount:shares.length};
      if(process.env.PACKPROOF_COMMERCE_RESULT) {
        await mkdir(path.dirname(process.env.PACKPROOF_COMMERCE_RESULT),{recursive:true});
        await writeFile(process.env.PACKPROOF_COMMERCE_RESULT,JSON.stringify(trace,null,2));
      }
      console.log('Commerce capture verified',JSON.stringify(trace));
    } finally {
      transport.destroy();
      if(http.listening)await new Promise<void>(resolve=>http.close(()=>resolve()));
      await h.close();await rm(root,{recursive:true,force:true,maxRetries:5});
    }
  },160000);
