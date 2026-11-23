import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { mutationSchema, paginationQuerySchema } from '@collabboard/contracts';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { validate } from '../projects/projects.controller.js';
import { pageQuery } from '../../platform/http/pagination.js';
import { NotificationsService } from './notifications.service.js';

const mutationBody = () =>
  ApiBody({
    schema: {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: { type: 'string', format: 'uuid' } },
    },
  });

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List current recipient notifications, redacting inaccessible targets',
  })
  @pageQuery()
  list(@Req() request: Request, @Query() query: unknown) {
    const user = this.identity.authenticate(request);
    const { cursor, limit } = validate(paginationQuerySchema, query);
    return this.notifications.list(user.id, cursor, limit);
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Count only the current recipient unread notifications',
  })
  summary(@Req() request: Request) {
    return this.notifications.summary(this.identity.authenticate(request).id);
  }

  @Post('read-all')
  @ApiOperation({
    summary:
      'Mark current recipient notifications read at a server-captured boundary; retries preserve the original result',
  })
  @mutationBody()
  readAll(@Req() request: Request, @Body() input: unknown) {
    return this.notifications.readAll(
      this.identity.authenticate(request).id,
      validate(mutationSchema, input),
    );
  }

  @Post(':id/read')
  @ApiOperation({
    summary: 'Mark only a current recipient notification read, idempotently',
  })
  @mutationBody()
  read(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.notifications.read(
      this.identity.authenticate(request).id,
      id,
      validate(mutationSchema, input),
    );
  }
}
