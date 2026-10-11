import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyStripeSignature } from '../src/billing/stripe-adapter.js';
import { queueShippoNotification } from '../src/domain/shipment-notifications.js';
import type { Database } from '../src/db/database.js';

const clock = { now: () => new Date('2026-10-11T12:00:00Z') };
const timestamp = Math.floor(clock.now().getTime() / 1000);
const secret = ['whsec', 'syntheticBoundaryFixture00000000'].join('_');
const signature = (raw: Buffer) => `t=${timestamp},v1=${createHmac('sha256', secret)
  .update(`${timestamp}.`).update(raw).digest('hex')}`;
const notification = JSON.stringify({
  event: 'track_updated', test: false,
  data: { tracking_number: '1Z999AA10123456784', carrier: 'ups' },
});

describe('webhook byte and scalar boundaries', () => {
  it.each([
    ['string', notification], ['single-element array', [notification]],
    ['byte array', Array.from(Buffer.from(notification))],
    ['JSON Buffer shape', Buffer.from(notification).toJSON()],
    ['Uint8Array', new Uint8Array(Buffer.from(notification))],
    ['null', null], ['number', 7],
  ])('rejects a Shippo %s body before database work', async (_name, value) => {
    const query = vi.fn();
    await expect(queueShippoNotification({ query } as unknown as Database, clock, value as Buffer))
      .rejects.toMatchObject({ code: 'WEBHOOK_INVALID', httpStatus: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not coerce a Shippo object into an actionable notification', async () => {
    const toString = vi.fn(() => notification), query = vi.fn();
    const hostile = { length: 1, toString };
    await expect(queueShippoNotification({ query } as unknown as Database, clock, hostile as unknown as Buffer))
      .rejects.toMatchObject({ code: 'WEBHOOK_INVALID', httpStatus: 400 });
    expect(toString).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a bounded Shippo Buffer and preserves the normalized tracking lookup', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    await queueShippoNotification({ query } as unknown as Database, clock, Buffer.from(notification));
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(['1Z999AA10123456784']);
  });

  it('rejects over-budget Shippo bytes before database work', async () => {
    const query = vi.fn();
    await expect(queueShippoNotification({ query } as unknown as Database, clock, Buffer.alloc(256 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'WEBHOOK_TOO_LARGE', httpStatus: 413 });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['string', '{}'], ['array', ['{}']], ['JSON Buffer shape', { type: 'Buffer', data: [123, 125] }],
    ['Uint8Array', new Uint8Array([123, 125])], ['null', null], ['empty Buffer', Buffer.alloc(0)],
  ])('rejects a Stripe %s body before HMAC processing', (_name, value) => {
    expect(() => verifyStripeSignature(value as Buffer, signature(Buffer.from('{}')), secret, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_INVALID_BODY', httpStatus: 413 }));
  });

  it.each([
    ['array', [signature(Buffer.from('{}'))]], ['number', 123], ['object', { length: 1 }],
    ['boxed string', new String(signature(Buffer.from('{}')))], ['null', null],
  ])('rejects a Stripe %s signature header as an authentication error', (_name, value) => {
    expect(() => verifyStripeSignature(Buffer.from('{}'), value as string, secret, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_SIGNATURE_INVALID', httpStatus: 401 }));
  });

  it('does not call attacker-controlled header parsing or secret coercion', () => {
    const split = vi.fn(), toString = vi.fn(() => secret), raw = Buffer.from('{}');
    expect(() => verifyStripeSignature(raw, { length: 1, split } as unknown as string, secret, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_SIGNATURE_INVALID' }));
    expect(split).not.toHaveBeenCalled();
    expect(() => verifyStripeSignature(raw, signature(raw), { toString } as unknown as string, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_MANAGED_SECRET_REQUIRED', httpStatus: 503 }));
    expect(toString).not.toHaveBeenCalled();
  });

  it('verifies original bytes without text conversion and rejects mutation or over-budget bytes', () => {
    const raw = Buffer.from([0x00, 0xff, 0xc0, 0x80, 0x7b, 0x7d]);
    expect(() => verifyStripeSignature(raw, signature(raw), secret, clock)).not.toThrow();
    expect(() => verifyStripeSignature(Buffer.concat([raw, Buffer.from(' ')]), signature(raw), secret, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_SIGNATURE_INVALID' }));
    expect(() => verifyStripeSignature(Buffer.alloc(1024 * 1024 + 1), signature(raw), secret, clock))
      .toThrowError(expect.objectContaining({ code: 'STRIPE_INVALID_BODY', httpStatus: 413 }));
  });
});
