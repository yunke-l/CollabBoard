export function readEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  const identityProvider = env.IDENTITY_PROVIDER ?? 'local';
  if (!['development', 'test'].includes(mode) || identityProvider !== 'local') {
    throw new Error(
      'This foundation supports local development only. Configure a production identity adapter before deployment.',
    );
  }
  const port = Number(env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('API_PORT must be a valid port.');
  const host = env.API_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Local identity mode requires a loopback API_HOST.');
  const origin = new URL(env.WEB_ORIGIN ?? 'http://localhost:5173');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('Local identity mode requires a loopback WEB_ORIGIN.');
  return {
    mode,
    port,
    host,
    origin: origin.origin,
    databaseUrl:
      env.DATABASE_URL ??
      'postgresql://collabboard:collabboard_local@localhost:5432/collabboard',
  };
}
