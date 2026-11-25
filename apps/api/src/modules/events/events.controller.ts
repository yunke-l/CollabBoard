import {
  Controller,
  Get,
  HttpException,
  Inject,
  Req,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { LocalIdentityProvider } from '../identity/identity.service.js';
import { LocalHintTransport } from './hint-transport.js';
import { z } from 'zod';
import { validate } from '../projects/projects.controller.js';

@ApiTags('Events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
    @Inject(LocalHintTransport) private readonly transport: LocalHintTransport,
  ) {}
  @Get()
  @ApiOperation({
    summary:
      'Subscribe only to your own private update hints; client publishing is unsupported',
  })
  stream(
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: unknown,
  ) {
    const user = this.identity.authenticate(request);
    validate(z.strictObject({}), query);
    let unsubscribe: () => void;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      unsubscribe = this.transport.subscribe(user.id, (hint) => {
        if (response.writableLength > 65536) {
          response.end();
          return;
        }
        if (response.destroyed || response.writableEnded) return;
        response.write(`event: hint\ndata: ${JSON.stringify(hint)}\n\n`);
        // WebKit can hold the tail of a fetch stream until the next network
        // write. Flush the last hint in a burst without waiting for a heartbeat.
        if (flushTimer) flushTimer.refresh();
        else
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            if (!response.destroyed && !response.writableEnded)
              response.write(': flush\n\n');
          }, 50);
      });
    } catch {
      throw new HttpException(
        'Close another tab before opening more live connections.',
        429,
      );
    }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write('event: connected\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      try {
        this.identity.authenticate(request);
      } catch {
        response.end();
        return;
      }
      response.write(': heartbeat\n\n');
    }, 15000);
    const close = () => {
      clearTimeout(flushTimer);
      clearInterval(heartbeat);
      unsubscribe();
    };
    response.once('close', close);
  }
}
