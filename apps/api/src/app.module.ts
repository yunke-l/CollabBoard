import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Module,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { readEnvironment } from './config/environment.js';
import { Database } from './platform/database/database.js';
import {
  LocalIdentityProvider,
  refreshCookie,
} from './modules/identity/identity.service.js';
import { LocalAccounts } from './adapters/identity/local-accounts.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { localIdentities } from './adapters/identity/local-identities.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { ProjectsController } from './modules/projects/projects.controller.js';
import { LifecycleController } from './modules/projects/lifecycle.controller.js';
import {
  InvitationsController,
  MembersController,
  TasksController,
} from './modules/projects/collaboration.controller.js';
import { sampleBoard } from './modules/demo/sample.js';
import { NotificationsController } from './modules/notifications/notifications.controller.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { DiscussionController } from './modules/discussion/discussion.controller.js';
import { DiscussionService } from './modules/discussion/discussion.service.js';
import { FilesController } from './modules/files/files.controller.js';
import { FilesService } from './modules/files/files.service.js';
import { MaintenanceService } from './platform/jobs/maintenance.service.js';
import { LocalPrivateStorage } from './platform/storage/private-storage.js';
import { EventsController } from './modules/events/events.controller.js';
import { DispatcherService } from './modules/events/dispatcher.service.js';
import {
  HINT_TRANSPORT,
  LocalHintTransport,
} from './modules/events/hint-transport.js';

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
      await this.database.pool.query('SELECT 1 FROM rate_limits LIMIT 1');
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
  session(
    @Req() request: Request,
    @Body() body: { userId?: unknown } | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { refreshToken, ...session } = this.identity.createSession(
      body?.userId,
    );
    this.identity.setSignInCookie(request, response, refreshToken);
    return session;
  }

  @Get('me')
  @ApiBearerAuth()
  me(@Req() request: Request) {
    return this.identity.authenticate(request);
  }

  @Delete('auth/session')
  @ApiBearerAuth()
  signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.identity.signOut(request);
    response.clearCookie(refreshCookie, {
      secure: readEnvironment().hostedDemo,
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'strict',
    });
    return { signedOut: true };
  }
}

@Module({
  controllers: [
    FoundationController,
    IdentityController,
    ProjectsController,
    LifecycleController,
    InvitationsController,
    MembersController,
    TasksController,
    NotificationsController,
    DiscussionController,
    FilesController,
    EventsController,
  ],
  providers: [
    Database,
    LocalIdentityProvider,
    LocalAccounts,
    ProjectsService,
    NotificationsService,
    DiscussionService,
    LocalPrivateStorage,
    FilesService,
    MaintenanceService,
    LocalHintTransport,
    { provide: HINT_TRANSPORT, useExisting: LocalHintTransport },
    DispatcherService,
  ],
})
export class AppModule {}
