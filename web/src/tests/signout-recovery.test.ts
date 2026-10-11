import { expect, it, vi } from 'vitest';
import { confirmLocalWorkSignOut } from '../auth/signout-recovery';

it('explains account-bound browser recovery and lets cancellation retain sign-in', async () => {
  const confirm = vi.fn(() => false);
  expect(await confirmLocalWorkSignOut({ read: async () => [{}, { finalized: true }], current: () => true, confirm })).toBe(false);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1 unfinished recording'));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('this same account in this browser'));
});
it('does not prompt for completed work and does not touch any stored recording', async () => {
  const rows = [{ finalized: true }, { submitted: true }, { discardRequested: true }];
  const before = JSON.stringify(rows), confirm = vi.fn(() => true);
  expect(await confirmLocalWorkSignOut({ read: async () => rows, current: () => true, confirm })).toBe(true);
  expect(confirm).not.toHaveBeenCalled(); expect(JSON.stringify(rows)).toBe(before);
});
it('rejects an account change before or during confirmation', async () => {
  const confirm = vi.fn(() => true);
  expect(await confirmLocalWorkSignOut({ read: async () => [{}], current: () => false, confirm })).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  let current = true;
  expect(await confirmLocalWorkSignOut({ read: async () => [{}], current: () => current, confirm: () => { current = false; return true; } })).toBe(false);
});
it('keeps sign-out available after a failed storage check with an honest warning', async () => {
  const confirm = vi.fn(() => true);
  expect(await confirmLocalWorkSignOut({ read: async () => { throw new Error('Storage unavailable'); }, current: () => true, confirm })).toBe(true);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('could not be checked'));
});
