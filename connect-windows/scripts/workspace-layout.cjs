const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const headings = {
  order:'Order records', picking:'Picking records', packing:'Packing and evidence', shipping:'Shipping records',
  evidence:'Photos and documents', handoff:'Handoff records', delivery:'Delivery records', returns:'Return records',
  review:'Review an order', output:'Where should PackProof save your proofs?', activate:'Start collecting', overview:'Overview',
};
const summary = {proofId:'sample-layout-order',revision:7,orderReference:'SO10482'};
const sources = [
  ['order','Sales orders',{Order:'SO10482',Item:'A100'}],
  ['picking','Warehouse picks',{Order:'WO771'}],
  ['packing','Packing bench',{Package:'PKG92'}],
  ['shipping','Carrier labels',{Shipment:'SHP771'}],
].map(([role,name,sample],i)=>({id:'sample-'+i,folder:'C:\\Sample operation\\'+name,roles:[role],generation:1,state:'active',
  recognition:{state:'recognized',message:'Found records from this location.',fields:Object.keys(sample),sample}}));
const detail = {...summary,lines:[{lineId:'20',sku:'A100',orderedQuantity:2,unit:'each'},{lineId:'30',sku:'A100',orderedQuantity:1,unit:'each'}],
  events:[{kind:'order',sourceName:'Sales orders'},{kind:'packing',sourceName:'Packing bench'},{kind:'delivery',sourceName:'Carrier delivery report'}],
  evidence:[{fileName:'packing_photo.jpg'}],packages:[{packageId:'PKG92'},{packageId:'PKG93'}]};
const situations = [
  ...Object.keys(headings).map(step=>({name:step,step})),
  {name:'empty-source',step:'order',recognition:'empty',message:'No records have arrived yet.'},
  {name:'ambiguous-source',step:'picking',recognition:'ambiguous',message:'Choose the reference that identifies the order.'},
  {name:'offline-source',step:'overview',navigation:'Sources',recognition:'unavailable',message:'This folder is currently unavailable.'},
  {name:'pending-output',step:'overview',pending:true},
  {name:'assembled-order',step:'overview',navigation:'Orders',detail:true},
];
module.exports = async function workspaceLayout({page,setStatus,register,state,waitFor,checkPage,stage,reach,keyboard,appUrl,directory,report}) {
  fs.mkdirSync(directory,{recursive:true});
  register('workspaceOrderDetail',detail);
  register('workspaceDraftPreview',{examples:[{orderReference:summary.orderReference,source:'Sales orders',
    lines:detail.lines.map(line=>({lineId:line.lineId,sku:line.sku,quantity:String(line.orderedQuantity),unit:line.unit})),
    packages:['PKG92','PKG93'],events:[{kind:'packing',source:'Packing bench',fileName:'packages.xml',occurredAt:'2026-11-17T12:02:00Z',shared:false}]}],
    scannedFiles:3,unresolved:0,unreadFiles:0,limited:false});
  const expression = text => '[...document.querySelectorAll("button")].find(b=>b.textContent.trim() === '+JSON.stringify(text)+')';
  for(const theme of ['light','dark']) {
    for(const [width,height,scale] of [[1280,900,1],[1280,900,1.25],[1280,900,1.5],[1280,900,2]]) {
      const cssWidth=Math.round(width/scale);
      await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:cssWidth,height:Math.round(height/scale),deviceScaleFactor:scale,mobile:false});
      await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
      for(const scene of situations) {
        stage('packaged workspace '+theme+' '+scale+' '+scene.name);
        const localSources=structuredClone(sources);
        if(scene.recognition) {
          const affected=localSources.find(item=>item.roles.includes(scene.step)) || localSources[0];
          affected.recognition={state:scene.recognition,message:scene.message};
        }
        setStatus({...state,workspace:{step:scene.step,phase:scene.step==='overview'?'active':'draft',sources:localSources,orders:[summary],outputState:'ready',outputFolder:'C:\\Sample operation\\Proofs'},
          proofOutput:{folder:'C:\\Sample operation\\Proofs',pending:scene.pending ? 1 : 0,state:scene.pending ? 'pending' : 'ready'}});
        await page.loadURL(appUrl);
        await waitFor(page,'document.querySelector("h1")?.textContent === '+JSON.stringify(headings[scene.step]));
        if(scene.step==='review') await waitFor(page,'document.body.innerText.includes('+JSON.stringify(summary.orderReference)+')');
        if(scene.navigation) {
          await reach(page,expression(scene.navigation)); await keyboard(page,'Enter',13);
          await waitFor(page,'document.querySelector("h1")?.textContent === '+JSON.stringify(scene.navigation));
        }
        if(scene.detail) {
          const link='document.querySelector(".ws-order-link")';
          await reach(page,link); await keyboard(page,'Enter',13);
          await waitFor(page,'!!document.querySelector("article.ws-record")');
        }
        if(scene.message) await waitFor(page,'document.body.innerText.includes('+JSON.stringify(scene.message)+')');
        if(scene.pending) await waitFor(page,'document.body.innerText.toLowerCase().includes("local copies pending")');
        await page.executeJavaScript('document.fonts.ready.then(()=>true)');
        await checkPage(page,cssWidth);
        const tree=await page.debugger.sendCommand('Accessibility.getFullAXTree');
        assert.ok(tree.nodes.some(node=>node.role?.value==='heading' && node.name?.value=== (scene.navigation || headings[scene.step])),'Missing accessible screen heading');
        if(scale===1) {
          // Capture the complete page even when the window itself must scroll.
          const {cssContentSize}=await page.debugger.sendCommand('Page.getLayoutMetrics');
          const {data}=await page.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:Math.ceil(cssContentSize.width),height:Math.ceil(cssContentSize.height),scale:1}});
          fs.writeFileSync(path.join(directory,scene.name+'-'+theme+'.png'),Buffer.from(data,'base64'));
        }
        report.runs.push({scene:scene.name,theme,width,height,scale,cssWidth});
      }
    }
  }
};
