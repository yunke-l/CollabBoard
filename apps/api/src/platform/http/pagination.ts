import { BadRequestException, applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { pagination, paginationQuerySchema } from '@collabboard/contracts';

// Cursors contain only a millisecond UTC timestamp, ID, and resource scope.
// They are navigation hints; every page still checks current authorization.
export function readPage(
  cursor: string | undefined,
  limit: number,
  scope: string,
) {
  const parsed = paginationQuerySchema.safeParse({ cursor, limit });
  if (!parsed.success)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Use a valid cursor and a page size between 1 and 100.',
    });
  if (!cursor) return { limit, boundary: null };
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(decoded.toString('utf8'));
    if (
      value.scope !== scope ||
      typeof value.at !== 'string' ||
      !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) ||
      !Number.isFinite(Date.parse(value.at)) ||
      new Date(value.at).toISOString() !== value.at ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        value.id,
      )
    )
      throw new Error();
    return { limit, boundary: value as { at: string; id: string } };
  } catch {
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'This cursor is invalid for this list. Reload the first page.',
      fieldErrors: { cursor: ['Reload the first page to continue.'] },
    });
  }
}

export function nextCursor(scope: string, at: string | Date, id: string) {
  return Buffer.from(
    JSON.stringify({ scope, at: new Date(at).toISOString(), id }),
  ).toString('base64url');
}

export const pageQuery = () =>
  applyDecorators(
    ApiQuery({
      name: 'cursor',
      required: false,
      type: String,
      description: 'Opaque cursor returned by this list.',
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      schema: {
        type: 'integer',
        minimum: 1,
        maximum: pagination.maxLimit,
        default: pagination.defaultLimit,
      },
    }),
  );
