import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { mutationSchema } from '@collabboard/contracts';
import { requestBody } from '../../platform/http/request-body.js';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { validate } from '../projects/projects.controller.js';
import { TrialsService } from './trials.service.js';

@ApiTags('Isolated trials')
@ApiBearerAuth()
@Controller('demo/projects')
export class TrialsController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(TrialsService) private readonly trials: TrialsService,
  ) {}
  @Get('current')
  async current(@Req() req: Request) {
    return {
      trial: await this.trials.current(this.identity.authenticate(req).id),
    };
  }
  @Post()
  @requestBody(mutationSchema)
  @ApiOperation({ summary: 'Create your own isolated seven-day sample copy' })
  create(@Req() req: Request, @Body() input: unknown) {
    return this.trials.create(
      this.identity.authenticate(req).id,
      validate(mutationSchema, input),
    );
  }
  @Post(':id/reset')
  @requestBody(mutationSchema)
  @ApiOperation({
    summary:
      'Expire an owned trial and atomically create a fresh copy with new IDs',
  })
  reset(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.trials.reset(
      this.identity.authenticate(req).id,
      id,
      validate(mutationSchema, input),
    );
  }
  @Post(':id/cleanup')
  @requestBody(mutationSchema)
  @ApiOperation({
    summary: 'Immediately withdraw trial access and queue physical cleanup',
  })
  cleanup(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.trials.cleanupOwned(
      this.identity.authenticate(req).id,
      id,
      validate(mutationSchema, input),
    );
  }
}
