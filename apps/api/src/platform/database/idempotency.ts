import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type pg from 'pg';

// Call inside the business transaction, after any required authorization locks.
export async function idempotent<T>(
  client: pg.PoolClient,
  userId: string,
  operation: string,
  input: { requestId: string },
  execute: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `${userId}:${operation}:${input.requestId}`,
  ]);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await client.query<{ payload_hash: string; result: T }>(
    'SELECT payload_hash, result FROM idempotency_records WHERE user_id = $1 AND operation = $2 AND request_id = $3 AND expires_at > now()',
    [userId, operation, input.requestId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== hash)
      throw new HttpException(
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This request ID was already used for different content.',
        },
        409,
      );
    return existing.rows[0].result;
  }
  const result = await execute();
  await client.query(
    "INSERT INTO idempotency_records (user_id, operation, request_id, payload_hash, result) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, operation, request_id) DO UPDATE SET payload_hash = EXCLUDED.payload_hash, result = EXCLUDED.result, expires_at = now() + interval '24 hours'",
    [userId, operation, input.requestId, hash, JSON.stringify(result)],
  );
  return result;
}
