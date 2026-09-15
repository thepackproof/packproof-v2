import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrackingIntake } from '../components/TrackingIntake';
import { canonicalProof } from './fixtures';
import type { PackProofApi } from '../api/client';
import { readProofListState, canonicalWorkspacePath, rememberProofListState } from '../proof-list-state';
import { trackingConnectionLabel } from '../../../mobile/src/copy/tracking-connection';
afterEach(() => { cleanup(); sessionStorage.clear(); });
it('starts with actionable work and preserves an explicit or remembered All filter', () => {
  expect(readProofListState(new URL('https://example.com/proofs')).view).toBe('attention');
  expect(readProofListState(new URL('https://example.com/proofs?filter=all')).view).toBe('all');
  rememberProofListState('seller', { view: 'all', query: '' });
  expect(canonicalWorkspacePath('/proofs', 'seller')).toBe('/proofs?filter=all');
});
it('keeps carrier connection states distinct from a sealed packing record', () => {
  const blank = { hasNumber: false, registered: false, hasEvents: false };
  expect(trackingConnectionLabel(blank)).toBe('Tracking not connected');
  expect(trackingConnectionLabel({ ...blank, hasNumber: true })).toContain('connection pending');
  expect(trackingConnectionLabel({ ...blank, hasNumber: true, registered: true })).toBe('Waiting for the first carrier update');
  expect(trackingConnectionLabel({ ...blank, hasEvents: true })).toBe('Carrier updates received');
  expect(trackingConnectionLabel({ ...blank, hasEvents: true, errorCode: 'RETRY' })).toBe('Tracking connection needs attention');
});
it('selects exactly one carrier and submits tracking separately against the existing Proof', async () => {
  const featureRequest = vi.fn().mockResolvedValue({});
  const onSaved = vi.fn();
  render(<TrackingIntake api={{ featureRequest } as unknown as PackProofApi} proof={canonicalProof} onSaved={onSaved} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Add tracking|Connect or retry tracking/ }));
  await user.click(screen.getByRole('radio', { name: 'UPS' }));
  expect(screen.getByRole('radio', { name: 'UPS' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'USPS' })).not.toBeChecked();
  await user.clear(screen.getByRole('textbox', { name: 'Tracking number or carrier link' }));
  await user.type(screen.getByRole('textbox', { name: 'Tracking number or carrier link' }), '1Z999AA10123456784');
  await user.click(screen.getByRole('button', { name: 'Save and connect tracking' }));
  expect(featureRequest).toHaveBeenCalledExactlyOnceWith(canonicalProof.proofId, 'tracking', 'POST', { value: '1Z999AA10123456784', carrier: 'ups' });
  expect(await screen.findByText('Tracking number saved.')).toBeVisible();
  expect(onSaved).toHaveBeenCalledOnce();
});
