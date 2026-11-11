import { useEffect, useState } from 'react';
import type { BackupCatalog, BackupSummary, BackupCleanup } from '@shujian/contracts';
import { api, downloadUrl, errorMessage } from '../lib/api';
import { Dialog } from './Dialog';

const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function BackupDesk({ onClose, onRestored }: { onClose: () => void; onRestored: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<BackupCatalog | null>(null);
  const [preview, setPreview] = useState<BackupSummary | null>(null);
  const [cleanup, setCleanup] = useState<BackupCleanup | null>(null);
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = async () => { const result = await api.backups(); setCatalog(result); setDays(result.retentionDays); };
  useEffect(() => { let live = true; void api.backups().then(result => { if (live) { setCatalog(result); setDays(result.retentionDays); } }).catch(failure => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); setNotice(''); try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } };
  return <Dialog title="备份管理" subtitle="预览作品后再恢复；恢复会新增作品。保留设置仅用于生成清理建议，清理前需要你确认。" onClose={onClose} busy={busy} wide>
    <div className="maintenance-body">
      {error && <p role="alert" className="notice error">{error}<button className="text-button" disabled={busy} onClick={() => void run(refresh)}>重新读取</button></p>}
      {notice && <p role="status" className="notice success">{notice}</p>}
      <div className="maintenance-summary"><span>{catalog ? `${catalog.backups.length} 份可恢复备份 · ${size(catalog.totalBytes)}` : '正在读取备份…'}</span><button className="button primary compact" disabled={busy} onClick={() => void run(async () => { await api.createBackup(); await refresh(); setNotice('已创建当前作品库备份。'); })}>立即备份</button></div>
      <div className="backup-settings"><label>保留天数（0 为永久保留）<input aria-label="备份保留天数" type="number" min="0" max="3650" value={days} disabled={busy} onChange={event => { setDays(Number(event.target.value)); setCleanup(null); }} /></label><button className="button secondary compact" disabled={busy || !Number.isInteger(days) || days < 0 || days > 3650} onClick={() => void run(async () => { await api.backupSettings(days); setCleanup(null); await refresh(); setNotice('保留设置已保存。'); })}>保存保留设置</button><button className="text-button" disabled={busy || !catalog || days !== catalog.retentionDays} onClick={() => void run(async () => { setPreview(null); setCleanup(await api.cleanupPreview()); })}>预览过期备份清理</button></div>
      {cleanup && <section className="maintenance-preview" aria-label="清理预览"><h3>清理预览</h3><p>可清理 {cleanup.ids.length} 份，共 {size(cleanup.bytes)}。每部作品最新备份及唯一副本均会保留。</p>{cleanup.ids.length > 0 && <ul>{cleanup.ids.map(id => <li key={id}>{id}</li>)}</ul>}<button className="button danger compact" disabled={busy || cleanup.ids.length === 0} onClick={() => void run(async () => { const result = await api.cleanupBackups(cleanup.fingerprint); setCleanup(null); await refresh(); setNotice(`已清理 ${result.deleted} 份过期备份。`); })}>确认清理以上备份</button></section>}
      {preview && <section className="maintenance-preview" aria-label="恢复预览"><h3>恢复预览</h3><p>{new Date(preview.createdAt).toLocaleString('zh-CN')} · {size(preview.bytes)}</p><ul>{preview.books.map((book, index) => <li key={index}>{book.title} · {book.chapters} 章（归档 {book.archived} 章）· {book.words.toLocaleString()} 字</li>)}</ul><p>将以上作品作为新作品加入书架。</p><button className="button primary compact" disabled={busy} onClick={() => void run(async () => { const result = await api.restoreLocalBackup(preview.id, preview.fingerprint); setPreview(null); await onRestored(); setNotice(`已恢复 ${result.books.length} 部作品。`); })}>确认恢复为新作品</button></section>}
      <ul className="backup-list">{catalog?.backups.map(backup => <li key={backup.id}><div><strong>{backup.books.map(book => book.title).join('、') || '空作品库'}</strong><p>{new Date(backup.createdAt).toLocaleString('zh-CN')} · {size(backup.bytes)}</p><small>{backup.books.length} 部作品 · {backup.books.reduce((sum, book) => sum + book.chapters, 0)} 章</small></div><div className="inline-actions"><button className="button secondary compact" disabled={busy} onClick={() => void run(async () => { setCleanup(null); setPreview((await api.backupPreview(backup.id)).backup); })}>预览恢复</button><button className="text-button" disabled={busy} onClick={() => void run(() => downloadUrl(`/api/backups/download?id=${encodeURIComponent(backup.id)}`, '书间备份.json'))}>下载</button></div></li>)}</ul>
      {catalog?.backups.length === 0 && <p>还没有本地备份，点击“立即备份”开始。源快照和无法识别的文件会留在磁盘上，不参与清理。</p>}
    </div>
  </Dialog>;
}
