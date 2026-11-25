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
