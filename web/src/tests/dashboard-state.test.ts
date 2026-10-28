import { describe, expect, it } from 'vitest';
import { dashboardHref, readDashboardFilters } from '../screens/dashboard-state';

describe('dashboard navigation filters', () => {
  it.each([
    ['all', undefined], ['attention', 'NEEDS_ATTENTION'], ['progress', 'IN_PROGRESS'], ['completed', 'READY'],
  ])('honors the existing %s links from Home', (view, state) => {
    expect(readDashboardFilters(`?filter=${view}&q=order`)).toMatchObject({ q: 'order', state, limit: 50 });
  });

  it('round-trips all supported filters through a history entry without its cursor', () => {
    const filters = {
      q: 'Order & 125 / carton', state: 'AWAITING_CAPTURE' as const, from: '2026-10-01', through: '2026-10-28',
      connectionId: 'connection_store', integrationAccountId: 'account_merchant', limit: 10, after: 'secret-signed-cursor',
    };
    const href = dashboardHref(filters);
    expect(href).toContain('filter=all&state=AWAITING_CAPTURE');
    expect(href).not.toContain('secret-signed-cursor');
    expect(readDashboardFilters(new URL(href, 'https://packproof.test').search)).toEqual({ ...filters, limit: 50, after: undefined });
  });

  it('uses only the current history entry when moving from a filtered search to All', () => {
    const first = readDashboardFilters('?filter=completed&q=old&connectionId=store');
    const second = readDashboardFilters('?filter=all');
    expect(first.state).toBe('READY');
    expect(second).toMatchObject({ q: undefined, state: undefined, connectionId: undefined });
    expect(dashboardHref(second)).toBe('/proofs?filter=all');
  });

  it('uses the legacy route props only when URL values are absent', () => {
    expect(readDashboardFilters('', { view: 'attention', query: 'legacy' })).toMatchObject({ state: 'NEEDS_ATTENTION', q: 'legacy' });
    expect(readDashboardFilters('?filter=all&q=', { view: 'attention', query: 'legacy' })).toMatchObject({ state: undefined, q: undefined });
  });

  it('validates calendar dates rather than accepting rolled-over days', () => {
    expect(readDashboardFilters('?from=2026-02-30&through=2026-11-01')).toMatchObject({ from: undefined, through: '2026-11-01' });
    expect(readDashboardFilters('?from=2024-02-29&through=2024-02-29')).toMatchObject({ from: '2024-02-29', through: '2024-02-29' });
    expect(readDashboardFilters('?from=2026-10-28&through=2026-10-01')).toMatchObject({ from: undefined, through: undefined });
    expect(dashboardHref({ from: '2026-10-28', through: '2026-10-01' })).not.toMatch(/from=|through=/);
  });

  it('ignores arbitrary URL parameters, expired cursors and unsupported states', () => {
    const result = readDashboardFilters('?filter=unsupported&state=FINALIZED&after=expired&limit=1000&apiKey=secret&redirect=https://other.test');
    expect(result).toMatchObject({ state: undefined, limit: 50 });
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['after', 'apiKey', 'redirect']));
    expect(dashboardHref(result)).toBe('/proofs?filter=all');
  });

  it('bounds search text and rejects control characters before sending a request', () => {
    expect(readDashboardFilters(`?q=${'a'.repeat(300)}`).q).toHaveLength(200);
    expect(readDashboardFilters('?q=invalid%00query&connectionId=bad%0Avalue')).toMatchObject({ q: undefined, connectionId: undefined });
    expect(dashboardHref({ q: '  ORDER-42  ' })).toBe('/proofs?filter=all&q=ORDER-42');
  });
});
