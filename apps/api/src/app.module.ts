import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Module,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Database } from './platform/database/database.js';
import { LocalIdentityProvider } from './modules/identity/identity.service.js';
import { localIdentities } from './adapters/identity/local-identities.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { ProjectsController } from './modules/projects/projects.controller.js';
import { sampleBoard } from './modules/demo/sample.js';

@ApiTags('Foundation')
@Controller()
class FoundationController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
  ) {}

  @Get('health/live')
  @ApiOperation({
    summary: 'Process liveness; does not depend on the database',
  })
  live() {
    return { status: 'ok', service: 'collabboard-api', version: '0.1.0' };
  }

  @Get('health/ready')
  @ApiOperation({ summary: 'Database connectivity and schema readiness' })
  async ready() {
    try {
      await this.database.pool.query('SELECT 1 FROM users LIMIT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException(
        'Database is unavailable or migrations have not been applied.',
      );
    }
  }

  @Get('demo')
  @ApiOperation({ summary: 'Read the synthetic, read-only public sample' })
  demo() {
    return sampleBoard;
  }

  @Get('auth/local-identities')
  @ApiOperation({
    summary: 'List synthetic identities for local development only',
  })
  identities() {
    return localIdentities;
  }

  @Post('auth/local-session')
  @ApiOperation({
    summary:
      'Start a one-hour local development session; no password authentication',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userId'],
      properties: { userId: { type: 'string', format: 'uuid' } },
    },
  })
  session(@Body() body: { userId?: unknown } | null) {
    return this.identity.createSession(body?.userId);
  }

  @Get('me')
  @ApiBearerAuth()
  me(@Req() request: Request) {
    return this.identity.authenticate(request);
  }

  @Delete('auth/session')
  @ApiBearerAuth()
  signOut(@Req() request: Request) {
    this.identity.signOut(request);
    return { signedOut: true };
  }
}

@Module({
  controllers: [FoundationController, ProjectsController],
  providers: [Database, LocalIdentityProvider, ProjectsService],
})
export class AppModule {}
