import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, ManuscriptDocument } from '@shujian/contracts';
import { documentToText } from '@shujian/contracts';
import { ApiError, api, errorMessage } from '../lib/api';
import { clearRecovery, discardRecovery, loadRecoveries, storeRecovery, type RecoveryDraft } from '../lib/recovery';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
type EditableDraft = Pick<Chapter, 'title' | 'outline' | 'document'>;

export function useDraft(initial: Chapter, onSaved: (chapter: Chapter) => void) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<RecoveryDraft[]>([]);
  const [selectedRecovery, setSelectedRecovery] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState(false);
  const [ready, setReady] = useState(false);
  const current = useRef(initial);
  const version = useRef(initial.version);
  const sequence = useRef(0);
  const dirty = useRef(false);
  const composing = useRef(false);
  const blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pump = useRef<Promise<Chapter> | null>(null);
  const mounted = useRef(true);
  const sessionId = useRef<string | null>(null);
  if (!sessionId.current) sessionId.current = crypto.randomUUID();
  const recovery = recoveries.find((entry) => entry.sessionId === selectedRecovery) ?? recoveries[0] ?? null;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void loadRecoveries(initial.id).then((saved) => {
      if (!cancelled) setRecoveries(saved.filter((entry) => entry.title !== initial.title || entry.outline !== initial.outline || JSON.stringify(entry.document) !== JSON.stringify(initial.document)));
    }).catch(() => { if (!cancelled) setRecoveryWarning(true); }).finally(() => { if (!cancelled) setReady(true); });
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) { event.preventDefault(); }
    };
    window.addEventListener('beforeunload', warn);
    return () => { cancelled = true; mounted.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener('beforeunload', warn); };
  }, [initial.id]);

  const flush = useCallback((): Promise<Chapter> => {
    if (timer.current) clearTimeout(timer.current);
    if (pump.current) return pump.current;
    if (blocked.current) return Promise.reject(new Error('服务器中已有更新版本。本机稿已保留，请先处理版本冲突。'));
    if (composing.current) return Promise.reject(new Error('请完成当前输入后再切换。'));
    if (!dirty.current) return Promise.resolve(current.current);
    const execute = async () => {
      try {
        while (dirty.current) {
          if (composing.current) throw new Error('请完成当前输入后再切换，尚有内容等待保存。');
          const snapshot = current.current;
          const sentSequence = sequence.current;
          if (mounted.current) { setStatus('saving'); setError(null); }
          const { chapter } = await api.saveDraft(snapshot.id, { expectedVersion: version.current, title: snapshot.title, outline: snapshot.outline, document: snapshot.document });
          version.current = chapter.version;
          const unchanged = sequence.current === sentSequence;
          dirty.current = !unchanged;
          current.current = unchanged ? chapter : { ...current.current, version: chapter.version, updatedAt: chapter.updatedAt };
          if (mounted.current) { setDraft(current.current); setStatus(unchanged ? 'saved' : 'unsaved'); }
          onSavedRef.current(chapter);
          if (unchanged) {
            await clearRecovery(snapshot.id, sessionId.current!, sentSequence).catch(() => { if (mounted.current) setRecoveryWarning(true); });
          } else {
            void storeRecovery({ chapterId: snapshot.id, sessionId: sessionId.current!, revision: sequence.current, baseVersion: chapter.version, title: current.current.title, outline: current.current.outline, document: current.current.document, updatedAt: new Date().toISOString() }).catch(() => { if (mounted.current) setRecoveryWarning(true); });
          }
        }
        return current.current;
      } catch (failure) {
        const conflict = failure instanceof ApiError && failure.code === 'VERSION_CONFLICT';
        if (conflict) blocked.current = true;
        if (mounted.current) { setStatus(conflict ? 'conflict' : 'error'); setError(errorMessage(failure)); }
        throw failure;
      } finally { pump.current = null; }
    };
    pump.current = execute();
    return pump.current;
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!composing.current && !blocked.current) timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 850);
  }, [flush]);

  const update = useCallback((change: Partial<EditableDraft>) => {
    sequence.current += 1;
    dirty.current = true;
    current.current = { ...current.current, ...change };
    setDraft(current.current);
    setStatus(blocked.current ? 'conflict' : 'unsaved');
    void storeRecovery({ chapterId: initial.id, sessionId: sessionId.current!, revision: sequence.current, baseVersion: version.current, title: current.current.title, outline: current.current.outline, document: current.current.document, updatedAt: new Date().toISOString() }).catch(() => { if (mounted.current) setRecoveryWarning(true); });
    schedule();
  }, [initial.id, schedule]);

  const setComposing = useCallback((active: boolean) => {
    composing.current = active;
    if (active && timer.current) clearTimeout(timer.current);
    if (!active && dirty.current) schedule();
  }, [schedule]);

  const replace = useCallback((next: Chapter) => {
    current.current = next;
    version.current = next.version;
    dirty.current = false;
    blocked.current = false;
    sequence.current += 1;
    setDraft(next);
    setStatus('saved');
    setError(null);
    void clearRecovery(next.id, sessionId.current!, sequence.current).catch(() => { if (mounted.current) setRecoveryWarning(true); });
    onSavedRef.current(next);
  }, []);

  const recover = useCallback(async () => {
    if (!recovery || recoveryBusy) return;
    setRecoveryBusy(true); setError(null);
    try {
      await flush();
      if (recovery.baseVersion !== version.current) throw new Error('保存版本已变化，请先导出这份副本，避免覆盖新稿。');
      // Keep the original session's copy until a durable copy belongs to this session.
      await storeRecovery({ ...recovery, sessionId: sessionId.current!, legacy: false, revision: sequence.current + 1, updatedAt: new Date().toISOString() });
      if (!mounted.current) return;
      update({ title: recovery.title, outline: recovery.outline, document: recovery.document });
      const removed = await discardRecovery(recovery);
      if (mounted.current) {
        if (removed) setRecoveries((old) => old.filter((entry) => entry.sessionId !== recovery.sessionId));
        else { setRecoveries((await loadRecoveries(initial.id)).filter((entry) => entry.sessionId !== sessionId.current)); setError('原页签又更新了这份副本，更新后的内容仍保留，请重新查看。'); }
      }
    } catch (failure) { if (mounted.current) { setError(errorMessage(failure)); setRecoveryWarning(true); } }
    finally { if (mounted.current) setRecoveryBusy(false); }
  }, [recovery, recoveryBusy, flush, update, initial.id]);

  const dismissRecovery = useCallback(async () => {
    if (!recovery || recoveryBusy) return;
    setRecoveryBusy(true); setError(null);
    try {
      if (await discardRecovery(recovery)) setRecoveries((old) => old.filter((entry) => entry.sessionId !== recovery.sessionId));
      else { setRecoveries((await loadRecoveries(initial.id)).filter((entry) => entry.sessionId !== sessionId.current)); setError('副本已被原页签更新，未删除新内容，请重新查看。'); }
    } catch (failure) { setError(errorMessage(failure)); setRecoveryWarning(true); }
    finally { if (mounted.current) setRecoveryBusy(false); }
  }, [initial.id, recovery, recoveryBusy]);

  const text = documentToText(draft.document);
  return { draft, status, error, recovery, recoveries, recoveryBusy, selectRecovery: setSelectedRecovery, recoveryWarning, ready, update, flush, replace, recover, dismissRecovery, setComposing, text, getVersion: () => version.current, dirty: () => dirty.current, document: draft.document as ManuscriptDocument };
}
