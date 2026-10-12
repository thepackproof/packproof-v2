import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DesktopConfig} from '../src/main/config';

const fixture = vi.hoisted(() => ({
  app: {isPackaged: true},
  updater: {
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), setFeedURL: vi.fn(),
  },
}));
vi.mock('electron', () => ({app: fixture.app}));
vi.mock('electron-updater', () => ({autoUpdater: fixture.updater}));

import {Updates} from '../src/main/updates';

const production: DesktopConfig = {
  channel: 'production', apiBaseUrl: 'https://api.example.test', webBaseUrl: 'https://example.test',
  cognito: {region: 'us-east-1', clientId: 'fixture', userPoolId: 'fixture'},
  updateUrl: 'https://downloads.thepackproof.com/desktop/production/darwin/arm64/',
};
function make(config: DesktopConfig | null = production) {
  const changed = vi.fn(), busy = vi.fn(() => false), prepare = vi.fn(async () => {}), report = vi.fn();
  const updates = new Updates(config, changed, busy, prepare, report);
  const emit = (event: string, value?: unknown) => {
    const handler = fixture.updater.on.mock.calls.find(([name]) => name === event)?.[1];
    if (!handler) throw new Error('Missing updater event handler: ' + event);
    handler(value);
  };
  return {updates, changed, busy, prepare, report, emit};
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.app.isPackaged = true;
  Object.assign(fixture.updater, {autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true});
});

describe('desktop updater safety admission (mocked native updater, no signed update claim)', () => {
  it('disables automatic download, quit installation, downgrades and prereleases without replacing the packaged feed', () => {
    make();
    expect(fixture.updater).toMatchObject({autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false});
    expect(fixture.updater.setFeedURL).not.toHaveBeenCalled();
    expect(fixture.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(fixture.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it.each(['unpackaged', 'development', 'unconfigured', 'missing-feed'])('refuses update work for %s applications', async mode => {
    if (mode === 'unpackaged') fixture.app.isPackaged = false;
    const config = mode === 'unconfigured' ? null : {...production, ...(mode === 'development' ? {channel: 'development' as const} : {}), ...(mode === 'missing-feed' ? {updateUrl: undefined} : {})};
    const {updates, prepare} = make(config);
    expect(updates.state.state).toBe('unavailable');
    expect(fixture.updater.on).not.toHaveBeenCalled();
    await expect(updates.check()).rejects.toThrow('configured signed releases');
    await expect(updates.download()).rejects.toThrow('Check for an update first');
    await expect(updates.install()).rejects.toThrow('No verified update is ready');
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('keeps installation unavailable through checking, available and downloading states', async () => {
    const {updates, emit, changed, prepare} = make();
    await updates.check();
    expect(fixture.updater.checkForUpdates).toHaveBeenCalledOnce();
    for (const [event, state] of [['checking-for-update', 'checking'], ['update-available', 'available'], ['download-progress', 'downloading'], ['update-not-available', 'current']]) {
      emit(event, {version: '1.0.2'});
      expect(updates.state.state).toBe(state);
      await expect(updates.install()).rejects.toThrow('No verified update is ready');
    }
    expect(changed).toHaveBeenCalledTimes(4);
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('permits download only after availability or a retryable error', async () => {
    const {updates, emit, report} = make();
    await expect(updates.download()).rejects.toThrow('Check for an update first');
    emit('update-available', {version: '1.0.2'});
    await updates.download();
    emit('error', new Error('PRIVATE raw transport URL or token'));
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.stringify(updates.state)).not.toContain('PRIVATE');
    await updates.download();
    expect(fixture.updater.downloadUpdate).toHaveBeenCalledTimes(2);
    emit('update-downloaded', {version: '1.0.2'});
    await expect(updates.download()).rejects.toThrow('Check for an update first');
  });

  it('blocks a downloaded update while capture is active without starting shutdown', async () => {
    const {updates, emit, busy, prepare} = make();
    emit('update-downloaded', {version: '1.0.2'});
    busy.mockReturnValue(true);
    await expect(updates.install()).rejects.toThrow('Finish recording before installing');
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.state).toEqual({state: 'ready', version: '1.0.2'});
  });

  it('waits for evidence/reporting preparation to finish before invoking native installation', async () => {
    const {updates, emit, prepare} = make();
    let release!: () => void;
    prepare.mockImplementation(() => new Promise<void>(resolve => {release = resolve;}));
    emit('update-downloaded', {version: '1.0.2'});
    const pending = updates.install();
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
    release(); await pending;
    expect(fixture.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it('does not install after preservation preparation rejects', async () => {
    const {updates, emit, prepare} = make();
    const failure = new Error('Evidence drain did not finish');
    prepare.mockRejectedValue(failure);
    emit('update-downloaded', {version: '1.0.2'});
    await expect(updates.install()).rejects.toBe(failure);
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
