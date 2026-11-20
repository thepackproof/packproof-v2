const { BrowserWindow } = require('electron');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {buildSync} = require('esbuild');
const assert = require('node:assert/strict');

async function waitForPage(contents, expression, label) {
  for (let i=0;i<65;i++) {
    try {if(await contents.executeJavaScript(expression)) return;} catch { /* Document navigation. */ }
    await delay(150);
  }
  const observed = await contents.executeJavaScript("Array.from(document.querySelectorAll('h1,h2,[role=alert]'),e=>e.textContent.trim().slice(0,120)).slice(0,8)");
  throw Error(label + ' — ' + observed.join(' / '));
}
async function findCarton(contents, carton) {
  await waitForPage(contents,"!!document.querySelector('#order-ref')",'The order lookup did not open');
  await contents.executeJavaScript("const type=document.querySelector('form[role=search] select');type.value='package';type.dispatchEvent(new Event('change',{bubbles:true}));");
  await contents.executeJavaScript("document.querySelector('#order-ref').focus()");
  await contents.insertText(carton);
  await contents.executeJavaScript("document.querySelector('form[role=search] button[type=submit]').click()");
  const anchor = "Array.from(document.querySelectorAll('a')).find(a=>a.textContent.trim()===" + JSON.stringify('Carton ' + carton) + ")";
  await waitForPage(contents,'!!('+anchor+')','Carton missing from authorized results');
  await contents.executeJavaScript('('+anchor+').click()');
}
async function verify(contents, proof, historical) {
  const revision = historical ? proof.historicalRevision : proof.revision;
  const state = historical ? 'Awaiting delivery evidence' : 'Delivery supported by evidence';
  await waitForPage(contents,`document.querySelector('h1')?.textContent.includes('SO-10482') &&
    location.pathname.endsWith('/'+${JSON.stringify(proof.id)}) && location.search.includes('subject=CTN-02') &&
    Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Download revision '+${revision}) &&
    Array.from(document.querySelectorAll('p')).some(p=>p.textContent===${JSON.stringify(state)})`,
    'Mismatch between selected proof, carton, delivery evidence and saved revision');
}
module.exports = async function browserCartonJourney({browser,origin,scope,fixture}) {
  const proof=fixture.proof;
  if(proof.carton!=='CTN-02' || !Number.isSafeInteger(proof.historicalRevision) || proof.historicalRevision>=proof.revision) throw Error('Unexpected reference order fixture');
  scope.set('locationId',proof.locationId);
  await browser.loadURL(origin+'/app/order-proofs?'+scope);
  await findCarton(browser,proof.carton);
  await verify(browser,proof,false);
  const current=new URL(browser.getURL());
  current.searchParams.set('revision',String(proof.historicalRevision));
  await browser.loadURL(current.href);
  await verify(browser,proof,true);

  // Run the installed host's actual dashboard window and isolated preload against
  // the same loopback HTTP app and the authenticated human used by the web portal.
  const bundleDir=path.join(path.dirname(process.env.PACKPROOF_BROWSER_FIXTURE),'dashboard-bundle');
  for(const name of ['human-dashboard','dashboard-preload']) buildSync({
    entryPoints:[path.join(__dirname,'../main',name+'.ts')],outfile:path.join(bundleDir,name+'.cjs'),
    bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'
  });
  const {openHumanDashboard,closeHumanDashboard}=require(path.join(bundleDir,'human-dashboard.cjs'));
  const owner={organizationId:scope.get('organizationId'),environment:scope.get('environment'),
    locationId:proof.locationId,expectedUserId:fixture.owner};
  const identity={apiBaseUrl:origin+'/api',userId:fixture.owner,displayName:'Fixture owner',username:'fixture-owner',token:async()=>fixture.owner};
  try {
    await openHumanDashboard(origin,owner,{},identity);
    const dashboard=BrowserWindow.getAllWindows().find(w=>w.webContents!==browser && w.webContents.getURL().includes('desktopUser='));
    if(!dashboard) throw Error('Isolated human dashboard did not open');
    const contents=dashboard.webContents;
    const session=await contents.executeJavaScript('({user:window.packproofDashboardSession?.userId,opaque:window.packproofDashboardSession?.token!==window.packproofDashboardSession?.userId,deviceBridge:!!window.packproofConnect})');
    assert.deepEqual(session,{user:fixture.owner,opaque:true,deviceBridge:false});
    await findCarton(contents,proof.carton);
    await verify(contents,proof,false);
    await openHumanDashboard(origin,owner,{proofId:proof.id,revision:proof.historicalRevision,subject:proof.carton,
      subjectType:'package',namespace:current.searchParams.get('namespace')},identity);
    await verify(contents,proof,true);
    console.log('Verified paired web and isolated Windows human dashboard for CTN-02, revisions',proof.historicalRevision,proof.revision);
  } finally {closeHumanDashboard();}
};
