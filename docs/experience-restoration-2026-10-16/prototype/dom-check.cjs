const fs=require('node:fs'),assert=require('node:assert/strict');
const path=require('node:path');
const {createRequire}=require('node:module');
const webRequire=createRequire(path.resolve(__dirname,'../../../web/package.json'));
const {JSDOM}=webRequire('jsdom');
const html=fs.readFileSync(process.argv[2],'utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
const w=dom.window,d=w.document;
w.structuredClone=structuredClone;
w.matchMedia=()=>({matches:false,addEventListener(){}});
w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};
const js=d.querySelector('script[type=module]').textContent;
w.eval(js);
const click=s=>{const e=d.querySelector(s);assert.ok(e,`Missing ${s}`);assert.equal(e.disabled,false,`Disabled ${s}`);e.click()};
const change=(s,value)=>{const e=d.querySelector(s);if(e.type==='checkbox')e.checked=value;else e.value=value;e.dispatchEvent(new w.Event('change',{bubbles:true}))};
const text=()=>d.querySelector('#app').textContent;
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS '+name)}
check('all seven scenarios render with exactly three in-Proof destinations',()=>{
 for(const s of ['start','photos','review','upload','recovery','saved','tools']){click(`[data-scene="${s}"]`);assert.ok(text().length>100);if(s!=='start')assert.equal(d.querySelectorAll('.destinations button').length,3)}
});
check('photo acceptance advances locally, then waits for item-step acknowledgment',()=>{
 click('[data-scene="photos"]');assert.match(text(),/Back photo/);click('[data-action="camera"]');click('[data-action="shutter"]');click('[data-action="accept-photo"]');
 assert.match(text(),/Item photos captured/);assert.match(text(),/Saved on this device/);click('[data-action="save-photos"]');assert.match(text(),/Finishing the item step/);click('[data-sim="photo-task"]');assert.match(text(),/Record the packing/);
});
check('ordinary journey requires declaration and waits for artifact plus finalization acknowledgments',()=>{
 click('[data-scene="review"]');assert.equal(d.querySelector('#declaration').checked,false);assert.equal(d.querySelector('[data-action="submit"]').disabled,true);change('#declaration',true);click('[data-action="submit"]');
 click('[data-sim="transferred"]');assert.match(text(),/Finishing save/);assert.doesNotMatch(text(),/Evidence saved/);click('[data-sim="artifact"]');assert.match(text(),/Finishing save/);click('[data-sim="finalize"]');assert.match(text(),/Evidence saved/);assert.match(text(),/Waiting for|Recipient participation/);
});
check('creating the same demo order resumes its existing saved record',()=>{
 click('[data-action="home"]');click('[data-action="create"]');click('[data-action="create-sale"]');assert.match(text(),/Evidence saved/);
});
check('offline keeps local original and offers a safe connection check',()=>{
 click('[data-scene="recovery"]');assert.match(text(),/Waiting for connection/);assert.equal(d.querySelector('[data-sim="transferred"]'),null);click('[data-action="reconnect"]');assert.ok(d.querySelector('[data-sim="transferred"]'));
});
check('wrong-Proof completion event leaves visible state unchanged',()=>{
 click('[data-scene="review"]');const old=text();click('[data-sim="wrong-proof"]');assert.equal(text(),old);
});
check('Home is guarded while recording and interruption is disclosed',()=>{
 click('[data-scene="start"]');click('[data-action="create"]');click('[data-action="create-sale"]');click('[data-action="camera"]');click('[data-action="shutter"]');click('[data-action="home"]');assert.equal(d.querySelector('#sheet').open,true);assert.match(text(),/Stop recording/);click('[data-action="interrupt-leave"]');assert.match(text(),/Recording interrupted/);
});
check('case packet includes an issue control, explicit source selection and preserved notes',()=>{
 click('[data-scene="tools"]');click('[data-action="packet"]');assert.equal(d.querySelector('[data-action="preview-packet"]').disabled,true);change('#issue','Reported condition / return difference');d.querySelector('#notes').value='The outer box was intact.';click('[data-action="preview-packet"]');assert.match(text(),/The outer box was intact/);click('[data-action="edit-packet"]');assert.equal(d.querySelector('#notes').value,'The outer box was intact.');
});
check('tools on an empty record do not invent saved sources',()=>{
 click('[data-scene="start"]');click('[data-action="create"]');click('[data-action="create-sale"]');click('[data-tab="Tools"]');click('[data-action="packet"]');assert.match(text(),/A saved original is needed/);assert.equal(d.querySelector('[data-action="preview-packet"]'),null);click('[data-action="tools-back"]');click('[data-action="compare"]');assert.match(text(),/No eligible packing and receiving pair/);
});
check('charcoal, 200% text and reduced motion controls remain available',()=>{
 change('#theme','dark');change('#text-scale','2');change('#motion',true);assert.equal(d.documentElement.dataset.theme,'dark');assert.equal(d.documentElement.style.getPropertyValue('--scale'),'2');assert.ok(d.documentElement.classList.contains('reduce-motion'));
});
check('standalone review has no external assets or template placeholders',()=>{
 assert.doesNotMatch(html,/__(?:FONT|POSTER|VIDEO|SYMBOL|WORDMARK|HISTORICAL)__/);assert.equal(d.querySelectorAll('[src^="http"],[href^="http"]').length,0);
});
console.log(`${checks} DOM interaction checks passed. Layout, video decoding and native behavior are not validated by jsdom.`);
dom.window.close();
