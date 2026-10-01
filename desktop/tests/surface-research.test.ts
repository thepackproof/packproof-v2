import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { AuthService } from '../src/main/auth';
import { DesktopApi } from '../src/main/api';
import { schemas } from '../src/main/security';
import type { DesktopConfig } from '../src/main/config';
import { surfaceCanonicalJson } from '../../web/src/api/surface-types';

const config: DesktopConfig = {channel: 'research', apiBaseUrl: 'http://127.0.0.1:3000', webBaseUrl: 'http://127.0.0.1:5173', cognito: {region: 'us-east-1', clientId: '', userPoolId: ''}};
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
const profile = {userId: 'research-user', username: 'researcher', displayName: 'Researcher', status: 'ACTIVE', createdAt: '2026-10-01', updatedAt: '2026-10-01'};
const store = () => ({read: async () => null, write: vi.fn(async (_value: string) => {}), clear: vi.fn(async () => {})});

describe('isolated desktop surface research', () => {
  it('allows dev login only in the research channel and on loopback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({userId: profile.userId, token: 'local-token'})).mockResolvedValueOnce(json(profile));
    const auth = new AuthService({config, store: store(), fetch: fetcher});
    expect((await auth.researchSignIn('researcher')).userId).toBe(profile.userId); expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:3000/auth/dev/login');
    expect(await auth.getAccessToken()).toBe('local-token'); expect(JSON.stringify(auth.getSession())).not.toContain('local-token');
    for (const other of [{...config, channel: 'production' as const}, {...config, apiBaseUrl: 'https://thepackproof.com'}, {...config, cognito: {...config.cognito, clientId: 'live-client'}}]) {
      const unavailable = new AuthService({config: other, store: store(), fetch: fetcher}); await expect(unavailable.researchSignIn('researcher')).rejects.toMatchObject({code: 'RESEARCH_AUTH_DISABLED'});
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not accept a profile from a different research account', async () => {
    const auth = new AuthService({config, store: store(), fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(json({userId: 'another-user', token: 'local-token'})).mockResolvedValueOnce(json(profile))});
    await expect(auth.researchSignIn('researcher')).rejects.toMatchObject({code: 'PROFILE_UNAVAILABLE'}); expect(auth.getSession()).toBeNull();
  });
  it('binds comparison intent to a canonical reference-only command and stable retry key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({intentId: 'intent-a'})).mockResolvedValueOnce(json({id: 'analysis-a'}));
    const api = new DesktopApi({config, getAccountId: () => 'a', getToken: async () => 'token', fetch: fetcher});
    await api.compareSurfaceResearch('proof/a', {enrollmentId: 'enroll-a', observationId: 'observe-a', requestedScope: 'assembly', idempotencyKey: 'stable-key'});
    const command = {schemaVersion: 'surface-command/1', enrollmentId: 'enroll-a', observationId: 'observe-a', requestedScope: 'assembly'};
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:3000/proofs/proof%2Fa/surfaces/intents');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({operation: 'comparison', requestDigest: createHash('sha256').update(surfaceCanonicalJson(command)).digest('hex')});
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({...command, intentId: 'intent-a'}); expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({'Idempotency-Key': 'stable-key'});
  });
  it('rejects IPC score injection and arbitrary source paths', () => {
    const input = {enrollmentId: 'e', observationId: 'o', requestedScope: 'label', idempotencyKey: 'e6da15d0-bc76-43cb-aac2-d923af3235a8'};
    expect(schemas.surfaceCompare.safeParse(['proof-a', input]).success).toBe(true);
    expect(schemas.surfaceCompare.safeParse(['proof-a', {...input, score: 1}]).success).toBe(false);
    expect(schemas.surfaceSource.safeParse(['proof-a', '../other']).success).toBe(false);
  });
});
