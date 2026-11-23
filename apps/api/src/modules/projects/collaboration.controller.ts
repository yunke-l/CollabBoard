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
  ApiTags,
  type SchemaObject,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  acceptInvitationSchema,
  changeRoleSchema,
  createInvitationSchema,
  invitationCredentialSchema,
  moveTaskSchema,
  mutationSchema,
  updateTaskSchema,
  taskActionSchema,
  paginationQuerySchema,
} from '@collabboard/contracts';
import { pageQuery } from '../../platform/http/pagination.js';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { ProjectsService } from './projects.service.js';
import { validate } from './projects.controller.js';

// Describe the same input schemas used for runtime validation.
const body = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      io: 'input',
      target: 'openapi-3.0',
    }) as SchemaObject,
  });

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Read an individual task with current membership checks',
  })
  read(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.task(this.identity.authenticate(request).id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit and assign a task using its expected version',
  })
  @body(updateTaskSchema)
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.updateTask(
      this.identity.authenticate(request).id,
      id,
      validate(updateTaskSchema, input),
    );
  }

  @Post(':id/move')
  @ApiOperation({
    summary: 'Move a task before another task or append to a column',
  })
  @body(moveTaskSchema)
  move(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.moveTask(
      this.identity.authenticate(request).id,
      id,
      validate(moveTaskSchema, input),
    );
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a task using its expected version' })
  @body(taskActionSchema)
  archive(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.setTaskArchived(
      this.identity.authenticate(request).id,
      id,
      true,
      validate(taskActionSchema, input),
    );
  }

  @Post(':id/restore')
  @ApiOperation({
    summary:
      'Restore a task, recheck quota and assignee, and append to its previous column',
  })
  @body(taskActionSchema)
  restore(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.setTaskArchived(
      this.identity.authenticate(request).id,
      id,
      false,
      validate(taskActionSchema, input),
    );
  }
}

@ApiTags('Members')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class MembersController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Get('members')
  @ApiOperation({
    summary: 'Read the member roster, bounded by the project member quota',
  })
  members(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.members(
      this.identity.authenticate(request).id,
      projectId,
    );
  }

  @Get('invitations')
  @ApiOperation({
    summary:
      'Read unexpired pending invitations as Owner with stable cursor pagination',
  })
  @pageQuery()
  invitations(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: unknown,
  ) {
    const user = this.identity.authenticate(request);
    const { cursor, limit } = validate(paginationQuerySchema, query);
    return this.projects.invitations(user.id, projectId, cursor, limit);
  }

  @Post('invitations')
  @ApiOperation({
    summary: 'Create a 72-hour invitation; persist only the credential hash',
  })
  @body(createInvitationSchema)
  invite(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: unknown,
  ) {
    return this.projects.createInvitation(
      this.identity.authenticate(request).id,
      projectId,
      validate(createInvitationSchema, input),
    );
  }

  @Post('invitations/:id/revoke')
  @ApiOperation({ summary: 'Revoke a pending invitation as Owner' })
  @body(mutationSchema)
  revoke(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.revokeInvitation(
      this.identity.authenticate(request).id,
      projectId,
      id,
      validate(mutationSchema, input),
    );
  }

  @Patch('members/:id')
  @ApiOperation({
    summary: 'Change an Editor or Viewer role and clear ineligible assignments',
  })
  @body(changeRoleSchema)
  change(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.changeMember(
      this.identity.authenticate(request).id,
      projectId,
      id,
      validate(changeRoleSchema, input),
    );
  }

  @Delete('members/:id')
  @ApiOperation({
    summary: 'Remove a member and clear their active assignments',
  })
  @body(mutationSchema)
  remove(
    @Req() request: Request,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.changeMember(
      this.identity.authenticate(request).id,
      projectId,
      id,
      validate(mutationSchema, input),
    );
  }
}

@ApiTags('Invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Post('preview')
  @ApiOperation({
    summary:
      'Preview minimal invitation information using a credential in the body',
  })
  @body(invitationCredentialSchema)
  preview(@Body() input: unknown) {
    return this.projects.previewInvitation(
      validate(invitationCredentialSchema, input).token,
    );
  }

  @Post('accept')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Accept an invitation using the matching verified identity',
  })
  @body(acceptInvitationSchema)
  accept(@Req() request: Request, @Body() input: unknown) {
    return this.projects.acceptInvitation(
      this.identity.authenticate(request),
      validate(acceptInvitationSchema, input),
    );
  }
}
