#!/usr/bin/env node
'use strict';
// Static HTML/CSS document frames, not browser or native screenshots.
const fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const out=path.resolve(process.argv[2]||'design-frames');fs.mkdirSync(out,{recursive:true});
const d=new JSDOM(fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),{runScripts:'dangerously'});
const a=d.window.Prototype;a.setAutoAdvance(false);const frames=[];
function frame(screen,scenario,theme,scale,width=360,label='',viewState='standard',section='core'){
 a.setScenario(scenario);a.setAutoAdvance(false);a.setTheme(theme);a.setScale(scale);a.setWidth(width);a.navigate(screen);if(viewState!=='standard')a.setViewState(viewState);
 let h=a.snapshot().html.replace(/calc\(([0-9.]+)px \* var\(--scale\)\)/g,(_,x)=>(Number(x)*scale)+'px');
 const navHeight=scale===2?86:70; const bodyHeight=780-26-56-15-(screen==='camera'?0:navHeight);
 h=h.replace('</head>',`<style>
 @page{size:${width}px 780px;margin:0}html,body{display:block!important;min-height:0!important;width:${width}px!important;margin:0!important;padding:0!important;background:${theme==='dark'?'#111c2b':'#f5f8fc'}!important}
 .snapshot-caption{display:none!important}.phone{margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;width:${width}px!important;height:780px!important;max-width:none!important;display:block!important}
 .app-body{position:absolute!important;top:82px!important;left:0!important;right:0!important;height:${bodyHeight}px!important;min-height:0!important;overflow:hidden!important}.page{min-height:0!important}.bottom-nav{position:absolute!important;bottom:15px!important;left:0!important;right:0!important;height:${navHeight}px!important}.status-bar{height:26px!important}.appbar{height:56px!important}.android-bar{position:absolute!important;bottom:0!important;left:0!important;right:0!important;height:15px!important;display:flex!important;justify-content:center;align-items:center}
 .appbar .icon-button{display:flex!important;align-items:center;justify-content:center;width:48px!important;max-width:48px!important;flex:0 0 48px!important;padding:9px!important}.avatar{display:flex!important;align-items:center;justify-content:center;flex:0 0 29px!important}.tile-icon{display:flex!important;align-items:center;justify-content:center}
 .btn{display:block!important;min-height:48px!important;line-height:${20*scale}px!important;padding:13px!important}.sheet-head h2,.section-heading h2{flex:1!important}.section-heading .text-button{flex:0 0 auto!important;min-width:48px!important}.nav-item{display:block!important;text-align:center}.nav-item .icon{display:block!important;margin:0 auto 4px}.phone button{font-weight:700!important}
 .overlay{top:0!important;right:0!important;bottom:0!important;left:0!important}.sheet{max-height:650px!important}.phone svg{fill:none;stroke:currentColor}
 </style></head>`);
 const s=new JSDOM(h);for(const button of s.window.document.querySelectorAll('button')){const div=s.window.document.createElement('div');for(const at of button.attributes)div.setAttribute(at.name,at.value);div.innerHTML=button.innerHTML;button.replaceWith(div);}for(const detail of s.window.document.querySelectorAll('details:not([open])')){for(const child of [...detail.children])if(child.tagName!=='SUMMARY')child.remove();}for(const el of s.window.document.querySelectorAll('svg')){el.setAttribute('fill','none');el.setAttribute('stroke',theme==='dark'?'#acbdcf':'#53657b');el.setAttribute('stroke-width','1.7');}
 const id=[String(frames.length+1).padStart(2,'0'),screen,scenario,theme,scale,width,viewState].join('-');fs.writeFileSync(path.join(out,id+'.html'),s.serialize());s.window.close();frames.push({id,screen,scenario,theme,scale,width,viewState,section,label:label||screen});
}
for(const screen of a.screens){for(const theme of ['light','dark'])frame(screen,screen==='review'?'fresh':screen==='updates'?'failed':'resume',theme,1);}
for(const screen of a.screens){for(const theme of ['light','dark'])frame(screen,screen==='review'?'fresh':screen==='updates'?'failed':'resume',theme,2);}
for(const [screen,scenario] of [['home','fresh'],['home','loading'],['home','error'],['upload','offline'],['upload','failed'],['recovery','capture-interrupted'],['upload','unknown-ack'],['evidence','finalized'],['home','waiting'],['policy','policy-blocked'],['permission','permission-denied'],['storage','no-storage'],['capture','orders'],['signing','signing-unavailable'],['history','history-empty']])frame(screen,scenario,'light',1);
for(const screen of a.screens)for(const mode of ['empty','loading','error','offline'])if(/^modeled/i.test(a.stateCoverage[screen][mode]))for(const theme of ['light','dark'])frame(screen,screen==='review'?'fresh':'resume',theme,1,360,'',mode,'states');
for(const scenario of ['integration-authorizing','integration-canceled','integration-error','integration-expired'])for(const theme of ['light','dark'])frame('integrations',scenario,theme,1,360,'','standard','states');
fs.writeFileSync(path.join(out,'frames.json'),JSON.stringify(frames,null,2));d.window.close();console.log(JSON.stringify({frames:frames.length,directory:out}));
