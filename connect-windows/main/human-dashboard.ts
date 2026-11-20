import { BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { allowedDashboardRequest, type HumanDashboardIdentity } from './dashboard-grant';
import { randomUUID } from 'node:crypto';

export interface DashboardScope {
  organizationId: string;
  environment: string;
  expectedUserId: string;
  locationId?: string | null;
}
type Target = { proofId?: string; revision?: number; subject?: string; namespace?: string; subjectType?: string };
let current: { owner: string; window: BrowserWindow } | undefined;

export function closeHumanDashboard(): void {
  const previous = current;
  current = undefined;
  if (previous && !previous.window.isDestroyed()) previous.window.destroy();
}

export async function openHumanDashboard(webBaseUrl: string, scope: DashboardScope, target: Target = {}, identity?: HumanDashboardIdentity): Promise<void> {
  const origin = new URL(webBaseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || (local && origin.protocol === 'http:')) || origin.username || origin.password)
    throw Error('The configured dashboard address is unavailable.');
  const id = /^[A-Za-z0-9_-]{1,160}$/;
  if (!scope.expectedUserId || !id.test(scope.organizationId) || !['sandbox','live'].includes(scope.environment) ||
      (scope.locationId && !id.test(scope.locationId)) || (target.proofId !== undefined && !id.test(target.proofId)) ||
      (target.revision !== undefined && (!target.proofId || !Number.isSafeInteger(target.revision) || target.revision < 1)))
    throw Error('Reopen the dashboard from your signed-in workspace.');
  const url = new URL('/app/order-proofs' + (target.proofId ? '/' + target.proofId : ''), origin);
  url.searchParams.set('organizationId', scope.organizationId);
  url.searchParams.set('environment', scope.environment);
  url.searchParams.set('desktopUser', scope.expectedUserId);
  if (scope.locationId) url.searchParams.set('locationId', scope.locationId);
  if (target.revision) url.searchParams.set('revision', String(target.revision));
  if (target.subject) url.searchParams.set('subject', target.subject);
  if (target.namespace) url.searchParams.set('namespace', target.namespace);
  if (target.subjectType) url.searchParams.set('subjectType', target.subjectType);
  const owner = JSON.stringify([origin.origin, scope.expectedUserId, scope.organizationId, scope.environment, scope.locationId]);
  if (current?.owner !== owner) closeHumanDashboard();
  if (!current) {
    // In-memory, per-owner sign-in. The remote page has no preload or access to the collector.
    const isolated = session.fromPartition('logistics-' + randomUUID(), { cache: false });
    isolated.setUserAgent(isolated.getUserAgent() + ' PackProofLogistics/1');
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const window = new BrowserWindow({ title: 'PackProof Logistics', width: 1240, height: 880, show: false,
      webPreferences: { session: isolated, ...(identity ? {preload: join(__dirname,'dashboard-preload.cjs')} : {}), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, webviewTag: false } });
    if (identity) {
      const handle = randomUUID();
      const expires = Date.now() + 15 * 60 * 1000;
      const urlAllowed = (href: string) => { try { return new URL(href).origin === origin.origin; } catch { return false; } };
      const active = () => !window.isDestroyed() && current?.window === window && Date.now() < expires && identity.userId === scope.expectedUserId;
      const bootstrap = (event: Electron.IpcMainEvent) => {
        event.returnValue = active() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
          urlAllowed(event.senderFrame.url) ? { apiBaseUrl: identity.apiBaseUrl, userId: identity.userId, subject: identity.userId,
          username: identity.username, displayName: identity.displayName, authMode:'cognito', token:handle, refreshToken:null, accessExpiresAt:expires } : null;
      };
      ipcMain.on('logistics:dashboard-session',bootstrap);
      const close = (event: Electron.IpcMainEvent) => {
        if (!window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) window.close();
      };
      ipcMain.on('logistics:dashboard-close',close);
      const expire = setTimeout(() => {
        if (!window.isDestroyed()) { window.destroy(); identity.expired?.(); }
      }, expires - Date.now());
      window.once('closed',() => { clearTimeout(expire); ipcMain.off('logistics:dashboard-session',bootstrap); ipcMain.off('logistics:dashboard-close',close); });
      isolated.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = {...details.requestHeaders};
        const names = Object.keys(headers).filter(key => key.toLowerCase() === 'authorization');
        const authenticated = names.some(key => headers[key] === 'Bearer '+handle);
        for (const key of names) delete headers[key];
        if (!authenticated) return callback({requestHeaders:headers});
        if (!active() || details.webContentsId !== window.webContents.id || !urlAllowed(window.webContents.getURL()) ||
            !allowedDashboardRequest(details.url,details.method,identity.apiBaseUrl,scope)) return callback({cancel:true});
        void identity.token().then(token => {
          if (!active() || !token) return callback({cancel:true});
          callback({requestHeaders:{...headers,Authorization:'Bearer '+token}});
        },() => callback({cancel:true}));
      });
    }
    const guard = (event: Electron.Event, href: string) => {
      try { if (new URL(href).origin === origin.origin) return; } catch { /* Deny malformed navigation. */ }
      event.preventDefault();
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.once('closed', () => {
      if (current?.window === window) current = undefined;
      void isolated.clearStorageData().catch(() => {});
    });
    current = { owner, window };
  }
  const window = current.window;
  try {
    await window.loadURL(url.href);
    if (current?.window === window) { window.show(); window.focus(); }
  } catch (error) {
    if (current?.window === window) closeHumanDashboard();
    throw error;
  }
}
