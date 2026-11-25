import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  signUpSchema,
  signInSchema,
  verifyEmailSchema,
  emailSchema,
  resetPasswordSchema,
} from '@collabboard/contracts';
import { LocalAccounts } from '../../adapters/identity/local-accounts.js';
import { requestBody } from '../../platform/http/request-body.js';
import { validate } from '../projects/projects.controller.js';
import { LocalIdentityProvider } from './identity.service.js';

@ApiTags('Development identity')
@Controller('auth')
export class IdentityController {
  constructor(
    @Inject(LocalAccounts) private readonly accounts: LocalAccounts,
    @Inject(LocalIdentityProvider)
    private readonly identity: LocalIdentityProvider,
  ) {}
  @Post('sign-up')
  @requestBody(signUpSchema)
  @ApiOperation({
    summary:
      'Register with the local development identity adapter; a development mailbox code is returned',
  })
  signUp(@Req() req: Request, @Body() body: unknown) {
    this.accounts.limit(req.ip ?? 'loopback', 'registrations', 10);
    const input = validate(signUpSchema, body);
    return this.accounts.signUp(input.email, input.displayName, input.password);
  }
  @Post('sign-in')
  @requestBody(signInSchema)
  async signIn(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.accounts.limit(req.ip ?? 'loopback', 'sign-ins', 30);
    const input = validate(signInSchema, body);
    const { refreshToken, ...session } = await this.identity.signIn(
      input.email,
      input.password,
    );
    this.identity.setSignInCookie(req, response, refreshToken);
    return session;
  }
  @Post('verify-email')
  @requestBody(verifyEmailSchema)
  verify(@Body() body: unknown) {
    const input = validate(verifyEmailSchema, body);
    return this.accounts.verify(input.email, input.code);
  }
  @Post('resend-verification')
  @requestBody(emailSchema)
  resend(@Body() body: unknown) {
    return this.accounts.resend(validate(emailSchema, body).email);
  }
  @Post('recover')
  @requestBody(emailSchema)
  recover(@Body() body: unknown) {
    return this.accounts.recover(validate(emailSchema, body).email);
  }
  @Post('reset-password')
  @requestBody(resetPasswordSchema)
  reset(@Body() body: unknown) {
    const input = validate(resetPasswordSchema, body);
    return this.accounts.reset(input.email, input.code, input.password);
  }
  @Get('session')
  @ApiOperation({
    summary: 'Restore a local session through its HttpOnly refresh cookie',
  })
  refresh(@Req() req: Request) {
    const { user, accessToken, expiresAt } = this.identity.refresh(req);
    return { user, accessToken, expiresAt };
  }
}
