import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { quotaSchema } from '@collabboard/contracts';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('API');
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const parserStatus =
      typeof exception === 'object' &&
      exception !== null &&
      'status' in exception
        ? exception.status
        : undefined;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserStatus === 400 || parserStatus === 413
          ? parserStatus
          : 500;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const detail =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const requestId =
      response.getHeader('X-Request-Id')?.toString() ?? randomUUID();
    const defaults: Record<number, string> = {
      400: 'VALIDATION_ERROR',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      429: 'RATE_LIMITED',
      503: 'SERVICE_UNAVAILABLE',
    };
    if (status >= 500)
      this.logger.error(
        JSON.stringify({
          requestId,
          status,
          code: defaults[status] ?? 'INTERNAL_ERROR',
        }),
      );
    const retryAfterSeconds =
      typeof detail.retryAfterSeconds === 'number' &&
      Number.isInteger(detail.retryAfterSeconds) &&
      detail.retryAfterSeconds > 0
        ? detail.retryAfterSeconds
        : undefined;
    if (retryAfterSeconds) response.setHeader('Retry-After', retryAfterSeconds);
    response.status(status).json({
      code: detail.code ?? defaults[status] ?? 'INTERNAL_ERROR',
      message:
        status === 500
          ? 'Something went wrong. Please try again.'
          : (detail.message ??
            (status === 413
              ? 'The request body is too large.'
              : status === 400
                ? 'The request body is invalid.'
                : 'The request could not be completed.')),
      requestId,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      ...(detail.fieldErrors ? { fieldErrors: detail.fieldErrors } : {}),
      ...(quotaSchema.safeParse(detail.quota).success
        ? { quota: quotaSchema.parse(detail.quota) }
        : {}),
    });
  }
}
