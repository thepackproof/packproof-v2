import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function viewport(initialCompact: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initialCompact, media: '(max-width: 760px)', onchange: null,
    addEventListener: vi.fn((_name: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: () => void) => listeners.delete(listener)),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => media as unknown as MediaQueryList);
  return {
    media,
    resize(compact: boolean) { act(() => { media.matches = compact; for (const listener of listeners) listener(); }); },
    listeners,
  };
}

async function loadHook(flags: { dashboard?: string; signal?: string; mobileTask?: string } = {}) {
  vi.stubEnv('VITE_PACKPROOF_CLIENT_DASHBOARD', flags.dashboard);
  vi.stubEnv('VITE_PACKPROOF_SIGNAL', flags.signal);
  vi.stubEnv('VITE_PACKPROOF_MOBILE_TASK_UX', flags.mobileTask);
  // Signal is selected once when the actual module loads, as in a real build.
  // Reload the real hook/module graph instead of mocking the desktop result.
  vi.resetModules();
  return (await import('../mobile-task/useMobileTaskExperience')).useMobileTaskExperience;
}

it.each([false, true])('preserves the default Signal composition on compact=%s without dashboard opt-in', async compact => {
  viewport(compact);
  const useShell = await loadHook();
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(true);
});

it('makes the dashboard flag alone select the workstation on a wide display', async () => {
  viewport(false);
  const useShell = await loadHook({ dashboard: 'true' });
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(false);
});

it('keeps opted-in phones on the existing Signal task composition', async () => {
  viewport(true);
  const useShell = await loadHook({ dashboard: 'true' });
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(true);
});

it('retains the legacy mobile rollback behavior when Signal remains enabled', async () => {
  const screen = viewport(false);
  const useShell = await loadHook({ dashboard: 'true', mobileTask: 'false' });
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(false);
  screen.resize(true);
  // MOBILE_TASK_UX=false has never disabled Signal on a phone.
  expect(result.current).toBe(true);
});

it.each([
  [undefined, true], ['false', false],
])('keeps the Signal-disabled narrow-screen rollback profile (mobileTask=%s)', async (mobileTask, expected) => {
  viewport(true);
  const useShell = await loadHook({ dashboard: 'true', signal: 'false', mobileTask });
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(expected);
});

it('does not enable the workstation when the dashboard flag is false', async () => {
  viewport(false);
  const useShell = await loadHook({ dashboard: 'false' });
  const { result } = renderHook(() => useShell());
  expect(result.current).toBe(true);
});

it('responds to actual viewport changes and removes its subscription on unmount', async () => {
  const screen = viewport(false);
  const useShell = await loadHook({ dashboard: 'true' });
  const { result, unmount } = renderHook(() => useShell());
  expect(result.current).toBe(false);
  expect(screen.media.media).toBe('(max-width: 760px)');
  expect(screen.listeners.size).toBe(1);
  screen.resize(true);
  expect(result.current).toBe(true);
  screen.resize(false);
  expect(result.current).toBe(false);
  unmount();
  expect(screen.listeners.size).toBe(0);
  expect(screen.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});
