import { describe, expect, it } from 'vitest';
import { readEnvironment } from './environment';

describe('development identity boundary', () => {
  it('rejects production, unknown identity providers, and public interfaces', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { IDENTITY_PROVIDER: 'cognito' },
      { API_HOST: '0.0.0.0' },
      { WEB_ORIGIN: 'https://example.com' },
    ])
      expect(() => readEnvironment(env)).toThrow();
  });
  it('allows a loopback development environment', () => {
    expect(readEnvironment({ NODE_ENV: 'development' })).toMatchObject({
      host: '127.0.0.1',
      port: 3001,
      origin: 'http://localhost:5173',
    });
  });
});

describe('private EC2 demo', () => {
  const hosted = {
    NODE_ENV: 'production',
    IDENTITY_PROVIDER: 'private-demo',
    WEB_ORIGIN: 'https://board.example.com',
    DEMO_IPV4: '192.0.2.7',
    DATABASE_URL: 'postgresql://example@postgres/demo',
    LOCAL_STATE_DIR: '/data',
  };
  it('uses a loopback API behind the HTTPS gateway', () => {
    expect(readEnvironment(hosted)).toMatchObject({
      hostedDemo: true,
      host: '127.0.0.1',
      origin: hosted.WEB_ORIGIN,
    });
  });
  it.each([
    { IDENTITY_PROVIDER: 'local' },
    { API_HOST: '0.0.0.0' },
    { WEB_ORIGIN: 'http://board.example.com' },
    { WEB_ORIGIN: 'https://board.example.com/path' },
    { DEMO_IPV4: '' },
    { DEMO_IPV4: '0.0.0.0/0' },
    { LOCAL_STATE_DIR: '.local' },
    { DATABASE_URL: '' },
  ])('rejects an incomplete or exposed configuration %o', (override) => {
    expect(() => readEnvironment({ ...hosted, ...override })).toThrow();
  });
});
