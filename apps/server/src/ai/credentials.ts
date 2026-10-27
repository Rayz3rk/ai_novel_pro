import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AppError } from '../errors.js';

/** This file is deliberately outside the workspace database and all backup serializers. */
export class Credentials {
  readonly directory: string;
  constructor(directory = join(homedir(), '.shujian', 'credentials'), workspaceDirectory?: string) {
    this.directory = resolve(directory);
    if (workspaceDirectory) {
      const root = resolve(workspaceDirectory);
      const candidate=process.platform==='win32'?this.directory.toLocaleLowerCase():this.directory;
      const boundary=process.platform==='win32'?root.toLocaleLowerCase():root;
      if (candidate === boundary || candidate.startsWith(boundary + sep)) throw new AppError(400, 'CREDENTIAL_LOCATION', '模型凭据目录必须放在作品目录之外。');
    }
  }
  private path(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new AppError(400,'INVALID_CONNECTION','模型连接标识不正确。');
    return join(this.directory,id==='default'?'model-key.json':`connection-${id}.json`);
  }
  get(id = 'default'): string {
    const path = this.path(id);
    if (!existsSync(path)) return '';
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { apiKey?: unknown };
      return typeof raw.apiKey === 'string' ? raw.apiKey : '';
    } catch { throw new AppError(500, 'CREDENTIAL_UNAVAILABLE', '本机模型凭据暂时无法读取，请在模型设置中重新保存密钥。'); }
  }
  set(apiKey: string, id = 'default'): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ apiKey }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  }
}
