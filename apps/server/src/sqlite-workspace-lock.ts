import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';

/**
 * A separate SQLite transaction is the process mutex for one workspace file.
 * Native file locks survive slow disks and are released by the OS after a crash.
 * Keep the lock file: unlinking it would let two processes lock different inodes.
 */
export class SqliteWorkspaceLock {
  private connection: DatabaseSync | undefined;
  readonly filename: string;

  constructor(workspaceFile: string) {
    const absolute = resolve(workspaceFile);
    const canonical = existsSync(absolute) ? realpathSync.native(absolute)
      : join(realpathSync.native(dirname(absolute)), basename(absolute));
    this.filename = `${canonical}.instance-lock.sqlite`;
    let connection: DatabaseSync | undefined;
    try {
      connection = new DatabaseSync(this.filename);
      connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      this.connection = connection;
    } catch (error) {
      connection?.close();
      const failure = error as { errcode?: number; message?: string };
      if ((typeof failure.errcode === 'number' && [5, 6].includes(failure.errcode & 0xff))
        || /database (?:table |schema )?is locked/i.test(failure.message ?? '')) {
        throw new AppError(409, 'WORKSPACE_IN_USE', '这个 SQLite 工作区已由另一个书间进程使用。请回到已打开的书间，或先关闭原进程后重试。');
      }
      throw new AppError(503, 'WORKSPACE_LOCK_UNAVAILABLE', '无法取得 SQLite 工作区锁，请检查数据目录权限和本机磁盘状态。');
    }
  }

  close(): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
  }
}
