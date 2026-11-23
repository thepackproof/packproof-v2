import type { BrowserWindow } from 'electron';

/** Keep the protected Commerce host alive while showing a single native
 * workspace. Separate trusted preloads remain separate; no remote or Connect
 * document is loaded into Commerce's privileged webContents. */
export async function loadWorkspaceWindow(window: BrowserWindow, parent: BrowserWindow | null, url: string): Promise<void> {
  let ready = false, loaded = false, presented = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const shown = new Promise<void>((resolve,reject) => { resolveReady=resolve; rejectReady=reject; });
  const present = () => {
    if (!ready || !loaded || window.isDestroyed()) return;
    window.show(); window.focus(); presented = true;
    if (parent && !parent.isDestroyed()) parent.hide();
    resolveReady();
  };
  const restore = () => {
    if (!presented || !parent || parent.isDestroyed()) return;
    parent.show(); parent.focus();
  };
  window.once('ready-to-show', () => { ready = true; present(); });
  window.once('closed', () => {
    restore();
    if (!presented) rejectReady(Error('The workspace was closed before it finished opening.'));
  });
  // An application shutdown must not leave an unattached setup process visible.
  const closeWithParent = () => { if (!window.isDestroyed()) window.destroy(); };
  const rendererStopped = () => { if (!window.isDestroyed()) window.destroy(); };
  parent?.once('closed', closeWithParent);
  window.webContents.once('render-process-gone',rendererStopped);
  window.once('closed', () => {
    parent?.removeListener('closed', closeWithParent);
    window.webContents.removeListener('render-process-gone',rendererStopped);
  });
  try {
    await Promise.all([shown,window.loadURL(url).then(() => {
      if (window.isDestroyed()) throw Error('The workspace was closed before it finished opening.');
      loaded = true; present();
    })]);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}
