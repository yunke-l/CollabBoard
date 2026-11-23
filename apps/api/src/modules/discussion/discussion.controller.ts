import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
  type SchemaObject,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  activityQuerySchema,
  commentActionSchema,
  createCommentSchema,
  paginationQuerySchema,
  updateCommentSchema,
} from '@collabboard/contracts';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { validate } from '../projects/projects.controller.js';
import { pageQuery } from '../../platform/http/pagination.js';
import { DiscussionService } from './discussion.service.js';

const body = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      io: 'input',
      target: 'openapi-3.0',
    }) as SchemaObject,
  });

@ApiTags('Comments and activity')
@ApiBearerAuth()
@Controller()
export class DiscussionController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(DiscussionService) private readonly discussion: DiscussionService,
  ) {}

  @Get('tasks/:id/comments')
  @ApiOperation({
    summary:
      'Read comment pages and tombstones with current project membership',
  })
  @pageQuery()
  comments(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const user = this.identity.authenticate(request);
    const { cursor, limit } = validate(paginationQuerySchema, query);
    return this.discussion.comments(user.id, id, cursor, limit);
  }

  @Post('tasks/:id/comments')
  @ApiOperation({
    summary:
      'Add a plain-text comment atomically with activity, outbox, and revision',
  })
  @body(createCommentSchema)
  create(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.discussion.create(
      this.identity.authenticate(request).id,
      id,
      validate(createCommentSchema, input),
    );
  }

  @Get('comments/:id')
  @ApiOperation({
    summary:
      'Read the current comment version or deleted tombstone independently',
  })
  comment(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.discussion.comment(this.identity.authenticate(request).id, id);
  }

  @Patch('comments/:id')
  @ApiOperation({
    summary: 'Edit only your own comment using its expected version',
  })
  @body(updateCommentSchema)
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.discussion.update(
      this.identity.authenticate(request).id,
      id,
      validate(updateCommentSchema, input),
    );
  }

  @Delete('comments/:id')
  @ApiOperation({
    summary:
      'Delete an authorized comment body and retain its versioned tombstone',
  })
  @body(commentActionSchema)
  delete(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.discussion.delete(
      this.identity.authenticate(request).id,
      id,
      validate(commentActionSchema, input),
    );
  }

  @Get('projects/:id/activity')
  @ApiOperation({
    summary: 'Read immutable project activity, optionally filtered to one task',
  })
  @pageQuery()
  @ApiQuery({ name: 'taskId', required: false, type: String, format: 'uuid' })
  activity(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const user = this.identity.authenticate(request);
    const { cursor, limit, taskId } = validate(activityQuerySchema, query);
    return this.discussion.activity(user.id, id, taskId, cursor, limit);
  }
}
