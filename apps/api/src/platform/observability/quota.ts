import { HttpException } from '@nestjs/common';
import type { Quota } from '@collabboard/contracts';

export function quotaConflict(
  code:
    | 'PROJECT_LIMIT_REACHED'
    | 'TASK_LIMIT_REACHED'
    | 'MEMBER_LIMIT_REACHED'
    | 'ATTACHMENT_LIMIT_REACHED'
    | 'STORAGE_LIMIT_REACHED',
  resource: Quota['resource'],
  used: number,
  limit: number,
  message: string,
) {
  return new HttpException(
    { code, message, quota: { resource, used, limit } },
    409,
  );
}
