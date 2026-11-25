import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAccounts } from '../../apps/api/src/adapters/identity/local-accounts';
import {
  signUpSchema,
  verifyEmailSchema,
  resetPasswordSchema,
} from '@collabboard/contracts';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomInt: vi.fn(crypto.randomInt) };
});

let identity: LocalAccounts | undefined;
afterEach(() => {
  identity?.onModuleDestroy();
  identity = undefined;
  vi.mocked(randomInt).mockReset();
  vi.useRealTimers();
});
const password = 'A local test password 123!';
describe('local development identity lifecycle', () => {
  it('validates credentials and Unicode names independently of form controls', () => {
    expect(
      signUpSchema.safeParse({
        email: 'not-email',
        displayName: 'Taylor',
        password,
      }).success,
    ).toBe(false);
    expect(
      signUpSchema.safeParse({
        email: 'taylor@example.test',
        displayName: 'Taylor',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      signUpSchema.safeParse({
        email: 'taylor@example.test',
        displayName: '\ud83c\udf1f'.repeat(40),
        password,
      }).success,
    ).toBe(true);
    expect(
      verifyEmailSchema.safeParse({
        email: 'taylor@example.test',
        code: '12345x',
      }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({
        email: 'taylor@example.test',
        code: '123456',
        password,
      }).success,
    ).toBe(true);
  });
  it('requires single-use verification, rejects bad credentials, and restores a revocable session', () => {
    identity = new LocalAccounts(':memory:');
    const registration = identity.signUp(
      'taylor@example.test',
      'Taylor',
      password,
    );
    expect(() => identity!.signIn(registration.email, password)).toThrow(
      'Verify your email',
    );
    expect(() => identity!.verify(registration.email, 'invalid')).toThrow();
    identity.verify(registration.email, registration.developmentCode);
    expect(() =>
      identity!.verify(registration.email, registration.developmentCode),
    ).toThrow();
    expect(() =>
      identity!.signIn(registration.email, 'wrong password'),
    ).toThrow('email or password');
    const user = identity.signIn(registration.email, password);
    expect(user.emailVerified).toBe(true);
    const token = identity.createRefresh(user);
    expect(identity.refresh(token)).toEqual(user);
    expect(identity.live(identity.refreshHash(token))).toBe(true);
    identity.revoke(token);
    expect(() => identity!.refresh(token)).toThrow('session expired');
  });
  it('replaces recovery codes, changes the password, and revokes all previous refresh sessions', () => {
    identity = new LocalAccounts(':memory:');
    const created = identity.signUp('taylor@example.test', 'Taylor', password);
    identity.verify(created.email, created.developmentCode);
    const user = identity.signIn(created.email, password);
    const first = identity.createRefresh(user);
    const second = identity.createRefresh(user);
    // Distinct codes keep the replacement assertion independent of random collisions.
    vi.mocked(randomInt)
      .mockImplementationOnce(() => 123456)
      .mockImplementationOnce(() => 654321);
    const previous = identity.recover(created.email);
    const recovery = identity.recover(created.email);
    expect(() =>
      identity!.reset(created.email, previous.developmentCode, password),
    ).toThrow('invalid or expired');
    identity.reset(
      created.email,
      recovery.developmentCode,
      'My replacement password 456!',
    );
    expect(() => identity!.signIn(created.email, password)).toThrow();
    expect(
      identity.signIn(created.email, 'My replacement password 456!').id,
    ).toBe(user.id);
    expect(() => identity!.refresh(first)).toThrow();
    expect(() => identity!.refresh(second)).toThrow();
    expect(() =>
      identity!.reset(created.email, recovery.developmentCode, password),
    ).toThrow();
  });
  it('accepts a recovery code just before its ten-minute expiry and rejects one at expiry', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    identity = new LocalAccounts(':memory:');
    const { email } = identity.signUp(
      'taylor@example.test',
      'Taylor',
      password,
    );
    const first = identity.recover(email);
    vi.setSystemTime(start + 600_000 - 1);
    expect(identity.reset(email, first.developmentCode, password)).toEqual({
      reset: true,
    });

    const issuedAt = Date.now();
    const second = identity.recover(email);
    vi.setSystemTime(issuedAt + 600_000);
    expect(() =>
      identity!.reset(email, second.developmentCode, password),
    ).toThrow('invalid or expired');
  });
  it('limits failed identity attempts and does not expose whether recovery found an account', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    identity = new LocalAccounts(':memory:');
    for (let index = 0; index < 10; index++)
      expect(() =>
        identity!.signIn('missing@example.test', password),
      ).toThrow();
    expect(() => identity!.signIn('missing@example.test', password)).toThrow(
      'Too many identity attempts',
    );
    vi.setSystemTime(start + 60_000);
    expect(() => identity!.signIn('missing@example.test', password)).toThrow(
      'email or password',
    );
    expect(identity.recover('missing@example.test')).toMatchObject({
      sent: true,
      developmentCode: expect.stringMatching(/^[0-9]{6}$/),
    });
  });
});
