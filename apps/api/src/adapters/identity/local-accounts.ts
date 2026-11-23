import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { User } from '@collabboard/contracts';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
type Account = {
  id: string;
  email: string;
  name: string;
  salt: string;
  password: string;
  verified: number;
  verify_hash: string | null;
  verify_until: number | null;
  recovery_hash: string | null;
  recovery_until: number | null;
};
const userView = (account: Account): User => ({
  id: account.id,
  email: account.email,
  displayName: account.name,
  emailVerified: !!account.verified,
});
const passwordHash = (password: string, salt: string) =>
  scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });

// This development identity store is separate from the business database.
// It is loopback-only and is never a production password provider.
@Injectable()
export class LocalAccounts implements OnModuleDestroy {
  private readonly db: DatabaseSync;
  constructor(
    filename = resolve(
      process.env.LOCAL_STATE_DIR ?? '.local',
      'identity.sqlite',
    ),
  ) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, verify_hash TEXT, verify_until INTEGER, recovery_hash TEXT, recovery_until INTEGER);
      CREATE TABLE IF NOT EXISTS refresh_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_json TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts(subject TEXT NOT NULL, bucket TEXT NOT NULL, window INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(subject,bucket,window));`);
  }
  onModuleDestroy() {
    this.db.close();
  }
  limit(subject: string, bucket: string, maximum = 10) {
    const window = Math.floor(Date.now() / 60000);
    this.db
      .prepare('DELETE FROM auth_attempts WHERE window < ?')
      .run(window - 2);
    const result = this.db
      .prepare(
        'INSERT INTO auth_attempts(subject,bucket,window,used) VALUES (?,?,?,1) ON CONFLICT(subject,bucket,window) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used',
      )
      .get(hash(subject), bucket, window, maximum);
    if (!result)
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many identity attempts. Wait one minute and try again.',
          retryAfterSeconds: 60,
        },
        429,
      );
  }
  signUp(email: string, name: string, password: string) {
    this.limit(email, 'sign-up', 5);
    if (this.account(email))
      throw new ConflictException(
        'This email already has a local account. Sign in or recover its password.',
      );
    const salt = randomBytes(16).toString('hex');
    const code = this.code();
    this.db
      .prepare(
        'INSERT INTO accounts(id,email,name,salt,password,verify_hash,verify_until) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        email,
        name,
        salt,
        passwordHash(password, salt).toString('hex'),
        hash(code),
        Date.now() + 600000,
      );
    return { email, verificationRequired: true, developmentCode: code };
  }
  verify(email: string, code: string) {
    this.limit(email, 'verify', 5);
    const account = this.account(email);
    if (
      !account ||
      !account.verify_hash ||
      !account.verify_until ||
      account.verify_until <= Date.now() ||
      hash(code) !== account.verify_hash
    )
      throw new BadRequestException(
        'The verification code is invalid or expired. Request a new code.',
      );
    this.db
      .prepare(
        'UPDATE accounts SET verified = 1, verify_hash = NULL, verify_until = NULL WHERE id = ?',
      )
      .run(account.id);
    return { verified: true };
  }
  resend(email: string) {
    this.limit(email, 'resend', 3);
    const code = this.code();
    const account = this.account(email);
    if (account && !account.verified)
      this.db
        .prepare(
          'UPDATE accounts SET verify_hash = ?, verify_until = ? WHERE id = ?',
        )
        .run(hash(code), Date.now() + 600000, account.id);
    return { sent: true, developmentCode: code };
  }
  signIn(email: string, password: string) {
    this.limit(email, 'sign-in', 10);
    const account = this.account(email);
    const salt = account?.salt ?? '00000000000000000000000000000000';
    const actual = passwordHash(password, salt);
    const expected = account
      ? Buffer.from(account.password, 'hex')
      : Buffer.alloc(64);
    if (!account || !timingSafeEqual(actual, expected))
      throw new UnauthorizedException('The email or password is incorrect.');
    if (!account.verified)
      throw new HttpException(
        {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Verify your email before signing in.',
        },
        403,
      );
    return userView(account);
  }
  recover(email: string) {
    this.limit(email, 'recover', 3);
    const code = this.code();
    const account = this.account(email);
    if (account)
      this.db
        .prepare(
          'UPDATE accounts SET recovery_hash = ?, recovery_until = ? WHERE id = ?',
        )
        .run(hash(code), Date.now() + 600000, account.id);
    return { sent: true, developmentCode: code };
  }
  reset(email: string, code: string, password: string) {
    this.limit(email, 'reset', 5);
    const account = this.account(email);
    if (
      !account ||
      !account.recovery_hash ||
      !account.recovery_until ||
      account.recovery_until <= Date.now() ||
      account.recovery_hash !== hash(code)
    )
      throw new BadRequestException(
        'The recovery code is invalid or expired. Request another code.',
      );
    const salt = randomBytes(16).toString('hex');
    const digest = passwordHash(password, salt).toString('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'UPDATE accounts SET salt = ?, password = ?, recovery_hash = NULL, recovery_until = NULL WHERE id = ?',
        )
        .run(salt, digest, account.id);
      this.db
        .prepare('DELETE FROM refresh_sessions WHERE user_id = ?')
        .run(account.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { reset: true };
  }
  createRefresh(user: User) {
    this.db
      .prepare('DELETE FROM refresh_sessions WHERE expires_at <= ?')
      .run(Date.now());
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare(
        'INSERT INTO refresh_sessions(token_hash,user_id,user_json,expires_at) VALUES (?,?,?,?)',
      )
      .run(
        hash(token),
        user.id,
        JSON.stringify(user),
        Date.now() + 7 * 86400000,
      );
    return token;
  }
  refresh(token: string) {
    const session = this.db
      .prepare(
        'SELECT user_json FROM refresh_sessions WHERE token_hash = ? AND expires_at > ?',
      )
      .get(hash(token), Date.now()) as { user_json: string } | undefined;
    if (!session)
      throw new UnauthorizedException('Your session expired. Sign in again.');
    return JSON.parse(session.user_json) as User;
  }
  live(refreshHash: string) {
    return !!this.db
      .prepare(
        'SELECT 1 FROM refresh_sessions WHERE token_hash = ? AND expires_at > ?',
      )
      .get(refreshHash, Date.now());
  }
  refreshHash(token: string) {
    return hash(token);
  }
  revoke(token: string) {
    this.revokeHash(hash(token));
  }
  revokeHash(refreshHash: string) {
    this.db
      .prepare('DELETE FROM refresh_sessions WHERE token_hash = ?')
      .run(refreshHash);
  }
  private code() {
    return randomInt(0, 1000000).toString().padStart(6, '0');
  }
  private account(email: string) {
    return this.db
      .prepare('SELECT * FROM accounts WHERE email = ?')
      .get(email) as Account | undefined;
  }
}
