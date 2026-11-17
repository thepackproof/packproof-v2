const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const selector = (tag,text) => '[...document.querySelectorAll('+JSON.stringify(tag)+')].find(el=>el.checkVisibility() && el.textContent.trim()==='+JSON.stringify(text)+')';

// The actual packaged preload, renderer, keyboard events and accessibility tree
// participate. Only the external service, native folder dialogs and browser grants
// are simulated. This test does not stand in for observation of a first-time operator.
module.exports = async function workspaceWalkthrough({page,state,setStatus,register,stage,reach,keyboard,waitFor,checkPage,report,appUrl,directory}) {
  const scope = {environment:'development',installationId:'sample-accessibility-installation',
    capabilities:{...state.capabilities,orderWorkspace:true},config:undefined,sourceSubscriptions:[],binding:{organizationName:'Sample warehouse'}};
  const documentFolder='C:\\Sample warehouse\\Sales';
  const packingFolder='C:\\Sample warehouse\\Packing';
  const shippingFolder='C:\\Sample warehouse\\Shipping';
  const output='C:\\Sample warehouse\\Saved proofs';
  const example={proofId:'sample-proof',revision:4,orderReference:'SO10482'};
  let workspace={phase:'draft',step:'order',sources:[],orders:[],outputState:'unselected',outputFolder:null};
  const calls=[];
  function publish(update) {
    workspace={...workspace,...update};
    const response={...state,...scope,workspace,proofOutput:{folder:workspace.outputFolder,state:workspace.outputState==='ready'?'ready':'not_configured',pending:0}};
    setStatus(response);
    return response;
  }
  const source=(id,folder,role,recognition)=>({id,folder,roles:[role],generation:1,state:'pending',recognition});
  const replaceSource=(index,next)=>publish({sources:workspace.sources.map((s,i)=>i===index?next:s)});
  register('saveWorkspaceStep',step=>publish({step}));
  register('chooseWorkspaceFolder',role=>{
    calls.push('choose '+role);
    const next=role==='order'
      ? source('sales',documentFolder,role,{state:'recognized',message:'Found order numbers, items and quantities.',sample:{orderReference:'SO10482',item:'A100',quantity:'2'}})
      : role==='packing'
      ? source('packing',packingFolder,role,{state:'empty',message:'Waiting for the first report.'})
      : source('shipping',shippingFolder,role,{state:'ambiguous',message:'Read the shipping report.',question:'Does Sales order refer to the order in Sales?',suggestedOrderColumn:'Sales order',profileVersion:'fixture-v1',sample:{'Sales order':'SO10482'}});
    return publish({sources:[...workspace.sources,next]});
  });
  register('addWorkspaceDirectSource',()=>{
    calls.push('add direct connection');
    return publish({sources:[...workspace.sources,{...source('api','','order',{state:'empty',message:'Waiting for the first order.'}),displayName:'PackProof Partner API',transport:'api',sourceNamespace:'partner-api'}]});
  });
  register('reuseWorkspaceFolder',(id,role)=>{
    assert.equal(id,'sales');assert.equal(role,'picking');calls.push('reuse sales');
    return replaceSource(0,{...workspace.sources[0],generation:2,roles:['order','picking']});
  });
  register('confirmWorkspaceOrderMap',(id,generation,version)=>{
    assert.equal(id,'shipping');assert.equal(generation,1);assert.equal(version,'fixture-v1');calls.push('confirm shipping');
    const index=workspace.sources.findIndex(item=>item.id===id);
    return replaceSource(index,{...workspace.sources[index],generation:2,recognition:{state:'recognized',message:'Found shipment and tracking references.'}});
  });
  register('chooseWorkspaceOutput',()=>{calls.push('choose output');return publish({outputFolder:output,outputState:'ready'});});
  register('activateWorkspace',()=>{
    assert.equal(workspace.outputState,'ready');
    assert.equal(workspace.sources.length,4);
    calls.push('request reviewed access');
    return publish({phase:'awaiting_approval',approvalPath:'/app/records/connect/approve?installationId=sample-accessibility-installation'});
  });
  register('workspaceSearchOrders',query=>{assert.equal(query,'SO10482');calls.push('find order');return [example];});
  register('workspaceOrderDetail',(id,revision)=>{
    assert.equal(id,example.proofId);assert.equal(revision,4);calls.push('read revision');
    return {...example,lines:[{sku:'A100',lineId:'20',orderedQuantity:'2',unit:'EA'}],events:[{kind:'packing',sourceName:'Packing'}],evidence:[{fileName:'packing.jpg'}]};
  });
  register('workspaceDraftPreview',{scannedFiles:2,limited:true,unresolved:0,unreadFiles:0,examples:[
    {orderReference:'SO10482',source:'Sales',lines:[{lineId:'20',sku:'A100',quantity:'2',unit:'EA'}],packages:['PKG92'],events:[{kind:'label',source:'Shipping',fileName:'labels.csv',occurredAt:'',shared:false}]}
  ]});
  const target=(tag,text)=>selector(tag,text);
  async function press(tag,text) {
    const match=target(tag,text);
    await waitFor(page,'!!('+match+') && !('+match+').disabled');
    await reach(page,match);
    const visibleFocus=await page.executeJavaScript('document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle!=="none"');
    assert.ok(visibleFocus,'Expected a visible keyboard focus indicator for '+text);
    await keyboard(page,'Enter',13);
  }
  async function heading(text) {
    await waitFor(page,'document.querySelector("h1")?.textContent==='+JSON.stringify(text));
    await checkPage(page,640);
    const visible=await page.executeJavaScript('document.body.innerText');
    assert.doesNotMatch(visible,/scopeDigest|configurationRevision|grantRevision|schemaVersion|SHA-256|fixture-v1/);
    const tree=await page.debugger.sendCommand('Accessibility.getFullAXTree');
    assert.ok(tree.nodes.some(node=>node.role?.value==='heading'&&node.name?.value===text),'Screen heading needs an accessible name.');
  }
  async function checkContrast() {
    const measurements=await page.executeJavaScript(`(()=>{
      function luminance(value) {
        const channels=value.match(/[0-9.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
        return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
      }
      const results=[];
      for(const node of document.querySelectorAll(".ws-panel h1,.ws-panel p,.ws-panel button,.ws-panel summary,.ws-step-header span,.ws-step-header button")) {
        if(!node.checkVisibility() || node.matches(":disabled,[aria-hidden=true]") || !node.textContent.trim())continue;
        let parent=node,background;
        while(parent) {
          const value=getComputedStyle(parent).backgroundColor;
          if(value!=="rgba(0, 0, 0, 0)" && value!=="transparent"){background=value;break;}
          parent=parent.parentElement;
        }
        if(!background)continue;
        const style=getComputedStyle(node),a=luminance(style.color),b=luminance(background);
        const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        const minimum=parseFloat(style.fontSize)>=24 || parseFloat(style.fontSize)>=18.66 && parseInt(style.fontWeight)>=700 ? 3 : 4.5;
        results.push({label:node.textContent.trim().slice(0,55),ratio,minimum});
      }
      return results;
    })()`);
    assert.ok(measurements.length>=4,"Expected visible text and controls for contrast checks.");
    for(const item of measurements)assert.ok(item.ratio>=item.minimum,JSON.stringify(item));
    return Math.min(...measurements.map(item=>item.ratio));
  }
  async function capture(name) {
    const {cssContentSize}=await page.debugger.sendCommand('Page.getLayoutMetrics');
    const {data}=await page.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:Math.ceil(cssContentSize.width),height:Math.ceil(cssContentSize.height),scale:1}});
    fs.writeFileSync(path.join(directory,'walkthrough-'+name+'.png'),Buffer.from(data,'base64'));
  }
  // Emulate the CSS viewport of a 1280x900 screen at 200% Windows scaling.
  await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:640,height:450,deviceScaleFactor:2,mobile:false});
  await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'reduce'}]});
  stage('keyboard walkthrough: select sales records and a direct order source');
  publish({});await page.loadURL(appUrl);await heading('Order records');
  const minimumContrast={};
  for(const theme of ['dark','light']){
    await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
    await waitFor(page,'matchMedia("(prefers-color-scheme: '+theme+')").matches');
    minimumContrast[theme]=await checkContrast();
  }
  await press('button','Choose folder');await waitFor(page,'document.body.innerText.includes("SO10482")');
  await waitFor(page,'document.activeElement?.dataset.folderPicker==="order"');
  await press('summary','Connect a system instead');await press('button','Connect PackProof Partner API');
  await waitFor(page,'document.body.innerText.includes("Waiting for the first order.")');
  await press('button','Next');await heading('Picking records');
  stage('keyboard walkthrough: resume and share the same folder across roles');
  await page.loadURL(appUrl);await heading('Picking records');
  await press('summary','Use an existing location');
  await reach(page,'document.querySelector(".ws-reuse select")');await keyboard(page,'ArrowDown',40);
  await press('button','Use this location');await waitFor(page,'document.body.innerText.includes("Found order numbers")');
  await press('button','Next');await heading('Packing and evidence');
  stage('keyboard walkthrough: empty and ambiguous reports');
  await press('button','Choose folder');await waitFor(page,'document.body.innerText.includes("Waiting for the first report.")');
  await press('button','Next');await heading('Shipping records');await press('button','Choose folder');
  await waitFor(page,'document.body.innerText.includes("Does Sales order refer")');
  await capture('ambiguity');await press('button','Confirm this reference');
  await waitFor(page,'document.body.innerText.includes("Found shipment and tracking references.")');
  await press('button','Next');await heading('Review an order');
  await waitFor(page,'document.body.innerText.includes("SO10482") && document.body.innerText.includes("PKG92") && document.body.innerText.includes("labels.csv")');
  stage('keyboard walkthrough: review the order, destination and exact access');
  await press('button','Next');await heading('Where should PackProof save your proofs?');
  await press('button','Choose proof folder');await waitFor(page,'document.body.innerText.includes("background service can save proofs")');
  await press('button','Next');await heading('Start collecting');
  const access=await page.executeJavaScript('document.body.innerText');
  for(const required of [documentFolder,packingFolder,shippingFolder,output,'PackProof Partner API','existing files','new or changed files','upload and retain','online'])assert.ok(access.includes(required),'Missing access summary: '+required);
  await capture('access');
  stage('keyboard walkthrough: confirm approval continuation and find the order');
  await press('button','Start collecting');await waitFor(page,'document.body.innerText.includes("Open browser review")');
  // Only the external approval event is injected. The renderer must notice the
  // change through its own poll and leave the pending screen without a click.
  publish({step:'overview',phase:'active',approvalPath:null,orders:[example],sources:workspace.sources.map(item=>({...item,state:'active'}))});
  await heading('Overview');await press('button','Orders');await heading('Orders');
  await reach(page,'document.querySelector("input")');await page.debugger.sendCommand('Input.insertText',{text:'SO10482'});
  await press('button','Find order');
  await waitFor(page,'document.body.innerText.includes("Show recent orders")');
  await reach(page,'document.querySelector(".ws-order-link")');await keyboard(page,'Enter',13);
  await waitFor(page,'document.querySelector(".ws-record")?.innerText.includes("packing.jpg")');
  await capture('order');
  assert.deepEqual(calls,['choose order','add direct connection','reuse sales','choose packing','choose shipping','confirm shipping','choose output','request reviewed access','find order','read revision']);
  report.keyboardWalkthrough={scope:'Packaged renderer, real keyboard events, synthetic service and browser decision',cssWidth:640,scale:2,minimumTextContrast:minimumContrast,checks:calls};
};

