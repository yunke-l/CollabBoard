import { randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { User } from '@collabboard/contracts';
import { localIdentities } from '../../adapters/identity/local-identities.js';
import { LocalAccounts } from '../../adapters/identity/local-accounts.js';
import { Database } from '../../platform/database/database.js';
import { readEnvironment } from '../../config/environment.js';

export interface IdentityProvider {
  authenticate(request: Request): User;
}
export const refreshCookie = 'collabboard.refresh';
export function cookieToken(request: Request) {
  return (
    request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${refreshCookie}=`))
      ?.slice(refreshCookie.length + 1) ?? ''
  );
}

@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  private readonly sessions = new Map<
    string,
    { user: User; expiresAt: number; refreshHash: string }
  >();
  constructor(
    @Inject(LocalAccounts) private readonly accounts: LocalAccounts,
    @Inject(Database) private readonly database: Database,
  ) {}
  createSession(userId: unknown) {
    const user = localIdentities.find((identity) => identity.id === userId);
    if (!user)
      throw new UnauthorizedException('Choose a configured local identity.');
    return this.session(user);
  }
  async signIn(email: string, password: string) {
    const user = this.accounts.signIn(email, password);
    await this.database.pool.query(
      `INSERT INTO users(id,identity_subject,email,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT(identity_subject) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
      [user.id, `local-account:${user.id}`, user.email, user.displayName],
    );
    return this.session(user);
  }
  refresh(request: Request) {
    const token = cookieToken(request);
    return this.session(this.accounts.refresh(token), token);
  }
  authenticate(request: Request) {
    const token = this.token(request);
    const session = this.sessions.get(token);
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      !this.accounts.live(session.refreshHash)
    ) {
      this.sessions.delete(token);
      throw new UnauthorizedException(
        'Your session has expired. Please sign in again.',
      );
    }
    return session.user;
  }
  signOut(request: Request) {
    const token = this.token(request);
    const session = this.sessions.get(token);
    if (session) this.accounts.revokeHash(session.refreshHash);
    this.accounts.revoke(cookieToken(request));
    this.sessions.delete(token);
  }
  setSignInCookie(request: Request, response: Response, token: string) {
    if (this.token(request)) this.signOut(request);
    response.cookie(refreshCookie, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 86400000,
      secure: readEnvironment().hostedDemo,
    });
  }
  private session(
    user: User,
    refreshToken = this.accounts.createRefresh(user),
  ) {
    const now = Date.now();
    for (const [token, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(token);
    if (this.sessions.size >= 1000)
      throw new UnauthorizedException(
        'Too many local sessions. Try again later.',
      );
    const accessToken = randomBytes(32).toString('hex');
    const expiresAt = now + 3600000;
    this.sessions.set(accessToken, {
      user,
      expiresAt,
      refreshHash: this.accounts.refreshHash(refreshToken),
    });
    return {
      accessToken,
      user,
      expiresAt: new Date(expiresAt).toISOString(),
      refreshToken,
    };
  }
  private token(request: Request) {
    return request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  }
}
