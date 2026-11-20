import { contextBridge, ipcRenderer } from 'electron';
// The web page receives an opaque in-process session handle. The human credential stays in main.
if (process.isMainFrame) {
  const view = ipcRenderer.sendSync('logistics:dashboard-session');
  if (view) {
    contextBridge.exposeInMainWorld('packproofDashboardSession', view);
    contextBridge.exposeInMainWorld('closePackProofDashboard', () => ipcRenderer.send('logistics:dashboard-close'));
  }
}
