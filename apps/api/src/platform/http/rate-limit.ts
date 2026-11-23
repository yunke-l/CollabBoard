import { HttpException } from '@nestjs/common';
import type { Database } from '../database/database.js';

export async function consumeRate(
  database: Database,
  subject: string,
  buckets: { name: string; limit: number; minutes?: number }[],
) {
  return database.transaction(async (client) => {
    for (const bucket of buckets) {
      const seconds = (bucket.minutes ?? 1) * 60;
      const { rows } = await client.query(
        `INSERT INTO rate_limits(subject, bucket, window_start, used) VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1) ON CONFLICT(subject, bucket, window_start) DO UPDATE SET used = rate_limits.used + 1 WHERE rate_limits.used < $4 RETURNING used`,
        [subject, bucket.name, seconds, bucket.limit],
      );
      if (!rows.length)
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message:
              'Too many requests. Wait before trying again; your draft is kept.',
            retryAfterSeconds: seconds,
          },
          429,
        );
    }
  });
}
