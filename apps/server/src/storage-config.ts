import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { AppError } from './errors.js';
import type { StorageInfo } from '@shujian/contracts';
export type { StorageInfo } from '@shujian/contracts';

export interface PostgresConfig {
  url: string;
  createDatabase: boolean;
  maintenanceDatabase: string;
  statementTimeoutMs: number;
}
export type StorageConfig = { driver: 'sqlite'; filename: string } | { driver: 'postgresql'; postgres: PostgresConfig };

function invalid(): never { throw new AppError(500, 'STORAGE_CONFIG', '数据库配置不正确，请检查项目外的 database.json；连接密码不会显示在日志中。'); }
function privatePath(file: string, root: string): void {
  const path = resolve(file).toLowerCase(); const boundary = resolve(root).toLowerCase();
  if (path === boundary || path.startsWith(boundary + sep)) throw new AppError(500, 'STORAGE_LOCATION', '数据库连接配置必须放在项目目录之外。');
}
export function parsePostgresConfig(value: unknown): PostgresConfig {
  if (!value || typeof value !== 'object') return invalid();
  const row = value as Record<string, unknown>;
  if (typeof row.url !== 'string') return invalid();
  let url: URL;
  try { url = new URL(row.url); } catch { return invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !/^\/[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(url.pathname)) return invalid();
  const maintenance = row.maintenanceDatabase ?? 'postgres';
  const timeout = row.statementTimeoutMs ?? 10000;
  if (typeof maintenance !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(maintenance)
    || typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60000
    || (row.createDatabase !== undefined && typeof row.createDatabase !== 'boolean')) return invalid();
  return { url: row.url, createDatabase: row.createDatabase !== false, maintenanceDatabase: maintenance, statementTimeoutMs: timeout };
}

export function loadStorageConfig(root: string, dataDir: string, configFile = process.env.NOVEL_DATABASE_FILE ?? resolve(root, '../novel-private/database.json')): { config: StorageConfig; configFile: string } {
  privatePath(configFile, root);
  if (process.env.NOVEL_DATABASE_URL) return { config: { driver: 'postgresql', postgres: parsePostgresConfig({ url: process.env.NOVEL_DATABASE_URL }) }, configFile };
  if (!existsSync(configFile)) return { config: { driver: 'sqlite', filename: resolve(dataDir, 'workspace.sqlite') }, configFile };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return invalid(); }
  if (!raw || typeof raw !== 'object') return invalid();
  const row = raw as Record<string, unknown>;
  if (row.driver === 'postgresql') return { config: { driver: 'postgresql', postgres: parsePostgresConfig(row.postgresql) }, configFile };
  if (row.driver !== 'sqlite') return invalid();
  const sqlite = row.sqlite as Record<string, unknown> | undefined;
  const filename = sqlite?.filename ?? resolve(dataDir, 'workspace.sqlite');
  if (typeof filename !== 'string' || !filename.trim()) return invalid();
  return { config: { driver: 'sqlite', filename: isAbsolute(filename) ? filename : resolve(root, filename) }, configFile };
}

export function storageInfo(config: StorageConfig, configFile?: string): StorageInfo {
  if (config.driver === 'sqlite') return { driver: 'sqlite', database: config.filename, ...(configFile ? { configFile } : {}) };
  const url = new URL(config.postgres.url);
  return { driver: 'postgresql', database: url.pathname.slice(1), host: url.hostname, port: Number(url.port || 5432), ...(configFile ? { configFile } : {}) };
}

export function storageState(config: StorageConfig, root: string, configFile?: string): StorageInfo {
  const result = storageInfo(config, configFile);
  result.nextDriver = config.driver; result.canSelect = false;
  if (!configFile || !existsSync(configFile) || process.env.NOVEL_DATABASE_URL) return result;
  privatePath(configFile, root);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch { return invalid(); }
  result.nextDriver = raw.driver === 'postgresql' ? 'postgresql' : 'sqlite';
  result.canSelect = true; result.hasPostgresConfig = !!raw.postgresql;
  return result;
}

export function selectStorageDriver(driver: StorageConfig['driver'], root: string, dataDir: string, configFile?: string): void {
  if (!configFile || process.env.NOVEL_DATABASE_URL) throw new AppError(409, 'STORAGE_ENVIRONMENT', '当前数据库由启动参数指定，请修改对应启动配置后重启。');
  privatePath(configFile, root);
  let raw: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    try { raw = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch { return invalid(); }
  }
  if (driver === 'postgresql') parsePostgresConfig(raw.postgresql);
  if (!raw.sqlite) raw.sqlite = { filename: resolve(dataDir, 'workspace.sqlite') };
  raw.driver = driver;
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(raw, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, configFile);
}
