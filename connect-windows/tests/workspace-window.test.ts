import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { loadWorkspaceWindow } from '../main/workspace-window';

class Window extends EventEmitter {
  destroyed=false;
  webContents=new EventEmitter();
  show=vi.fn(); hide=vi.fn(); focus=vi.fn();
  isDestroyed=()=>this.destroyed;
  loadURL=vi.fn(async(_url:string)=>{});
  destroy=()=>{this.destroyed=true;this.emit('closed');};
  asWindow(){return this as unknown as BrowserWindow;}
}
describe('one visible workspace without replacing protected Commerce webContents',()=>{
  it('keeps the host visible until the local renderer is loaded and ready, then restores it on close',async()=>{
    const child=new Window(),parent=new Window();
    let finish!:()=>void;
    child.loadURL.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const opening=loadWorkspaceWindow(child.asWindow(),parent.asWindow(),'packproof-connect://app/index.html');
    child.emit('ready-to-show');
    expect(parent.hide).not.toHaveBeenCalled();expect(child.show).not.toHaveBeenCalled();
    finish();await opening;
    expect(child.show).toHaveBeenCalledTimes(1);expect(parent.hide).toHaveBeenCalledTimes(1);
    child.destroy();
    expect(parent.show).toHaveBeenCalledTimes(1);expect(parent.focus).toHaveBeenCalledTimes(1);
    expect(parent.destroyed).toBe(false);
  });
  it('does not hide the host when navigation fails and never leaves a detached child after host shutdown',async()=>{
    const child=new Window(),parent=new Window();
    child.loadURL.mockRejectedValue(Error('Renderer unavailable'));
    await expect(loadWorkspaceWindow(child.asWindow(),parent.asWindow(),'packproof-connect://app/index.html')).rejects.toThrow('Renderer unavailable');
    expect(parent.hide).not.toHaveBeenCalled();expect(child.destroyed).toBe(true);
    const next=new Window();
    const opening=loadWorkspaceWindow(next.asWindow(),parent.asWindow(),'packproof-connect://app/index.html');
    next.emit('ready-to-show');await opening;parent.destroy();
    expect(next.destroyed).toBe(true);
    expect(parent.show).not.toHaveBeenCalled();
  });
  it('restores the host after a child renderer crash, and does not report opening success before ready',async()=>{
    const child=new Window(),parent=new Window();
    let complete=false;
    const opening=loadWorkspaceWindow(child.asWindow(),parent.asWindow(),'packproof-connect://app/index.html').then(()=>{complete=true;});
    await Promise.resolve();await Promise.resolve();
    expect(complete).toBe(false);expect(parent.hide).not.toHaveBeenCalled();
    child.emit('ready-to-show');await opening;
    child.webContents.emit('render-process-gone');
    expect(child.destroyed).toBe(true);expect(parent.show).toHaveBeenCalledTimes(1);
    expect(parent.destroyed).toBe(false);
  });
});
