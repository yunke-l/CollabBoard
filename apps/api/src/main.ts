import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { readEnvironment } from './config/environment.js';
import { ApiErrorFilter } from './platform/observability/error-filter.js';

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
  allowedHeaders: ['Authorization', 'Content-Type'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});
app.setGlobalPrefix('api');
app.useGlobalFilters(new ApiErrorFilter());
app.enableShutdownHooks();
const config = new DocumentBuilder()
  .setTitle('CollabBoard API')
  .setDescription(
    'Local foundation endpoints. Additional collaboration features are planned.',
  )
  .setVersion('0.1.0')
  .addBearerAuth()
  .build();
SwaggerModule.setup(
  'api/reference',
  app,
  SwaggerModule.createDocument(app, config),
  { jsonDocumentUrl: 'api/openapi.json' },
);
await app.listen(environment.port, environment.host);
