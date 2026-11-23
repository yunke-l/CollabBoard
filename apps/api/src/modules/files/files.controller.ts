import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiHeader,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  initializeAttachmentSchema,
  limits,
  mutationSchema,
  paginationQuerySchema,
} from '@collabboard/contracts';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { validate } from '../projects/projects.controller.js';
import { pageQuery } from '../../platform/http/pagination.js';
import { requestBody } from '../../platform/http/request-body.js';
import { FilesService } from './files.service.js';

@ApiTags('Private attachments')
@ApiBearerAuth()
@Controller()
export class FilesController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}
  @Get('tasks/:id/attachments')
  @pageQuery()
  list(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() input: unknown,
  ) {
    const user = this.identity.authenticate(req);
    const { cursor, limit } = validate(paginationQuerySchema, input);
    return this.files.list(user.id, id, cursor, limit);
  }
  @Post('tasks/:id/attachments')
  @ApiOperation({
    summary:
      'Reserve private upload slots and storage for 15 minutes; authorization lasts at most five minutes',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['requestId', 'originalName', 'sizeBytes', 'mediaType'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        originalName: { type: 'string' },
        sizeBytes: {
          type: 'integer',
          minimum: 1,
          maximum: limits.attachmentBytes,
        },
        mediaType: { type: 'string' },
      },
    },
  })
  initialize(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.files.initialize(
      this.identity.authenticate(req).id,
      id,
      validate(initializeAttachmentSchema, input),
    );
  }
  @Put('attachments/:id/content')
  @ApiConsumes('application/octet-stream')
  @ApiHeader({ name: 'X-Upload-Token', required: true })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary:
      'Send reserved bytes using the returned X-Upload-Token and application/octet-stream',
  })
  async upload(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-upload-token') token = '',
  ) {
    const user = this.identity.authenticate(req);
    if (Number(req.headers['content-length']) > limits.attachmentBytes)
      throw new PayloadTooLargeException(
        'Each attachment is limited to 10 MiB.',
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const body = Buffer.from(chunk);
      size += body.length;
      if (size > limits.attachmentBytes)
        throw new PayloadTooLargeException(
          'Each attachment is limited to 10 MiB.',
        );
      chunks.push(body);
    }
    return this.files.upload(user.id, id, token, Buffer.concat(chunks));
  }
  @Post('attachments/:id/complete')
  @requestBody(mutationSchema)
  complete(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.files.complete(
      this.identity.authenticate(req).id,
      id,
      validate(mutationSchema, input),
    );
  }
  @Delete('attachments/:id')
  @requestBody(mutationSchema)
  delete(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: unknown,
  ) {
    return this.files.delete(
      this.identity.authenticate(req).id,
      id,
      validate(mutationSchema, input),
    );
  }
  @Post('attachments/:id/download')
  download(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.download(this.identity.authenticate(req).id, id);
  }
  @Get('downloads/:token')
  @ApiOperation({
    summary:
      'Consume a short-lived download capability; ready state and membership are rechecked',
  })
  async downloaded(@Param('token') token: string, @Res() res: Response) {
    const file = await this.files.downloaded(token);
    const fallback = file.name.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const encoded = encodeURIComponent(file.name).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Length', file.body.length);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(file.body);
  }
}
