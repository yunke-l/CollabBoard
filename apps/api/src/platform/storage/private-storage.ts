import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class LocalPrivateStorage {
  readonly root: string;
  private key?: Promise<Buffer>;
  constructor(
    root = resolve(process.env.LOCAL_STATE_DIR ?? '.local', 'private-files'),
  ) {
    this.root = resolve(root);
  }
  private file(key: string) {
    if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key))
      throw new Error('Invalid private storage key.');
    const file = resolve(this.root, key);
    if (!file.startsWith(this.root + sep))
      throw new Error('Invalid private storage key.');
    return file;
  }
  private secret() {
    return (this.key ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = resolve(this.root, '.capability-key');
      try {
        await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const key = await readFile(file);
      if (key.length !== 32)
        throw new Error('Invalid local storage capability key.');
      return key;
    })());
  }
  async sign(value: object) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', await this.secret())
      .update(payload)
      .digest('base64url')}`;
  }
  async verify<T extends { expiresAt: number; purpose: string }>(
    token: string,
    purpose: string,
  ): Promise<T> {
    const denied = () =>
      new UnauthorizedException(
        'This file authorization is invalid or expired. Request a new link.',
      );
    if (token.length > 2048) throw denied();
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw denied();
    const expected = createHmac('sha256', await this.secret())
      .update(payload)
      .digest();
    const received = Buffer.from(signature, 'base64url');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw denied();
    try {
      const value = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as T;
      if (
        value.purpose !== purpose ||
        typeof value.expiresAt !== 'number' ||
        value.expiresAt <= Date.now()
      )
        throw denied();
      return value;
    } catch {
      throw denied();
    }
  }
  async put(key: string, body: Buffer) {
    const file = this.file(key);
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(12).toString('hex')}.pending`;
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  get(key: string) {
    return readFile(this.file(key));
  }
  remove(key: string) {
    return rm(this.file(key), { force: true });
  }
  async cleanupOrphans(associated: (key: string) => Promise<boolean>) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const project of await readdir(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || !/^[a-f0-9-]+$/.test(project.name))
        continue;
      for (const task of await readdir(resolve(this.root, project.name), {
        withFileTypes: true,
      })) {
        if (!task.isDirectory() || !/^[a-f0-9-]+$/.test(task.name)) continue;
        for (const item of await readdir(
          resolve(this.root, project.name, task.name),
          { withFileTypes: true },
        )) {
          if (
            !item.isFile() ||
            !/^[a-f0-9-]+(?:\.[a-f0-9]+\.pending)?$/.test(item.name)
          )
            continue;
          const file = resolve(this.root, project.name, task.name, item.name);
          let age;
          try {
            age = Date.now() - (await stat(file)).mtimeMs;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (age < 900000) continue;
          const key = `${project.name}/${task.name}/${item.name}`;
          if (item.name.endsWith('.pending') || !(await associated(key)))
            await rm(file, { force: true });
        }
      }
    }
  }
}
