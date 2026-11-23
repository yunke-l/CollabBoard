import {
  Body,
  Controller,
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
  mutationSchema,
  projectActionSchema,
  transferOwnershipSchema,
  updateProjectSchema,
  paginationQuerySchema,
} from '@collabboard/contracts';
import { pageQuery } from '../../platform/http/pagination.js';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { ProjectsService } from './projects.service.js';
import { validate } from './projects.controller.js';

const body = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      io: 'input',
      target: 'openapi-3.0',
    }) as SchemaObject,
  });

@ApiTags('Project lifecycle')
@ApiBearerAuth()
@Controller('projects')
export class LifecycleController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Read project details using current membership' })
  read(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.details(this.identity.authenticate(request).id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update project details as Owner with a board revision check',
  })
  @body(updateProjectSchema)
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.updateProject(
      this.identity.authenticate(request).id,
      id,
      validate(updateProjectSchema, input),
    );
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a project as Owner; retain read access' })
  @body(projectActionSchema)
  archive(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.setProjectArchived(
      this.identity.authenticate(request).id,
      id,
      true,
      validate(projectActionSchema, input),
    );
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a project as Owner after checking active-project quota',
  })
  @body(projectActionSchema)
  restore(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.setProjectArchived(
      this.identity.authenticate(request).id,
      id,
      false,
      validate(projectActionSchema, input),
    );
  }

  @Post(':id/ownership')
  @ApiOperation({
    summary:
      'Atomically transfer ownership to a current member within their quota',
  })
  @body(transferOwnershipSchema)
  transfer(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.transferOwnership(
      this.identity.authenticate(request).id,
      id,
      validate(transferOwnershipSchema, input),
    );
  }

  @Post(':id/leave')
  @ApiOperation({
    summary:
      'Leave a project, clear active assignments, and retain historical authorship',
  })
  @body(mutationSchema)
  leave(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.projects.leaveProject(
      this.identity.authenticate(request).id,
      id,
      validate(mutationSchema, input),
    );
  }

  @Get(':id/archived-tasks')
  @ApiOperation({
    summary: 'Read archived tasks with stable cursor pagination',
  })
  @pageQuery()
  archived(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const user = this.identity.authenticate(request);
    const { cursor, limit } = validate(paginationQuerySchema, query);
    return this.projects.archivedTasks(user.id, id, cursor, limit);
  }
}
