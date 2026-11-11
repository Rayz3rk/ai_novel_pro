import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { BackupCatalog, BackupCleanup, BackupSummary, WorkspaceBackup } from '@shujian/contracts';
import { AppError, notFound } from './errors.js';
import type { Store } from './store.js';
import * as validate from './validation.js';

const MAX_BYTES = 64 * 1024 * 1024;
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
interface Entry { summary: BackupSummary; backup: WorkspaceBackup }

export class BackupManager {
  private readonly root: string;
  constructor(readonly store: Store, dataDir: string) { this.root = resolve(dataDir, 'backups'); }
  private file(id: string): string {
    if (!/^(managed|before-delete|legacy-import-\d+)\/[\w.-]+\.json$/.test(id)) throw new AppError(400, 'BACKUP_ID', '备份标识不正确。');
    const file = resolve(this.root, id);
    if (!existsSync(file)) return notFound('备份');
    const boundary = realpathSync(this.root) + sep;
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !realpathSync(file).startsWith(boundary)) throw new AppError(400, 'BACKUP_PATH', '备份路径不正确。');
    return file;
  }
  private read(id: string): Entry {
    const file = this.file(id);
    const bytes = statSync(file).size;
    if (bytes > MAX_BYTES) throw new AppError(413, 'BACKUP_TOO_LARGE', '备份超过 64 MB。');
    const text = readFileSync(file, 'utf8');
    const backup = validate.backup(JSON.parse(text));
    return { backup, summary: { id, createdAt: backup.exportedAt, bytes, fingerprint: fingerprint(text),
      books: backup.books.map(entry => ({ title: entry.book.title, chapters: entry.chapters.length,
        words: entry.chapters.reduce((sum, item) => sum + item.chapter.wordCount, 0), archived: entry.chapters.filter(item => item.chapter.archivedAt).length })) } };
  }
  private entries(): Entry[] {
    if (!existsSync(this.root)) return [];
    const entries: Entry[] = [];
    for (const folder of readdirSync(this.root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^(managed|before-delete|legacy-import-\d+)$/.test(folder.name)) continue;
      for (const file of readdirSync(join(this.root, folder.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        try { entries.push(this.read(`${folder.name}/${file.name}`)); }
        catch { /* Source snapshots, damaged and oversized files remain on disk; never auto-delete them. */ }
      }
    }
    return entries.sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt) || b.summary.id.localeCompare(a.summary.id));
  }
  private settingsFile(): string { return join(this.root, 'retention.json'); }
  private retentionDays(): number {
    if (!existsSync(this.settingsFile())) return 0;
    try { return validate.integer((JSON.parse(readFileSync(this.settingsFile(), 'utf8')) as { retentionDays: number }).retentionDays, '保留天数', 0, 3650); }
    catch { throw new AppError(500, 'BACKUP_SETTINGS', '备份保留设置无法读取，请重新保存设置。'); }
  }
  catalog(): BackupCatalog {
    const backups = this.entries().map(entry => entry.summary);
    return { backups, totalBytes: backups.reduce((sum, entry) => sum + entry.bytes, 0), retentionDays: this.retentionDays() };
  }
  settings(retentionDays: number): void {
    validate.integer(retentionDays, '保留天数', 0, 3650);
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.settingsFile()}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ retentionDays }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, this.settingsFile());
  }
  create(bookId?: string, reason: 'managed' | 'before-delete' = 'managed'): BackupSummary {
    const backup = this.store.backup(bookId);
    const text = JSON.stringify(backup);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new AppError(413, 'BACKUP_TOO_LARGE', '作品备份超过 64 MB，操作已停止。');
    const directory = join(this.root, reason);
    mkdirSync(directory, { recursive: true });
    // Check directory symlinks too; no managed write is allowed to escape the backup root.
    if (!realpathSync(directory).startsWith(realpathSync(this.root) + sep)) throw new AppError(400, 'BACKUP_PATH', '备份目录不正确。');
    const id = `${reason}/${Date.now()}-${randomUUID()}.json`;
    writeFileSync(join(this.root, id), text, { flag: 'wx', mode: 0o600 });
    return this.read(id).summary;
  }
  preview(id: string): BackupSummary { return this.read(id).summary; }
  download(id: string): WorkspaceBackup { return this.read(id).backup; }
  restore(id: string, expected: string) {
    const entry = this.read(id);
    if (entry.summary.fingerprint !== expected) throw new AppError(409, 'BACKUP_CHANGED', '备份内容已变化，请重新预览。');
    return this.store.restoreBackup(entry.backup);
  }
  cleanupPreview(): BackupCleanup {
    const entries = this.entries();
    const days = this.retentionDays();
    const cutoff = Date.now() - days * 86_400_000;
    const newest = new Map<string, string>();
    for (const entry of entries) for (const book of entry.backup.books) {
      const records = [book.book.id, ...book.chapters.flatMap(item => [item.chapter.id, ...item.revisions.map(revision => revision.id)])];
      for (const id of records) if (!newest.has(id)) newest.set(id, entry.summary.id);
    }
    const protectedIds = new Set(newest.values());
    if (entries[0]) protectedIds.add(entries[0].summary.id);
    const candidates = days === 0 ? [] : entries.filter(entry => Date.parse(entry.summary.createdAt) < cutoff && !protectedIds.has(entry.summary.id));
    const ids = candidates.map(entry => entry.summary.id);
    return { ids, bytes: candidates.reduce((sum, entry) => sum + entry.summary.bytes, 0), protectedCount: protectedIds.size,
      fingerprint: fingerprint(JSON.stringify({ days, candidates: candidates.map(entry => [entry.summary.id, entry.summary.fingerprint]) })) };
  }
  cleanup(expected: string): { deleted: number } {
    const preview = this.cleanupPreview();
    if (preview.fingerprint !== expected) throw new AppError(409, 'BACKUP_CHANGED', '清理列表已变化，请重新预览。');
    for (const id of preview.ids) unlinkSync(this.file(id));
    return { deleted: preview.ids.length };
  }
}
