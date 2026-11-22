// Exercises the built renderer with local synthetic state in a disposable Electron session.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserWindow, ipcMain, net, protocol } = require("electron");

const root = path.join(__dirname, "..");
const unified = process.argv.includes("--unified-workspace");
const packaged = unified || process.argv.includes("--packaged-workspace");
const assets = packaged ? path.join(root,"release",process.env.APP_ENV || "development","win32-x64","win-unpacked","resources","app.asar") : root;
if (unified) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(assets,"package.json"),"utf8")).main,"dist/commerce/main/index.cjs","Unified workspace evidence requires the actual unified host package");
  assert.ok(fs.existsSync(path.join(assets,"dist","commerce","main","preload.cjs")),"Unified host preload is missing");
}
const renderer = path.join(assets, "dist", "renderer");
const appUrl = "packproof-connect://app/index.html";
protocol.registerSchemesAsPrivileged([{scheme:"packproof-connect", privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.enableSandbox();
const report = { scope: unified ? "actual unified ASAR Logistics renderer and production preload; isolated synthetic IPC state" : packaged ? "packaged ASAR renderer and preload; isolated synthetic IPC state" : "synthetic Electron renderer", sourceCommit: process.env.GITHUB_SHA || null, platform: process.platform, electron: process.versions.electron, runs: [] };
const out = path.join(root, "build", unified ? "unified-ux-screens/workspace-layout.json" : packaged ? "workspace-layout.json" : "renderer-layout.json");
let watchdog;

function saveReport() {
  fs.mkdirSync(path.dirname(out), {recursive:true});
  fs.writeFileSync(out, JSON.stringify(report,null,2));
}

function stage(name) {
  clearTimeout(watchdog);
  report.stage = name;
  saveReport();
  watchdog = setTimeout(() => {
    report.error = `Timed out after 45 seconds during ${name}`;
    saveReport();
    console.error(report.error, report.currentRun);
    app.exit(1);
  }, 45000);
}

async function waitFor(page, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.executeJavaScript(predicate)) return;
    await delay(50);
  }
  const actual = await page.executeJavaScript(`({
    heading: document.querySelector("h1")?.textContent,
    bridge: typeof window.packproofConnect?.getStatus,
    focused: document.activeElement?.textContent?.trim().slice(0,100),
    ready: document.readyState,
  })`);
  throw new Error(`Renderer did not reach expected state: ${predicate}; observed ${JSON.stringify(actual)}`);
}

function button(name) {
  return `[...document.querySelectorAll("button")].find(el => el.textContent.trim() === ${JSON.stringify(name)})`;
}

async function keyboard(page, key, code) {
  const params = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { ...params, type: "keyDown", ...(key === "Enter" ? { text: "\r" } : {}) });
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

async function reach(page, target) {
  for (let count = 0; count < 35; count++) {
    if (await page.executeJavaScript(`document.activeElement === (${target})`)) return;
    await keyboard(page, "Tab", 9);
  }
  throw new Error("Cannot reach control with Tab: " + target);
}

async function checkPage(page, cssWidth) {
  const measured = await page.executeJavaScript(`({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll("button, input, select, summary")].filter(el => {
      const box = el.getBoundingClientRect();
      return el.checkVisibility() && box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(el => el.textContent.trim().slice(0,80))
  })`);
  assert.equal(measured.viewport, cssWidth);
  assert.ok(measured.document <= cssWidth + 1, JSON.stringify(measured));
  assert.deepEqual(measured.clipped, []);
}

async function exercise(page, width, height, scale, theme) {
  const cssWidth = Math.round(width / scale);
  report.currentRun = {width, height, scale, theme, cssWidth};
  console.log("Checking renderer", report.currentRun);
  stage("emulate display");
  await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: cssWidth, height: Math.round(height / scale), deviceScaleFactor: scale, mobile: false });
  await page.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name:"prefers-color-scheme", value:theme }, { name:"prefers-reduced-motion", value:"reduce" }] });
  stage("load built renderer");
  await page.loadURL(appUrl);
  stage("verify Logistics recovery has explicit legacy choice");
  await waitFor(page, 'document.querySelector("h1")?.textContent === "Your Logistics workspace needs attention"');
  await checkPage(page, cssWidth);
  await reach(page, button("Open earlier connection tools"));
  await keyboard(page, "Enter", 13);
  stage("wait for explicitly selected earlier Connect workflow");
  await waitFor(page, 'document.querySelector("h1")?.textContent === "We found your shipments."');
  stage("wait for fonts and measure preview");
  await page.executeJavaScript("document.fonts.ready.then(() => true)");
  await checkPage(page, cssWidth);
  stage("confirm shipment preview with keyboard");
  await reach(page, button("Yes, this looks right"));
  await keyboard(page, "Enter", 13);
  await waitFor(page, `!!(${button("Review permissions in browser")}) && !(${button("Review permissions in browser")}).disabled`);
  await checkPage(page, cssWidth);
  stage("review access details with keyboard");
  await reach(page, button("Review full access details"));
  await keyboard(page, "Enter", 13);
  await waitFor(page, '!!document.querySelector("[role=dialog]")');
  await checkPage(page, cssWidth);
  await keyboard(page, "Escape", 27);
  await waitFor(page, `!document.querySelector("[role=dialog]") && document.activeElement === (${button("Review full access details")})`);
  report.runs.push({width, height, scale, theme, cssWidth});
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "packproof-layout-"));
  app.setPath("userData", temp);
  let win;
  try {
    stage("prepare synthetic fixture");
    const { build } = require("esbuild");
    const fixture = path.join(temp, "fixture.cjs");
    await build({entryPoints:[path.join(root, "ui/test-shipment.ts")], outfile:fixture, bundle:true, platform:"node"});
    stage("create Electron window");
    await app.whenReady();
    protocol.handle("packproof-connect", async request => {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response(null,{status:403});
      const file = path.resolve(renderer, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(renderer + path.sep)) return new Response(null,{status:403});
      const response = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body,{status:response.status,headers});
    });
    win = new BrowserWindow({show:true, webPreferences:{preload:path.join(assets,"dist","main","preload.cjs"),sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}});
    win.focus();
    const page = win.webContents;
    stage("start renderer before attaching device emulation");
    await page.loadURL("about:blank");
    stage("attach renderer diagnostics");
    page.debugger.attach("1.3");
    await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    page.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]}, (_details, next) => next({cancel:true}));
    const state = require(fixture).selected;
    const version = "packproof.shipment-interpretation/v1";
    state.analysis.interpretation = { version, outcome: "automatic", grain: "shipment", reasonCodes: [] };
    state.capabilities.interpretationVersions = [version];
    let currentState = state;
    for (const method of ["getStatus","getWorkspaceStatus","checkComputer"]) {
      ipcMain.handle("connect:" + method, event => {
        assert.equal(event.sender, page);
        assert.equal(event.senderFrame.url, appUrl);
        const now = Date.now();
        return {ok:true,value:{...currentState,transport:{...currentState.transport,attemptedAt:new Date(now-1000).toISOString(),
          succeededAt:new Date(now-500).toISOString(),expiresAt:new Date(now+100000).toISOString()}}};
      });
    }
    page.on("preload-error", (_event, _file, error) => console.error("Preload failed:",error.message));
    page.on("console-message", details => {
      if (details.level === "error") console.error("Renderer:",details.message);
    });
    if (packaged) {
      const harness={page,state,appUrl,report,stage,reach,keyboard,waitFor,checkPage,
        directory:path.join(root,"build",unified ? "unified-ux-screens/workspace-screens" : "workspace-screens"), setStatus:next=>{ currentState=next; },
        ...(unified ? {themes:["light"],displayCases:[[1440,900,1],[1280,800,1.25]],captureViewport:true,includeGuidedSetup:true} : {}),
        register:(method,data)=>{
          ipcMain.removeHandler("connect:"+method);
          ipcMain.handle("connect:"+method,async (event,...args)=>{
            assert.equal(event.sender,page);
            assert.equal(event.senderFrame.url,appUrl);
            const value=typeof data === "function" ? await data(...args) : data;
            return {ok:true,value};
          });
        }};
      await require("./workspace-layout.cjs")(harness);
      await require("./workspace-walkthrough.cjs")(harness);
    } else for (const [width,height] of [[1280,720],[1920,1080],[560,720]]) {
      for (const scale of (width === 560 ? [1] : [1,1.25,1.5,2])) {
        for (const theme of ["light","dark"]) await exercise(page, width,height,scale,theme);
      }
    }
    report.stage = "complete";
    delete report.currentRun;
    console.log("Validated",report.runs.length,"synthetic renderer layouts with keyboard navigation.");
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    clearTimeout(watchdog);
    saveReport();
    if (win && !win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
