import { useState, type FormEvent } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { Book, CreateBookInput } from '@shujian/contracts';
import { Dialog } from './Dialog';
import { errorMessage } from '../lib/api';

const accents = ['#31584d', '#b26747', '#5b6581', '#967442'];
interface Props { book?: Book; onClose: () => void; onSubmit: (input: CreateBookInput) => Promise<void> }

export function BookForm({ book, onClose, onSubmit }: Props) {
  const [title, setTitle] = useState(book?.title ?? '');
  const [genre, setGenre] = useState(book?.genre ?? '');
  const [premise, setPremise] = useState(book?.premise ?? '');
  const [targetWords, setTargetWords] = useState(book?.targetWords ?? 300000);
  const [accent, setAccent] = useState(book?.accent ?? accents[0] ?? '#31584d');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try { await onSubmit({ title: title.trim(), genre: genre.trim(), premise: premise.trim(), targetWords, accent }); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  return <Dialog title={book ? '作品设定' : '给新故事一个名字'} subtitle="设定可以慢慢完善。先写下此刻最想讲的那个故事。" onClose={onClose} busy={busy}>
    <form onSubmit={(event) => { void submit(event); }} className="book-form">
      <label>作品名称<span className="required-dot">*</span><input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：山海来信" disabled={busy} /></label>
      <div className="form-row">
        <label>题材<input maxLength={60} value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="例如：悬疑、都市、奇幻" disabled={busy} /></label>
        <label>目标字数<input type="number" min={0} max={100000000} step={1000} value={targetWords} onChange={(event) => setTargetWords(Number(event.target.value))} disabled={busy} /></label>
      </div>
      <label>故事的种子<span className="field-optional">选填</span><textarea rows={4} maxLength={20000} value={premise} onChange={(event) => setPremise(event.target.value)} placeholder="一个人，一次意外，或一个始终想知道答案的问题……" disabled={busy} /></label>
      <fieldset className="accent-picker" disabled={busy}><legend>封面色</legend>{accents.map((color) => <label key={color} className={`accent-swatch ${accent === color ? 'selected' : ''}`} style={{ '--swatch': color } as React.CSSProperties}><input type="radio" name="accent" value={color} checked={accent === color} onChange={() => setAccent(color)} aria-label={`封面色 ${color}`} /><span /></label>)}</fieldset>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="button quiet" onClick={onClose} disabled={busy}>稍后再说</button><button className="button primary" type="submit" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUpRight size={17} />}{book ? '保存设定' : '开始写作'}</button></div>
    </form>
  </Dialog>;
}
