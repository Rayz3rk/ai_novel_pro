import { useRef, useState, type ChangeEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, BookOpen, ChevronRight, LoaderCircle, Plus, Search, Settings2, Sparkle } from 'lucide-react';
import type { Book, WorkspaceBackup } from '@shujian/contracts';
import { api, downloadUrl, errorMessage } from '../lib/api';
import { BookForm } from './BookForm';
import { Dialog } from './Dialog';
import { ModelSettings } from './ModelSettings';
import { StorageSettings } from './StorageSettings';

interface Props { books: Book[]; loading: boolean; error: string | null; onRefresh: () => Promise<void>; onOpen: (book: Book) => Promise<void> }
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

export function Library({ books, loading, error, onRefresh, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const [modelSettings, setModelSettings] = useState(false);
  const [storageSettings, setStorageSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Book | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<WorkspaceBackup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const filtered = books.filter((book) => [book.title, book.genre, book.premise].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totalWords = books.reduce((sum, book) => sum + book.wordCount, 0);
  const totalChapters = books.reduce((sum, book) => sum + book.chapterCount, 0);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setActionError(null); setNotice(null);
    try { await action(); } catch (failure) { setActionError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const importFile = (event: ChangeEvent<HTMLInputElement>, backup: boolean) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run(async () => {
      const maximumMb = backup ? 64 : 20;
      if (file.size > maximumMb * 1024 * 1024) throw new Error(`文件过大。请选择 ${maximumMb} MB 以内的${backup ? '备份' : '手稿'}文件。`);
      const text = await file.text();
      if (backup) {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'shujian-backup' || !('books' in parsed) || !Array.isArray(parsed.books)) throw new Error('这不是有效的书间备份文件。');
        setRestoring(parsed as WorkspaceBackup);
      } else {
        const result = await api.importText(file.name, text);
        await onRefresh(); await onOpen(result.book);
      }
    });
  };

  return <div className="library-page">
    <header className="library-header">
      <a className="wordmark" href="#" onClick={(event) => { event.preventDefault(); setQuery(''); }} aria-label="书间书架"><span className="brand-seal">间</span><span>书间</span><span className="brand-en">SHUJIAN</span></a>
      <div className="library-header-right"><button className="text-button" onClick={() => setStorageSettings(true)}>数据库</button><button className="text-button" aria-label="模型连接设置" onClick={() => setModelSettings(true)}><Settings2 size={16} />模型连接</button><span className="local-badge"><span />本地创作空间</span><span className="header-divider" /><button className="text-button" onClick={() => { void run(() => downloadUrl('/api/backup', `书间备份-${new Date().toISOString().slice(0, 10)}.json`)); }} disabled={busy}><ArrowDownToLine size={16} />备份作品</button><button className="text-button" onClick={() => backupRef.current?.click()} disabled={busy}><ArrowUpFromLine size={16} />恢复备份</button></div>
    </header>
    <main className="library-main">
      <section className="library-intro">
        <div><span className="eyebrow"><span className="little-line" /> YOUR WRITING ROOM</span><h1>让故事，<br /><em>慢慢成形。</em></h1><p>留一处安静的地方，给那些还没讲完的故事。</p></div>
        <div className="intro-aside"><span className="intro-ornament">叙</span><p>每一页，<br />都算新的开始。</p><span>ONE PAGE AT A TIME</span></div>
      </section>
      <section className="shelf-section" aria-labelledby="shelf-title">
        <div className="shelf-heading"><div><h2 id="shelf-title">我的作品<span>{books.length.toString().padStart(2, '0')}</span></h2><p>{books.length ? `${number(totalChapters)} 章故事，${number(totalWords)} 字积累` : '故事还未落笔，世界已经在等你。'}</p></div><div className="shelf-actions"><button className="button secondary" onClick={() => importRef.current?.click()} disabled={busy}><ArrowUpFromLine size={16} />导入旧稿</button><button className="button primary" onClick={() => setCreating(true)} disabled={busy}><Plus size={18} />新建作品</button></div></div>
        <div className="shelf-filter"><label className="search-field"><Search size={17} /><input aria-label="搜索作品" placeholder="寻找一本故事……" value={query} onChange={(event) => setQuery(event.target.value)} /><span>{books.length} 本</span></label><span className="sort-label">按最近修改排列</span></div>
        {(actionError || error) && <div className="notice error" role="alert">{actionError ?? error}<button type="button" className="text-button" onClick={() => { void onRefresh(); }}>重新连接</button></div>}
        {notice && <div className="notice success" role="status">{notice}</div>}
        {busy && <div className="busy-line" role="status"><LoaderCircle size={16} className="spin" />正在整理你的作品，请稍候……</div>}
        {loading ? <div className="library-loading" role="status"><LoaderCircle className="spin" size={24} /><p>正在打开书架……</p></div> : books.length === 0 && !error ? <div className="empty-shelf">
          <div className="empty-book" aria-hidden="true"><div className="empty-book-lines" /><BookOpen size={38} strokeWidth={1} /><span>你的第一部作品</span></div><div className="empty-copy"><span className="eyebrow">一切故事，都始于落笔</span><h3>这里，等着你的第一本书。</h3><p>给它一个名字。关于人物、远方和结局，<br />我们留到写作中慢慢寻找。</p><button className="button primary" onClick={() => setCreating(true)}>写下第一个故事<ArrowUpRight size={17} /></button><button className="text-button empty-import" onClick={() => importRef.current?.click()}>已经有了手稿？从这里导入<ChevronRight size={15} /></button></div>
        </div> : filtered.length === 0 && !error ? <div className="no-results"><Search size={27} strokeWidth={1} /><h3>没有找到这本故事</h3><p>换个名字或题材试试。</p><button className="text-button" onClick={() => setQuery('')}>查看全部作品</button></div> : <div className="books-grid">{filtered.map((book, index) => <article className="book-card" key={book.id}>
          <button className="book-cover" style={{ '--cover': book.accent } as React.CSSProperties} onClick={() => { void run(() => onOpen(book)); }} aria-label={`继续写作：${book.title}`} disabled={busy}><div className="cover-spine" /><div className="cover-inner"><span className="cover-series">书间文库 · {String(index + 1).padStart(2, '0')}</span><h3>{book.title}</h3><span className="cover-rule" /><span className="cover-genre">{book.genre || '未分类故事'}</span><span className="cover-stamp">叙事有间</span></div><span className="cover-open">继续写作<ArrowUpRight size={16} /></span></button>
          <div className="book-card-title"><h3><button onClick={() => { void run(() => onOpen(book)); }} disabled={busy}>{book.title}</button></h3><button type="button" className="icon-button" onClick={() => setEditing(book)} aria-label={`编辑作品设定：${book.title}`}><Settings2 size={16} /></button></div><p className="book-meta">{book.chapterCount} 章<span>·</span>{number(book.wordCount)} 字</p><div className="book-progress" role="meter" aria-label={`${book.title}写作进度`} aria-valuemin={0} aria-valuemax={book.targetWords} aria-valuenow={Math.min(book.wordCount, book.targetWords)}><span style={{ width: `${Math.min(100, book.wordCount / Math.max(book.targetWords, 1) * 100)}%`, background: book.accent }} /></div><div className="book-card-foot"><span>{date(book.updatedAt)}修改</span><span>目标 {number(book.targetWords)} 字</span></div>
        </article>)}<button className="new-book-card" onClick={() => setCreating(true)}><span className="new-book-plus"><Plus size={27} strokeWidth={1} /></span><span>下一个故事</span><small>让新的世界发生</small></button></div>}
      </section>
      <footer className="library-footer"><span><Sparkle size={13} strokeWidth={1.3} />故事由你决定，每一稿都值得留下。</span><span>书间 · 作者掌舵，AI 协作</span></footer>
    </main>
    <input ref={importRef} className="sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(event) => importFile(event, false)} aria-label="选择导入手稿" />
    <input ref={backupRef} className="sr-only" type="file" accept=".json,application/json" onChange={(event) => importFile(event, true)} aria-label="选择备份文件" />
    {modelSettings && <ModelSettings onClose={() => setModelSettings(false)} />}
    {storageSettings && <StorageSettings onClose={() => setStorageSettings(false)} />}
    {creating && <BookForm onClose={() => setCreating(false)} onSubmit={async (input) => { const { book } = await api.createBook(input); setCreating(false); await onRefresh(); await onOpen(book); }} />}
    {editing && <BookForm book={editing} onClose={() => setEditing(null)} onSubmit={async (input) => { await api.updateBook(editing.id, input); setEditing(null); await onRefresh(); }} />}
    {restoring && <Dialog title="恢复作品备份" subtitle="备份中的作品将作为新作品加入书架，现有作品不会被覆盖。" onClose={() => setRestoring(null)} busy={busy}><div className="restore-summary"><BookOpen size={27} strokeWidth={1.4} /><p>备份包含 <strong>{restoring.books.length}</strong> 部作品</p><small>备份时间：{new Date(restoring.exportedAt).toLocaleString('zh-CN')}</small></div><div className="dialog-footer"><button className="button quiet" disabled={busy} onClick={() => setRestoring(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => { void run(async () => { const result = await api.restoreBackup(restoring); setRestoring(null); await onRefresh(); setNotice(`已恢复 ${result.books.length} 部作品，原作品保持不变。`); }); }}>{busy && <LoaderCircle className="spin" size={16} />}确认恢复</button></div></Dialog>}
  </div>;
}
