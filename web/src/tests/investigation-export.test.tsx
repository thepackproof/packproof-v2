import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PackProofApi } from '../api/client';
import { InvestigationExport } from '../records/InvestigationExport';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('keeps v1 compatible without probing an unenabled signed capability', () => {
  const request = vi.fn();
  render(<InvestigationExport api={{ recordsRequest: request } as unknown as PackProofApi} caseId="case-a" organizationId="org-a" environment="live" projectionVersion="rev-1" signedEnabled={false}/>);
  expect(screen.getByRole('button', { name: 'Download investigation package' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Download signed investigation package' })).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
it('labels synthetic signing and clears it immediately when the authorized workspace changes', async () => {
  const request = vi.fn(async (path: string) => path.includes('org-b') ? new Promise(() => undefined) : { unsigned: { available: true, profile: 'v1' }, signed: { available: true, profile: 'packproof.reconstruction-investigation/v2', qualification: 'synthetic_test_only' } });
  const api = { recordsRequest: request } as unknown as PackProofApi;
  const { rerender } = render(<InvestigationExport api={api} caseId="case-a" organizationId="org-a" environment="sandbox" projectionVersion="rev-1" signedEnabled/>);
  expect(await screen.findByRole('button', { name: 'Download synthetic signed test package' })).toBeVisible();
  expect(screen.getByText(/unqualified for production or customer reliance/)).toBeVisible();
  rerender(<InvestigationExport api={api} caseId="case-a" organizationId="org-b" environment="sandbox" projectionVersion="rev-1" signedEnabled/>);
  expect(screen.queryByRole('button', { name: 'Download synthetic signed test package' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download signed investigation package' })).not.toBeInTheDocument();
});
