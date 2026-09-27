/* Explicit test harness only. Fixtures are injected by Playwright and never bundled into the application. */
const {createServer}=require('node:http');
const {readFile,mkdir}=require('node:fs/promises');
const {resolve,extname,sep}=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

(async()=>{
  const root=resolve(__dirname,'../dist/renderer');
  const out=resolve(process.env.SMOKE_OUTPUT||'artifacts/renderer-smoke');await mkdir(out,{recursive:true});
  const server=createServer(async(req,res)=>{
    try{const name=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));if(!name.startsWith(root+sep))throw Error('outside root');const data=await readFile(name);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[extname(name)]||'application/octet-stream'));res.end(data);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--no-sandbox','--disable-dev-shm-usage']});}
  catch(error){await new Promise(resolve=>server.close(resolve));throw error;}
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['camera','microphone']});
    await context.addInitScript(()=>{
      const now='2026-09-27T12:00:00.000Z';
      const transaction={transactionId:'test-transaction',externalReference:'TEST-1048',itemTitle:'Test collector shipment',itemDescription:null,quantity:1,transactionDate:now,transactionValue:100,currency:'USD',createdBy:'test-user',createdAt:now,updatedAt:now,metadata:{},shipping:{carrier:'USPS',service:null,trackingNumber:'9400111899223856928877',shipmentDate:null},proofId:'test-proof',proofStatus:'READY_FOR_EVIDENCE',sellerUserId:'test-user',buyerUserId:null};
      const summary={proofId:'test-proof',transactionId:transaction.transactionId,role:'SELLER',status:'READY_FOR_EVIDENCE',createdAt:now,updatedAt:now,finalizedAt:null,transaction:{externalReference:transaction.externalReference,itemTitle:transaction.itemTitle,transactionDate:now,carrier:'USPS',trackingNumber:transaction.shipping.trackingNumber},presentation:{proofId:'test-proof',displayStatus:'Recording needed',needsAttention:true,completed:false,canContribute:true,nextAction:{type:'RECORD_PACKING',label:'Record packing'},share:{available:true,reason:null},shipmentStatus:null,diagnostic:null}};
      const detail={...summary,version:1,manifestId:null,transaction,participants:[{participantId:'test-participant',userId:'test-user',role:'SELLER',status:'JOINED',joinedAt:now}],evidence:[],attestations:[],chronology:[{id:'test-event',occurredAt:now,category:'PROOF',title:'Proof created',description:'Test fixture shipment',source:'PackProof'}]};
      const order={transactionId:'test-transaction',proofId:'test-proof',connectionId:'test-connection',provider:'shopify',providerDisplay:'Shopify',externalAccountReference:'Test store',externalOrderId:'TEST-1048',externalReference:'TEST-1048',items:[],itemSummary:'Test collector shipment',itemCount:1,transactionValue:100,currency:'USD',orderedAt:now,proofStatus:'READY_FOR_EVIDENCE',participationPolicy:'COUNTERPARTY_OPTIONAL',sellerPackingAttested:false,evidenceCount:0,pendingEvidenceCount:0,canComplete:false,workflowState:'READY'};
      const listeners=new Set();
      let authenticated=true;
      const session={userId:'test-user',email:'test@example.invalid',profile:{userId:'test-user',username:'testoperator',displayName:'Test Operator',status:'ACTIVE',createdAt:now,updatedAt:now}};
      const settings={cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,notifications:true,scannerSuffix:'Enter',theme:'light'};
      const state={version:'1.0.0-test',platform:'win32',environment:'staging',online:true,configured:true,secureStorage:true,pendingOtherAccounts:false,settings,update:{state:'idle'}};
      const smoke={calls:[],jobs:[],chunks:[],finish:null,interrupt:null};window.__smoke=smoke;
      const emit=event=>listeners.forEach(fn=>fn(event));
      window.packproof={
        auth:{state:async()=>authenticated?session:null,signIn:async()=>{authenticated=true;return session;},signOut:async()=>{authenticated=false;emit({type:'session'});},signUp:async input=>({email:input.email,userConfirmed:false}),confirmSignUp:async()=>{},resendCode:async()=>{},forgotPassword:async()=>{},resetPassword:async()=>{}},
        proofs:{list:async()=>[summary],detail:async()=>detail,create:async()=>detail,finalize:async()=>({...detail,status:'FINALIZED',finalizedAt:now}),share:async()=>({url:'https://thepackproof.com/proof/test-fixture'}),export:async()=>({saved:true}),evidenceUrl:async()=>''},
        orders:{list:async()=>[order],resolve:async()=>({proofId:'test-proof'}),sync:async()=>{}},
        integrations:{list:async()=>({accounts:[{id:'test-account',provider:'shopify',providerDisplay:'Shopify',externalAccountId:'test',externalAccountName:'Test store',status:'CONNECTED',scopes:[],expiresAt:null,capabilities:{identity:false,transactions:true,fulfillment:true,shipping:false,webhooks:true},limitations:[],createdAt:now,updatedAt:now,disconnectedAt:null}],providers:[{provider:'shopify',providerDisplay:'Shopify',enabled:true,capabilities:{identity:false,transactions:true,fulfillment:true,shipping:false,webhooks:true},limitations:[],multipleAccounts:false,requiresShop:true}]}),connect:async()=>{smoke.calls.push('connect');}},
        capture:{begin:async input=>{const id='test-recording-'+(smoke.jobs.length+1);smoke.calls.push('begin');smoke.jobs.unshift({id,proofId:input.proofId,label:input.label,state:'RECORDING',progress:0,byteSize:0,createdAt:now});return {id,maxRecordingBytes:128*1024*1024,maxRecordingSeconds:120};},append:async(id,sequence,bytes)=>{smoke.chunks.push({id,sequence,byteLength:bytes.byteLength,header:Array.from(new Uint8Array(bytes).slice(0,4))});const job=smoke.jobs.find(item=>item.id===id);job.byteSize+=bytes.byteLength;},finish:async(id,input)=>{smoke.finish=input;smoke.calls.push('finish');smoke.jobs.find(item=>item.id===id).state='COMPLETE';smoke.jobs.find(item=>item.id===id).progress=100;emit({type:'queue'});emit({type:'notification',title:'Evidence committed',message:'Test fixture recording secured by PackProof.'});},interrupt:async(id,reason)=>{smoke.interrupt=reason;smoke.jobs.find(item=>item.id===id).state='INTERRUPTED';emit({type:'queue'});}},
        uploads:{list:async()=>structuredClone(smoke.jobs),retry:async()=>{},discard:async id=>{smoke.jobs=smoke.jobs.filter(job=>job.id!==id);emit({type:'queue'});},pause:async()=>{},resume:async()=>{}},
        system:{state:async()=>structuredClone(state),settings:async()=>structuredClone(settings),saveSettings:async input=>{Object.assign(settings,input);return structuredClone(settings);},openExternal:async url=>{smoke.calls.push(url);},exportDiagnostics:async()=>'test diagnostics'},
        updates:{check:async()=>{state.update.state='available';emit({type:'update'});},download:async()=>{state.update.state='downloaded';emit({type:'update'});},install:async()=>{smoke.calls.push('install');}},
        events:{subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},
      };
    });
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
    await page.getByRole('button',{name:'TEST-1048',exact:true}).first().waitFor();
    assert.equal(await page.locator('body').evaluate(element=>element.scrollWidth<=innerWidth),true,'dashboard horizontal overflow');
    await page.screenshot({path:resolve(out,'desktop-dashboard.png'),fullPage:true});
    await page.getByRole('button',{name:'TEST-1048',exact:true}).first().click();
    await page.getByRole('heading',{name:'Record timeline',exact:true}).waitFor();
    await page.getByRole('button',{name:'Share',exact:true}).click();
    await page.getByRole('heading',{name:'Share this Proof',exact:true}).waitFor();
    await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.getByRole('button',{name:'Record packing',exact:true}).click();
    await page.getByText('Camera ready',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Record packing',exact:true}).click();
    await page.waitForFunction(()=>window.__smoke.chunks.length>=2);
    await page.getByRole('navigation').getByRole('button',{name:'Home',exact:true}).click();
    await page.getByText('Finish or preserve the current recording before leaving the Packing Station.').waitFor();
    await page.getByLabel('Order number or tracking barcode').fill('9400111899223856928877');
    await page.getByLabel('Order number or tracking barcode').press('Enter');
    await page.screenshot({path:resolve(out,'desktop-packing-station.png'),fullPage:true});
    await page.getByRole('button',{name:'Finished packing',exact:true}).click();
    await page.getByRole('heading',{name:'Confirm your packing recording',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Confirm & upload',exact:true}).isDisabled(),true,'attestation required');
    await page.getByLabel('Shipping label on this package').selectOption('9400111899223856928877');
    await page.getByLabel('The item shown and attached in this Proof is the item I am shipping.').check();
    await page.getByRole('button',{name:'Confirm & upload',exact:true}).click();
    await page.getByText('Evidence secured locally. Uploading in the background when a connection is available.').waitFor();
    const capture=await page.evaluate(()=>window.__smoke);
    assert.ok(capture.chunks.length>=2);assert.ok(capture.chunks.every((chunk,index)=>chunk.sequence===index&&chunk.byteLength>0&&chunk.byteLength<=1024*1024));
    assert.deepEqual(capture.chunks[0].header,[26,69,223,163],'WebM original chunk header');
    assert.equal(capture.finish.attestation,true);assert.equal(capture.finish.detections[0].confirmed,true);assert.ok(capture.finish.durationMs>1000);
    assert.ok(new Date(capture.finish.endedAt)>new Date(capture.finish.startedAt));
    await page.getByRole('navigation').getByRole('button',{name:'Uploads',exact:true}).click();
    await page.getByText('Secured by PackProof',{exact:true}).waitFor();
    await page.screenshot({path:resolve(out,'desktop-uploads.png'),fullPage:true});
    for(const name of ['Orders','Integrations','Notifications','Settings']){await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();}
    await page.getByLabel('Appearance',{exact:true}).selectOption('dark');
    await page.getByRole('navigation').getByRole('button',{name:'Home',exact:true}).click();
    await page.screenshot({path:resolve(out,'desktop-dashboard-dark.png'),fullPage:true});
    await page.setViewportSize({width:1000,height:700});
    assert.equal(await page.locator('body').evaluate(element=>element.scrollWidth<=innerWidth),true,'minimum width horizontal overflow');
    await page.getByRole('button',{name:'Test Operator test@example.invalid'}).click();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByRole('heading',{name:'Your evidence workstation.'}).waitFor();
    await page.getByRole('button',{name:'Forgot password?',exact:true}).click();
    await page.getByRole('heading',{name:'Reset your password.'}).waitFor();
    assert.deepEqual(errors,[],'renderer page errors');
    console.log(JSON.stringify({ok:true,assertions:['sidebar navigation','account auth views','dashboard/table','proof detail/share','continuous WebM capture','bounded ordered IPC chunks','capture navigation guard','scanner label observation','explicit shipping-label confirmation','explicit attestation','capture timestamps','upload confirmation','dark appearance','1000px minimum window layout'],chunkCount:capture.chunks.length,totalBytes:capture.chunks.reduce((total,item)=>total+item.byteLength,0),screenshots:out},null,2));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
