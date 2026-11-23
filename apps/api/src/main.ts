import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DocumentBuilder,
  SwaggerModule,
  type SchemaObject,
} from '@nestjs/swagger';
import { z } from 'zod';
import { apiErrorSchema } from '@collabboard/contracts';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { readEnvironment } from './config/environment.js';
import { ApiErrorFilter } from './platform/observability/error-filter.js';
import { Database } from './platform/database/database.js';
import { LocalIdentityProvider } from './modules/identity/identity.service.js';
import { consumeRate } from './platform/http/rate-limit.js';

const environment = readEnvironment();
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
});
app.useBodyParser('json', { limit: '64kb' });
app.use(helmet());
app.use((_request: Request, response: Response, next: NextFunction) => {
  response.setHeader('X-Request-Id', randomUUID());
  response.setHeader('Cache-Control', 'no-store');
  next();
});
app.enableCors({
  origin: environment.origin,
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Upload-Token'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.setGlobalPrefix('api');
app.useGlobalFilters(new ApiErrorFilter());
app.enableShutdownHooks();
app.use(async (request: Request, response: Response, next: NextFunction) => {
  if (
    (environment.mode === 'test' &&
      process.env.RATE_LIMITS_ENABLED === 'false') ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
    request.path.startsWith('/api/auth/')
  ) {
    next();
    return;
  }
  let user;
  try {
    user = app.get(LocalIdentityProvider).authenticate(request);
  } catch {
    next();
    return;
  }
  const buckets = [{ name: 'writes', limit: 60 }];
  if (
    /\/projects\/[^/]+\/invitations$/.test(request.path) &&
    request.method === 'POST'
  )
    buckets.push({ name: 'invitations', limit: 10 });
  if (
    /\/tasks\/[^/]+\/attachments$/.test(request.path) &&
    request.method === 'POST'
  )
    buckets.push({ name: 'uploads', limit: 20 });
  if (request.path.startsWith('/api/demo/projects'))
    buckets.push({ name: 'trials', limit: 6 });
  try {
    await consumeRate(app.get(Database), user.id, buckets);
    next();
  } catch (error) {
    new ApiErrorFilter().catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
  }
});
const config = new DocumentBuilder()
  .setTitle('CollabBoard API')
  .setDescription(
    'Local accounts, projects, tasks, collaboration hints, comments, notifications, private attachments, and isolated trials. Local adapters are restricted to development and test.',
  )
  .setVersion('0.1.0')
  .addBearerAuth()
  .addGlobalResponse(
    ...[
      [400, 'Invalid request fields or list cursor.'],
      [401, 'A valid session is required.'],
      [403, 'The current membership does not permit this action.'],
      [404, 'The resource is missing or inaccessible.'],
      [
        409,
        'Version, state, idempotency, or quota conflict. Quota errors include current usage and limit.',
      ],
      [413, 'The request body exceeds the allowed size.'],
      [429, 'Too many requests.'],
      [500, 'An unexpected service error occurred.'],
      [503, 'The service is temporarily unavailable.'],
    ].map(([status, description]) => ({
      status: status as number,
      description: description as string,
      schema: z.toJSONSchema(apiErrorSchema, {
        target: 'openapi-3.0',
      }) as SchemaObject,
    })),
  )
  .build();
SwaggerModule.setup(
  'api/reference',
  app,
  SwaggerModule.createDocument(app, config),
  { jsonDocumentUrl: 'api/openapi.json' },
);
await app.listen(environment.port, environment.host);
