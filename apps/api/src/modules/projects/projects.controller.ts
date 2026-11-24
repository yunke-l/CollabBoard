import {
  BadRequestException,
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
import {
  createProjectSchema,
  createTaskSchema,
  paginationQuerySchema,
} from '@collabboard/contracts';
import { pageQuery } from '../../platform/http/pagination.js';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { ProjectsService } from './projects.service.js';

export function validate<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: { path: PropertyKey[]; message: string }[] };
        };
  },
  value: unknown,
) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues)
      (fieldErrors[issue.path.join('.') || 'form'] ??= []).push(issue.message);
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Please check the highlighted fields.',
      fieldErrors,
    });
  }
  return result.data;
}

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List projects belonging to the current user' })
  @pageQuery()
  list(@Req() request: Request, @Query() query: unknown) {
    const user = this.identity.authenticate(request);
    const { cursor, limit } = validate(paginationQuerySchema, query);
    return this.projects.list(user.id, cursor, limit);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a project and its Owner membership atomically',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'requestId'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 80 },
        fromSample: { type: 'boolean' },
        description: { type: 'string', maxLength: 1000 },
      },
    },
  })
  create(@Req() request: Request, @Body() body: unknown) {
    return this.projects.create(
      this.identity.authenticate(request).id,
      validate(createProjectSchema, body),
    );
  }

  @Get(':id/board')
  @ApiOperation({ summary: 'Read an authorized board snapshot' })
  board(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.board(this.identity.authenticate(request).id, id);
  }

  @Post(':id/tasks')
  @ApiOperation({ summary: 'Create a task with an idempotent request ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'requestId'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 10000 },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        dueDate: { type: 'string', format: 'date', nullable: true },
        assigneeId: { type: 'string', format: 'uuid', nullable: true },
      },
    },
  })
  createTask(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.projects.createTask(
      this.identity.authenticate(request).id,
      id,
      validate(createTaskSchema, body),
    );
  }
}
