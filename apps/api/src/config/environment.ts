import { isIPv4 } from 'node:net';
import { isAbsolute } from 'node:path';

export function readEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  const identityProvider = env.IDENTITY_PROVIDER ?? 'local';
  const hostedDemo =
    mode === 'production' && identityProvider === 'private-demo';
  if (
    !hostedDemo &&
    (!['development', 'test'].includes(mode) || identityProvider !== 'local')
  ) {
    throw new Error(
      'Use local identity for development or explicitly configure the private hosted demo.',
    );
  }
  const port = Number(env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('API_PORT must be a valid port.');
  const host = env.API_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Local identity mode requires a loopback API_HOST.');
  const origin = new URL(env.WEB_ORIGIN ?? 'http://localhost:5173');
  if (hostedDemo) {
    if (
      !env.WEB_ORIGIN ||
      origin.protocol !== 'https:' ||
      origin.origin !== env.WEB_ORIGIN
    )
      throw new Error(
        'The hosted demo requires an explicit HTTPS WEB_ORIGIN without a path.',
      );
    if (!isIPv4(env.DEMO_IPV4 ?? ''))
      throw new Error(
        'Set DEMO_IPV4 to the single IPv4 address allowed through the gateway.',
      );
    if (!env.DATABASE_URL || !isAbsolute(env.LOCAL_STATE_DIR ?? ''))
      throw new Error(
        'The hosted demo requires DATABASE_URL and an absolute LOCAL_STATE_DIR.',
      );
  } else if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('Local identity mode requires a loopback WEB_ORIGIN.');
  return {
    mode,
    hostedDemo,
    port,
    host,
    origin: origin.origin,
    databaseUrl:
      env.DATABASE_URL ??
      'postgresql://collabboard:collabboard_local@localhost:5432/collabboard',
  };
}
