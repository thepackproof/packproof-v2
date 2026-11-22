const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const summary = {proofId:'sample-layout-order',revision:7,orderReference:'SO10482',customerName:'Sample warehouse',latestKind:'delivery',updatedAt:'2026-11-17T12:02:00Z'};
const detail = {...summary,
  lines:[{lineId:'20',sku:'A100',orderedQuantity:'2',unit:'each'},{lineId:'30',sku:'A100',orderedQuantity:'1',unit:'each'}],
  events:[{eventKey:'event-sales',kind:'order',sourceId:'sales'},{eventKey:'event-pack',kind:'packing',sourceId:'packing'},{eventKey:'event-delivery',kind:'delivery',sourceId:'shipping'}],
  evidence:[{eventKey:'event-pack',fileName:'packing_photo.jpg',sourceId:'packing',locator:'package PKG92'}],packages:[{packageId:'PKG92'},{packageId:'PKG93'}]};
const preview = {examples:[{orderReference:summary.orderReference,source:'Sales orders',
  lines:detail.lines.map(l=>({lineId:l.lineId,sku:l.sku,quantity:l.orderedQuantity,unit:l.unit})),
  packages:['PKG92','PKG93'],events:[{kind:'packing',source:'Packing bench',fileName:'packages.xml',occurredAt:'2026-11-17T12:02:00Z',shared:false}]}],
  scannedFiles:3,unresolved:0,unreadFiles:0,limited:false};
const sources = [['sales','order','Sales orders'],['picks','picking','Warehouse picks'],['packing','packing','Packing bench'],['shipping','shipping','Carrier labels']]
  .map(([id,role,name])=>({id,folder:'C:\\Sample operation\\'+name,transport:'folder',roles:[role],generation:2,state:'active',
    recognition:{state:'recognized',message:'Found records from this location.'}}));
const folder = 'C:\\Sample operation\\Proofs';
const home = 'Workspace overview';
const roleHeadings = {picking:'picking records',packing:'packing records',shipping:'shipping records',evidence:'photos and documents',handoff:'carrier handoffs',delivery:'delivery confirmations',returns:'returns'};
const scenes = [
  {name:'welcome',step:'order',heading:'Your orders. One clear story.'},
  {name:'order',step:'order',heading:'Your order files are ready to review.',contains:summary.orderReference},
  ...Object.entries(roleHeadings).map(([step,role])=>({name:step,step,heading:'Find your '+role+'.',contains:'Search again'})),
  {name:'review',step:'review',heading:'Review your first order',contains:'packages.xml'},
  {name:'output',step:'output',heading:'Where should we save your proofs?',contains:folder},
  {name:'activate',step:'activate',heading:'Connect your records.',contains:'Sales orders'},
  {name:'empty-source',step:'order',heading:'No order lists in this folder yet.',contains:'No records have arrived yet.'},
  {name:'ambiguous-source',step:'order',heading:'Check your records folder.',contains:'Which column identifies this order?'},
  {name:'overview',heading:home,contains:summary.orderReference},
  {name:'orders',nav:'Orders',heading:'Orders',contains:summary.orderReference},
  {name:'connections',nav:'Connections',heading:'Your connections',contains:'Carrier labels'},
  {name:'healthy-source',nav:'Connections',action:'detail',heading:'Sales orders',contains:sources[0].folder},
  {name:'offline-source',nav:'Connections',action:'repair',heading:'Reconnect your shipping folder.',contains:sources[3].folder},
  {name:'restored-source',nav:'Connections',action:'restore',heading:'Your folder is connected.',contains:'Carrier labels'},
  {name:'pending-output',nav:'Needs attention',heading:'Needs attention',contains:'Local copies pending'},
  {name:'disconnected',nav:'Orders',heading:'Orders',contains:'Reconnect to your approved workspace'},
  {name:'assembled-order',nav:'Orders',action:'proof',heading:'Proof '+summary.proofId,contains:summary.orderReference},
];
const guidedScenes = [
  {name:'guided-order',step:'order',heading:'Start with an order you know.',contains:'Order preview · Sample',guided:true},
  {name:'guided-sources',step:'packing',heading:'Where can we look?',contains:'Review a known order',guided:true},
  {name:'guided-review',step:'review',heading:'Does this match the shipment?',contains:'packages.xml',guided:true,action:'guided-preview'},
  {name:'guided-activate',step:'output',heading:'Approve the facility setup.',contains:'Known-order replay',guided:true},
];
// Matches the existing GuidedSetup test contract. This is local renderer state,
// not an authorization, replay receipt, or live facility configuration.
const facilityDraft = {id:'11111111-2222-4333-8444-555555555555',revision:1,scopeKey:'visual-fixture',
  steps:[],examples:[{kind:'ordinary',reference:summary.orderReference,cartons:2,labelCount:2}],
  rules:[],excludedSourceIds:[],replay:null};
const navHeading = {Orders:'Orders',Connections:'Your connections','Needs attention':'Needs attention'};
const visibleButton = text => `[...document.querySelectorAll('button')].find(el=>el.checkVisibility() && el.textContent.trim().startsWith(${JSON.stringify(text)}))`;
const navButton = text => `[...document.querySelectorAll('nav[aria-label="Workspace"] button')].find(el=>el.textContent.trim()===${JSON.stringify(text)})`;
const squash = text => text.replace(/\s+/g,'');

module.exports = async function workspaceLayout({page,setStatus,register,state,waitFor,checkPage,stage,reach,keyboard,appUrl,directory,report,
  themes=['light','dark'],displayCases=[[1280,900,1],[1280,900,1.25],[1280,900,1.5],[1280,900,2],[560,720,1]],captureViewport=false,includeGuidedSetup=false}) {
  fs.mkdirSync(directory,{recursive:true});
  let current, activeScene, inspected;
  function publish(next){current=next;setStatus(next);return next;}
  register('workspaceOrderDetail',(id,revision)=>{
    assert.equal(id,summary.proofId);assert.equal(revision,summary.revision);
    return detail;
  });
  register('workspaceAttention',{items:[],hasMore:false,orderIssues:[],orderIssueCount:0,nextIssuesBefore:null});
  if(includeGuidedSetup)register('getFacilityDraft',()=>{
    assert.ok(activeScene.startsWith('guided-'),'Facility draft is only available in the explicit guided visual fixture');
    return structuredClone(facilityDraft);
  });
  register('discoverWorkspaceFolders',role=>sources.filter(s=>s.roles.includes(role)).map(s=>({folder:s.folder,kind:'selected'})));
  register('workspaceDraftPreview',()=>['empty-source','ambiguous-source'].includes(activeScene)?{...preview,examples:[]}:preview);
  register('inspectWorkspaceSource',id=>{
    assert.equal(activeScene,'restored-source');assert.equal(id,'shipping');inspected=true;
    const next=current.workspace.sources.map(s=>s.id===id?structuredClone(sources[3]):s);
    return publish({...current,workspace:{...current.workspace,sources:next}});
  });
  async function press(target){await reach(page,target);await keyboard(page,'Enter',13);}
  const heading = title => waitFor(page,`[...document.querySelectorAll('h1')].find(el=>el.checkVisibility())?.textContent.replace(/\\s+/g,'')===${JSON.stringify(squash(title))}`);
  async function capture(name,display){
    if(display)await page.executeJavaScript('window.scrollTo(0,0)');
    const {cssContentSize}=await page.debugger.sendCommand('Page.getLayoutMetrics');
    const {data}=await page.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
      clip:{x:0,y:0,width:display?display.cssWidth:Math.ceil(cssContentSize.width),height:display?Math.round(display.height/display.scale):Math.ceil(cssContentSize.height),scale:1}});
    const png=Buffer.from(data,'base64');
    if(display){
      assert.ok(png.length>24,'Empty packaged screenshot');
      const dimensions={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
      assert.deepEqual(dimensions,{width:display.width,height:display.height},'Incorrect unified screenshot dimensions: '+name);
      (report.screenshots??={})[name+'.png']={...display,...dimensions};
    }
    fs.writeFileSync(path.join(directory,name+'.png'),png);
  }
  for(const theme of themes) {
    for(const [width,height,scale] of displayCases) {
      const cssWidth=Math.round(width/scale);
      await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:cssWidth,height:Math.round(height/scale),deviceScaleFactor:scale,mobile:false});
      await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
      for(const scene of [...(includeGuidedSetup?guidedScenes:[]),...scenes]) {
        activeScene=scene.name;inspected=false;
        report.currentRun={scene:scene.name,theme,width,height,scale,cssWidth};
        stage(`packaged workspace ${theme} ${cssWidth}px ${scene.name}`);
        const localSources=scene.name==='welcome'?[]:structuredClone(sources);
        if(scene.name==='empty-source')localSources[0].recognition={state:'empty',message:'No records have arrived yet.'};
        if(scene.name==='ambiguous-source')localSources[0].recognition={state:'ambiguous',message:'Check the order reference.',question:'Which column identifies this order?',profileVersion:'fixture-v1',suggestedOrderColumn:'Order',sample:{Order:summary.orderReference}};
        if(scene.action==='repair'||scene.action==='restore')Object.assign(localSources[3],{state:'needs_attention',issue:'ACCESS_DENIED',recognition:{state:'unavailable',message:'This folder is currently unavailable.'}});
        const pending=scene.name==='pending-output';
        const canReadOrders=!scene.step&&scene.name!=='disconnected';
        if(!canReadOrders)for(const source of localSources)source.state='pending';
        publish({...state,capabilities:{...state.capabilities,orderWorkspace:true},
          workspace:{step:scene.step||'overview',phase:scene.step?'draft':'active',sources:localSources,
            ...(scene.guided?{guidedSetupAvailable:true}:{}),
            orders:canReadOrders?[summary]:[],totalOrders:canReadOrders?1:null,updatedToday:canReadOrders?1:null,
            canReadOrders,viewKey:canReadOrders?'a'.repeat(64):null,outputState:'ready',outputFolder:folder},
          proofOutput:{folder,pending:pending?1:0,state:pending?'pending':'ready'}});
        await page.loadURL(appUrl);
        await waitFor(page,`matchMedia('(prefers-color-scheme: ${theme})').matches && matchMedia('(prefers-reduced-motion: reduce)').matches`);
        if(scene.nav){
          await heading(home);
          await press(navButton(scene.nav));
          await heading(navHeading[scene.nav]);
          await waitFor(page,`(${navButton(scene.nav)})?.getAttribute('aria-current')==='page'`);
        }
        if(scene.action==='detail')await press(visibleButton('View connection →'));
        if(scene.action==='repair'||scene.action==='restore'){
          await press(visibleButton('Fix connection'));
          await heading('Reconnect your shipping folder.');
          await press(visibleButton('Keep this folder and fix access'));
          await waitFor(page,`(${visibleButton('Keep this folder and fix access')})?.getAttribute('aria-expanded')==='true'`);
          if(scene.action==='restore')await press(visibleButton('Check again'));
        }
        if(scene.action==='proof')await press(visibleButton(summary.orderReference));
        await heading(scene.heading);
        if(scene.guided){
          await waitFor(page,`!!document.querySelector('main[aria-label="Guided facility setup"]')`);
          if(scene.action==='guided-preview')await press(visibleButton('Find these orders'));
          if(scene.name==='guided-activate')await waitFor(page,`(${visibleButton('Request browser approval')})?.disabled===true`);
        }
        if(scene.contains)await waitFor(page,`document.body.innerText.includes(${JSON.stringify(scene.contains)})`);
        if(scene.name==='overview'||scene.name==='orders'){
          const row=visibleButton(summary.orderReference);
          await waitFor(page,`(${row})?.innerText.includes(${JSON.stringify(summary.orderReference)})`);
          await waitFor(page,`(${row})?.innerText.includes(${JSON.stringify(summary.customerName)})`);
        }
        if(scene.action==='restore')assert.ok(inspected,'Restore must inspect the affected source before reporting success');
        if(scene.name==='disconnected')assert.equal(await page.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(summary.orderReference)})`),false);
        await page.executeJavaScript('document.fonts.ready.then(()=>true)');
        await checkPage(page,cssWidth);
        const tree=await page.debugger.sendCommand('Accessibility.getFullAXTree');
        assert.ok(tree.nodes.some(n=>n.role?.value==='heading'&&squash(n.name?.value||'')===squash(scene.heading)),`Missing accessible heading: ${scene.heading}`);
        if(captureViewport)await capture(`${scene.name}-${theme}-${width}x${height}-${Math.round(scale*100)}pct`,{width,height,scale,cssWidth});
        else if(width===1280&&scale===1)await capture(scene.name+'-'+theme);
        report.runs.push({...report.currentRun});
      }
    }
  }
};
