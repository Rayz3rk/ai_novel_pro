import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock3, History, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react';
import type { DocumentRevision, RevisionSummary } from '@shujian/contracts';
import { api, errorMessage } from '../lib/api';

interface Props { chapterId: string; onClose: () => void; onCheckpoint: (label: string) => Promise<void>; onRestore: (revision: DocumentRevision) => Promise<void> }
const kindLabels = { checkpoint: '手动留稿', final: '定稿', before_restore: '恢复前留稿' };

export function VersionDrawer({ chapterId, onClose, onCheckpoint, onRestore }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<RevisionSummary[]>([]);
  const [preview, setPreview] = useState<DocumentRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const load = async () => {
    setLoading(true);
    try { const result = await api.versions(chapterId); setVersions(result.versions); } catch (failure) { setError(errorMessage(failure)); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [chapterId]);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } };
  return <dialog ref={dialog} className="version-dialog" aria-label="章节版本历史" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><aside className="version-drawer">
    <div className="drawer-head"><div><span className="eyebrow">每一稿，都有来处</span><h2><History size={20} />版本历史</h2></div><button className="icon-button" aria-label="关闭版本历史" onClick={onClose} disabled={busy}><X size={19} /></button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {preview ? <div className="version-preview"><button className="text-button" onClick={() => { setPreview(null); setConfirming(false); }} disabled={busy}><ArrowLeft size={16} />全部版本</button><span className="version-kind">{kindLabels[preview.kind]}</span><h3>{preview.title}</h3><p className="muted">{preview.label} · {new Date(preview.createdAt).toLocaleString('zh-CN')} · {preview.wordCount} 字</p><div className="preview-prose">{preview.plainText || '（这一稿尚无正文）'}</div><div className="restore-actions">{confirming ? <><p>恢复后会先保存当前稿，再将此版本载入编辑器。所有历史都会保留。</p><button className="button primary" disabled={busy} onClick={() => { void run(async () => { await onRestore(preview); onClose(); }); }}>{busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}确认恢复这一稿</button><button className="button quiet" disabled={busy} onClick={() => setConfirming(false)}>暂不恢复</button></> : <button className="button secondary" disabled={busy} onClick={() => setConfirming(true)}><RotateCcw size={16} />恢复到编辑器</button>}</div></div> : <>
      <form className="checkpoint-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await onCheckpoint(label.trim()); setLabel(''); await load(); }); }}><label htmlFor="checkpoint-label">给此刻的稿件留个记号</label><div><input id="checkpoint-label" maxLength={100} placeholder="例如：调整了开场对白" value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} /><button className="icon-button" type="submit" aria-label="保存当前版本" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={20} />}</button></div><small>自动保存负责不丢稿，手动留稿记录重要的创作节点。</small></form>
      {loading ? <div className="drawer-empty"><LoaderCircle className="spin" size={22} /><p>正在读取版本……</p></div> : versions.length === 0 ? <div className="drawer-empty"><Clock3 size={30} strokeWidth={1} /><h3>第一稿，正在发生</h3><p>留存一个版本，或完成定稿后，<br />就能在这里回看故事的变化。</p></div> : <ol className="version-list">{versions.map((version) => <li key={version.id}><button disabled={busy} onClick={() => { void run(async () => { const result = await api.version(chapterId, version.id); setPreview(result.version); }); }}><span className="version-dot" /><div><span className="version-kind">{kindLabels[version.kind]}</span><h3>{version.label}</h3><p>{new Date(version.createdAt).toLocaleString('zh-CN')}<span>{version.wordCount} 字</span></p></div></button></li>)}</ol>}
    </>}
  </aside></dialog>;
}
