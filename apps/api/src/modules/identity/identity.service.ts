import { randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@collabboard/contracts';
import { localIdentities } from '../../adapters/identity/local-identities.js';

export interface IdentityProvider {
  authenticate(request: Request): User;
}

@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  private readonly sessions = new Map<
    string,
    { user: User; expiresAt: number }
  >();
  createSession(userId: unknown) {
    const user = localIdentities.find((identity) => identity.id === userId);
    if (!user)
      throw new UnauthorizedException('Choose a configured local identity.');
    const now = Date.now();
    for (const [token, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(token);
    if (this.sessions.size >= 100)
      throw new UnauthorizedException(
        'Too many local sessions. Restart the development API.',
      );
    const accessToken = randomBytes(32).toString('hex');
    const expiresAt = now + 60 * 60 * 1000;
    this.sessions.set(accessToken, { user, expiresAt });
    return { accessToken, user, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(request: Request) {
    const session = this.sessions.get(this.token(request));
    if (!session || session.expiresAt <= Date.now())
      throw new UnauthorizedException(
        'Your session has expired. Please sign in again.',
      );
    return session.user;
  }
  signOut(request: Request) {
    this.sessions.delete(this.token(request));
  }
  private token(request: Request) {
    return request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  }
}
