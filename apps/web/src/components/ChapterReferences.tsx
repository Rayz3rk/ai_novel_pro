import { useEffect, useState } from 'react';
import type { Chapter, ChapterReference } from '@shujian/contracts';
import { api, errorMessage } from '../lib/api';
import { Dialog } from './Dialog';

export function ChapterReferences({ chapter, onClose, onArchive, onNavigate }: { chapter: Chapter; onClose: () => void; onArchive: (archived: boolean) => Promise<void>; onNavigate: (id: string) => Promise<void> }) {
  const [references, setReferences] = useState<ChapterReference[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { let live = true; setLoading(true); void api.references(chapter.id).then(result => { if (live) { setReferences(result.references); setError(null); } }).catch(failure => { if (live) setError(errorMessage(failure)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [chapter.id, reload]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } };
  return <Dialog title="章节引用与归档" subtitle={chapter.title} onClose={onClose} busy={busy} wide><div className="maintenance-body">
    <p>归档会从写作目录中收起本章，保留正文、全部版本和原文出处。取消归档后可继续写作。</p>
    {error && <p className="notice error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></p>}
    {loading ? <p role="status">正在检查引用…</p> : <><h3>{references.length} 处引用</h3>{references.length === 0 && <p>未发现阻止删除的外部引用。</p>}<ul className="reference-list">{references.map((reference, index) => <li key={`${reference.id}-${index}`}><strong>{reference.title}</strong><small>{reference.module} · {reference.historical ? '历史记录' : '当前记录'}</small><code>{reference.path}</code>{reference.chapterId && <button className="text-button" disabled={busy} onClick={() => void run(() => onNavigate(reference.chapterId!))}>打开引用章节</button>}</li>)}</ul></>}
    <div className="dialog-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy || loading} onClick={() => void run(() => onArchive(!chapter.archivedAt))}>{chapter.archivedAt ? '取消归档，继续写作' : '归档本章，保留引用'}</button></div>
  </div></Dialog>;
}
