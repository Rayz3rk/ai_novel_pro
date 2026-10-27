import { randomUUID } from 'node:crypto';
import {
  documentToText, type AiJob, type Chapter, type ChapterReview, type ContextItem,
  type CreateAiJobInput, type DocumentNode, type DocumentRevision, type ReviewIssue,
  type SaveStoryEntryInput, type StoryEntry, type StoryEvidence, type StoryImpact,
  type StoryProposal, type StorySearchResult, type StorySourceHit,
} from '@shujian/contracts';
import { AppError, notFound } from '../errors.js';
import type { Store } from '../store.js';
import * as v from '../validation.js';
import { migrateStory } from './schema.js';
import { evidenceHash, list, names, oneOf, parseModelJson, storyInput } from './validation.js';

export interface StoryEvent {
  id: string; bookId: string; entryId: string; action: 'confirm' | 'update' | 'withdraw' | 'source_changed';
  version: number; entry: StoryEntry; createdAt: string;
}
interface Dependency { jobId: string; bookId: string; chapterId: string; entryIds: string[]; revisionIds: string[] }
export interface StoryBackup {
  version: 1; entries: StoryEntry[]; events: StoryEvent[]; proposals: StoryProposal[];
  reviews: ChapterReview[]; dependencies: Dependency[];
}
interface JsonRow { payload: string }
interface SearchOptions { q?: string; kind?: string; chapterPosition?: number; pov?: string; includeWithdrawn?: boolean }
const now = () => new Date().toISOString();
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export function paragraphs(document: { content: DocumentNode[] }): Array<{ paragraphId: string; text: string; hash: string }> {
  const found: Array<{ paragraphId: string; text: string; hash: string }> = [];
  const walk = (node: DocumentNode) => {
    const uid = node.attrs?.uid;
    if (typeof uid === 'string' && ['paragraph', 'heading', 'codeBlock'].includes(node.type)) {
      const text = documentToText({ type: 'doc', content: [node] });
      found.push({ paragraphId: uid, text, hash: evidenceHash(text) });
    }
    for (const child of node.content ?? []) walk(child);
  };
  document.content.forEach(walk);
  return found;
}

export class StoryService {
  constructor(readonly store: Store) { migrateStory(store.db); }
  beforeEntryChange?: (entry:StoryEntry,previous?:StoryEntry)=>void;
  checkEvidence(bookId:string,sources:StoryEvidence[],current=true):void { this.assertSources(bookId,sources,current); }
  private rows<T>(sql: string, ...params: string[]): T[] {
    return (this.store.db.prepare(sql).all(...params) as JsonRow[]).map((row) => JSON.parse(row.payload) as T);
  }
  private rawEntries(bookId: string): StoryEntry[] {
    return this.rows<StoryEntry>('SELECT payload FROM story_entries WHERE book_id=? ORDER BY updated_at DESC,rowid DESC', bookId);
  }
  private sourceStale(evidence: StoryEvidence[]): boolean {
    return evidence.some((source) => {
      try { return this.store.getChapter(source.chapterId).finalizedRevisionId !== source.revisionId; }
      catch { return true; }
    });
  }
  private current(entry: StoryEntry): StoryEntry {
    return { ...entry, needsReview: entry.needsReview || this.sourceStale(entry.evidence) };
  }
  getEntry(id: string): StoryEntry {
    const row = this.store.db.prepare('SELECT payload FROM story_entries WHERE id=?').get(id) as JsonRow | undefined;
    return row ? this.current(JSON.parse(row.payload) as StoryEntry) : notFound('故事资料');
  }
  private assertSources(bookId: string, sources: StoryEvidence[], requireCurrent = true, allowCandidate = false): void {
    for (const source of sources) {
      const chapter = this.store.getChapter(source.chapterId);
      if (chapter.bookId !== bookId) v.invalid('证据必须来自同一部作品。');
      const revision = this.store.getRevision(source.chapterId, source.revisionId);
      if (revision.kind !== 'final' && !allowCandidate) v.invalid('事实证据必须来自作者已定稿的版本。');
      if (requireCurrent && chapter.finalizedRevisionId !== revision.id) throw new AppError(409, 'STALE_EVIDENCE', '原文已经重新定稿，请核对新版本后再确认资料。');
      const paragraph = paragraphs(revision.document).find((item) => item.paragraphId === source.paragraphId);
      if (!paragraph || !paragraph.text.includes(source.quote) || evidenceHash(source.quote) !== source.hash) v.invalid('证据段落、摘录或 hash 与原文不一致。');
    }
  }
  private putEntry(entry: StoryEntry): void {
    this.store.db.prepare('INSERT INTO story_entries(id,book_id,payload,status,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status=excluded.status,updated_at=excluded.updated_at')
      .run(entry.id, entry.bookId, JSON.stringify(entry), entry.status, entry.updatedAt);
  }
  private event(entry: StoryEntry, action: StoryEvent['action']): void {
    const event: StoryEvent = { id: randomUUID(), bookId: entry.bookId, entryId: entry.id, action, version: entry.version, entry, createdAt: now() };
    this.store.db.prepare('INSERT INTO story_events(id,book_id,entry_id,payload,created_at) VALUES(?,?,?,?,?)')
      .run(event.id, event.bookId, event.entryId, JSON.stringify(event), event.createdAt);
  }
  saveEntry(bookId: string, value: unknown, id?: string): StoryEntry {
    const input = storyInput(value);
    return this.store.db.transaction(() => {
      this.store.getBook(bookId);
      const previous = id ? this.getEntry(id) : undefined;
      if (previous && previous.bookId !== bookId) v.invalid('资料不属于这部作品。');
      if (previous && previous.version !== input.expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '故事资料已更新，请重新读取后修改。', previous.version);
      this.assertSources(bookId, input.evidence ?? []);
      const time = now();
      const entry: StoryEntry = {
        id: previous?.id ?? randomUUID(), bookId, kind: input.kind, authority: input.authority,
        title: input.title, content: input.content, aliases: input.aliases ?? [], visibility: input.visibility ?? 'public',
        knownBy: input.knownBy ?? [], storyTime: input.storyTime ?? '', narrative: input.narrative ?? 'unknown',
        validFromChapter: input.validFromChapter ?? 1, plannedPayoff: input.plannedPayoff ?? null,
        evidence: input.evidence ?? [], status: input.status ?? (previous?.status==='idea'?'idea':'confirmed'), needsReview: false,
        ...(input.attributes===undefined?(previous?.attributes?{attributes:previous.attributes}:{}):{attributes:input.attributes}),
        ...(input.links===undefined?(previous?.links?{links:previous.links}:{}):{links:input.links}),
        ...(input.branch===undefined?(previous?.branch?{branch:previous.branch}:{}):{branch:input.branch}),
        version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? time, updatedAt: time,
      };
      this.beforeEntryChange?.(entry,previous);
      this.putEntry(entry); this.event(entry, entry.status==='withdrawn'?'withdraw':entry.status==='confirmed'&&previous?.status!=='confirmed'?'confirm':'update');
      return entry;
    })();
  }
  withdrawEntry(id: string, expectedVersion: number): StoryEntry {
    return this.store.db.transaction(() => {
      const entry = this.getEntry(id);
      if (entry.version !== expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '故事资料已更新，请重新读取后撤回。', entry.version);
      if (entry.status === 'withdrawn') return entry;
      const next: StoryEntry = { ...entry, status: 'withdrawn', version: entry.version + 1, updatedAt: now() };
      this.beforeEntryChange?.(next,entry);
      this.putEntry(next); this.event(next, 'withdraw'); return next;
    })();
  }
  history(id: string): StoryEvent[] {
    this.getEntry(id);
    return this.rows<StoryEvent>('SELECT payload FROM story_events WHERE entry_id=? ORDER BY created_at,rowid', id);
  }
  search(bookId: string, options: SearchOptions = {}): StorySearchResult {
    this.store.getBook(bookId);
    const query = normalize(options.q ?? '');
    const terms = query.split(/[\s，。！？、,.;!?]+/u).filter(Boolean);
    const allEntries = this.rawEntries(bookId).map((entry) => this.current(entry));
    const matches = allEntries
      .filter((entry) => options.includeWithdrawn || entry.status === 'confirmed')
      .filter((entry) => !options.kind || entry.kind === options.kind)
      .filter((entry) => options.chapterPosition === undefined || this.visibleAt(entry, options.chapterPosition, options.pov, false));
    const score = (entry: StoryEntry): number => {
      if (!query) return 1;
      const title = normalize([entry.title, ...entry.aliases].join(' '));
      const content = normalize(entry.content);
      return terms.reduce((sum, term) => sum + (title.includes(term) ? 12 : 0) + (content.includes(term) ? 2 : 0), 0)
        + ([entry.title,...entry.aliases].some((name)=>query.includes(normalize(name)))?12:0)
        + (entry.evidence.some((source)=>normalize(source.quote).includes(query))?3:0);
    };
    const entries = matches.map((entry) => ({ entry, score: score(entry) })).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score).map((item) => item.entry);
    const finalized = this.store.listChapters(bookId).filter((chapter) => chapter.finalizedRevisionId !== null);
    const covered = new Set(allEntries.filter((entry) => entry.status === 'confirmed' && !entry.needsReview)
      .flatMap((entry) => entry.evidence.map((source) => source.chapterId)));
    return { entries, coverage: { finalizedChapters: finalized.length, withEvidence: finalized.filter((chapter) => covered.has(chapter.id)).length,
      pendingProposals: this.listProposals(bookId).filter((proposal) => proposal.state === 'pending' && !proposal.stale).length } };
  }
  private visibleAt(entry: StoryEntry, position: number, pov: string | undefined, planning: boolean): boolean {
    if (planning) return true;
    if (entry.validFromChapter > position || entry.visibility === 'author') return false;
    if (entry.visibility === 'characters' && (!pov || !entry.knownBy.some((name) => normalize(name) === normalize(pov)))) return false;
    if (entry.authority === 'fact' && entry.evidence.some((source) => this.store.getChapter(source.chapterId).position > position)) return false;
    return true;
  }
  getContext(input: CreateAiJobInput, chapter: Chapter,transform?:(entry:StoryEntry)=>StoryEntry,allowedIds?:Set<string>): ContextItem[] {
    const planning = ['plan','discuss','review','extract'].includes(input.kind);
    const excluded = new Set(input.excludedEntryIds ?? []);
    const pinned = new Set(input.pinnedEntryIds ?? []);
    const terms = normalize(`${chapter.outline} ${input.instruction} ${input.pov ?? ''}`);
    const rows = this.rawEntries(chapter.bookId).map((entry) => this.current(entry)).map(entry=>transform?.(entry)??entry)
      .filter(entry=>!allowedIds||allowedIds.has(entry.id))
      .filter((entry) => entry.status === 'confirmed' && !entry.needsReview && !excluded.has(entry.id))
      .filter((entry) => this.visibleAt(entry, chapter.position, input.pov, planning));
    const rank = (entry: StoryEntry) => (pinned.has(entry.id) ? 1_000 : 0) + (entry.authority === 'setting' ? 20 : 0)
      + ([entry.title, ...entry.aliases].some((name) => terms.includes(normalize(name))) ? 50 : 0)
      + (entry.kind === 'foreshadow' && (entry.plannedPayoff === null || entry.plannedPayoff >= chapter.position) ? 5 : 0);
    const context:ContextItem[]=rows.sort((a, b) => rank(b) - rank(a)).map((entry) => ({
      id: `story:${entry.id}:v${entry.version}`, label: `${entry.authority === 'fact' ? '已确认正文事实' : entry.authority === 'plan' ? '未来计划，尚未发生' : '作者确认设定'} · ${entry.title}${allowedIds?'（卡片ID：'+entry.id+'）':''}`,
      source: 'canon' as const, text: `${entry.content}${entry.attributes ? '\n结构属性：'+JSON.stringify(Object.fromEntries(Object.entries(entry.attributes).filter(([key])=>planning||key!=='secret'))) : ''}\n故事时间：${entry.storyTime || '未知'}；叙述：${entry.narrative}；知情范围：${entry.visibility}${entry.knownBy.length ? `（${entry.knownBy.join('、')}）` : ''}${entry.evidence.length ? `\n依据：${entry.evidence.map((source) => `第${this.store.getChapter(source.chapterId).position}章 / ${source.revisionId} / ${source.paragraphId}：「${source.quote}」`).join('\n')}` : ''}`,
      entryId: entry.id, ...(entry.evidence[0] ? { chapterId: entry.evidence[0].chapterId, revisionId: entry.evidence[0].revisionId } : {}), required: pinned.has(entry.id)||!!allowedIds?.has(entry.id),
    }));
    const allEntries=this.rawEntries(chapter.bookId).map((entry)=>this.current(entry));
    const blocked=allEntries.filter((entry)=>entry.status==='confirmed'&&!this.visibleAt(entry,chapter.position,input.pov,planning));
    const previous=this.store.listChapters(chapter.bookId).filter((entry)=>entry.position<chapter.position&&entry.finalizedRevisionId);
    const latest=new Set(previous.slice(-2).map((entry)=>entry.id));
    const names=[...new Set(rows.flatMap((entry)=>[entry.title,...entry.aliases]).filter((name)=>terms.includes(normalize(name))))];
    for(const source of previous.slice().reverse()){
      const revision=this.store.getRevision(source.id,source.finalizedRevisionId!);
      for(const paragraph of paragraphs(revision.document)){
        if(blocked.some((entry)=>entry.evidence.some((evidence)=>evidence.revisionId===revision.id&&evidence.paragraphId===paragraph.paragraphId)))continue;
        if(!latest.has(source.id)&&!names.some((name)=>normalize(paragraph.text).includes(normalize(name))))continue;
        context.push({id:`paragraph:${revision.id}:${paragraph.paragraphId}`,label:`已定稿${latest.has(source.id)?'衔接':'相关历史'}原文 · 第${source.position}章 · ${source.title}（读者已见，不等于视角人物知情）`,source:'history',text:paragraph.text,chapterId:source.id,revisionId:revision.id,required:false});
      }
    }
    return context;
  }
  searchSources(bookId:string,query:string):StorySourceHit[] {
    this.store.getBook(bookId);const term=normalize(query);if(!term)return[];
    const hits:StorySourceHit[]=[];
    for(const chapter of this.store.listChapters(bookId)){
      if(!chapter.finalizedRevisionId)continue;
      const revision=this.store.getRevision(chapter.id,chapter.finalizedRevisionId);
      for(const paragraph of paragraphs(revision.document))if(normalize(paragraph.text).includes(term))hits.push({chapterId:chapter.id,revisionId:revision.id,paragraphId:paragraph.paragraphId,title:revision.title,position:chapter.position,text:paragraph.text,hash:paragraph.hash});
    }
    return hits.slice(0,100);
  }
  private putProposal(proposal: StoryProposal): void {
    this.store.db.prepare('INSERT INTO story_proposals(id,book_id,chapter_id,job_id,payload,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(proposal.id, proposal.bookId, proposal.chapterId, proposal.jobId, JSON.stringify(proposal), proposal.createdAt);
  }
  listProposals(bookId: string): StoryProposal[] {
    this.store.getBook(bookId);
    return this.rows<StoryProposal>('SELECT payload FROM story_proposals WHERE book_id=? ORDER BY created_at DESC,rowid DESC', bookId)
      .map((proposal) => this.proposalState(proposal));
  }
  private proposalState(proposal:StoryProposal):StoryProposal {
    const chapter=this.store.getChapter(proposal.chapterId);const source=this.store.getRevision(proposal.chapterId,proposal.revisionId);
    const pendingFinal=source.kind!=='final';
    return{...proposal,requiresFinalization:pendingFinal,stale:proposal.stale||(pendingFinal?chapter.version!==source.sourceVersion:chapter.finalizedRevisionId!==source.id)};
  }
  decideProposal(id: string, accept: boolean): StoryProposal {
    return this.store.db.transaction(() => {
      const row = this.store.db.prepare('SELECT payload FROM story_proposals WHERE id=?').get(id) as JsonRow | undefined;
      if (!row) notFound('候选资料');
      const proposal = this.proposalState(JSON.parse(row.payload) as StoryProposal);
      if (proposal.state !== 'pending') {
        if ((proposal.state === 'accepted') === accept) return proposal;
        throw new AppError(409, 'PROPOSAL_DECIDED', '这一候选已经处理，请在故事资料中修改或撤回。');
      }
      if (accept && proposal.stale) throw new AppError(409, 'STALE_PROPOSAL', '这份候选依据的定稿已经变化，请重新整理资料。');
      if(accept&&proposal.requiresFinalization)throw new AppError(409,'FINAL_REQUIRED','这份建议来自尚未定稿的快照，请随本章定稿一起确认。');
      if (accept) proposal.entryId = this.saveEntry(proposal.bookId, proposal.entry).id;
      proposal.state = accept ? 'accepted' : 'rejected'; this.putProposal(proposal); return proposal;
    })();
  }
  listReviews(chapterId: string): ChapterReview[] {
    const chapter = this.store.getChapter(chapterId);
    return this.rows<ChapterReview>('SELECT payload FROM story_reviews WHERE chapter_id=? ORDER BY created_at DESC,rowid DESC', chapterId)
      .map((review) => ({ ...review, stale: review.stale || review.sourceVersion !== chapter.version }));
  }
  private jobRevision(job: AiJob): DocumentRevision {
    const source = job.context.find((item) => item.source === 'chapter' && item.chapterId === job.chapterId && item.revisionId);
    if (!source?.revisionId) throw new AppError(422, 'MISSING_SNAPSHOT', '资料任务缺少输入快照，请重新运行。');
    const revision = this.store.getRevision(job.chapterId, source.revisionId);
    if (revision.sourceVersion !== job.inputVersion || JSON.stringify(revision.document) !== JSON.stringify(job.inputDocument)) throw new AppError(422, 'INVALID_SNAPSHOT', '任务快照与正文不一致。');
    return revision;
  }
  onJobComplete(job: AiJob): void {
    if (job.kind === 'review') this.saveReview(job);
    if (job.kind === 'extract') this.saveExtraction(job);
    const dependency: Dependency = { jobId: job.id, bookId: job.bookId, chapterId: job.chapterId,
      entryIds: [...new Set(job.context.flatMap((item) => item.entryId ? [item.entryId] : []))],
      revisionIds: [...new Set(job.context.flatMap((item) => item.revisionId ? [item.revisionId] : []))] };
    this.store.db.prepare('INSERT INTO story_dependencies(job_id,book_id,chapter_id,payload) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET book_id=excluded.book_id,chapter_id=excluded.chapter_id,payload=excluded.payload')
      .run(job.id, job.bookId, job.chapterId, JSON.stringify(dependency));
  }
  private saveExtraction(job: AiJob): void {
    if (this.rows<StoryProposal>('SELECT payload FROM story_proposals WHERE job_id=?', job.id).length) return;
    const revision = this.jobRevision(job);
    const chapter = this.store.getChapter(job.chapterId);
    const parsed = parseModelJson(job.output);
    const candidates = list(parsed.entries, '候选资料', 60).map((value) => {
      const row = v.object(value, '候选资料');
      const sources = list(row.evidence, '候选证据', 20).map((item) => {
        const evidence = v.object(item, '候选证据'); const quote = v.string(evidence.quote, '证据摘录', 5_000, 1);
        return { chapterId: job.chapterId, revisionId: revision.id,
          paragraphId: v.string(evidence.paragraphId, '段落 ID', 128, 1), quote, hash: evidenceHash(quote) };
      });
      const entry = storyInput({ ...row, authority: 'fact', validFromChapter: chapter.position, evidence: sources });
      this.assertSources(job.bookId, entry.evidence ?? [], false, true);
      const proposal: StoryProposal = { id: randomUUID(), bookId: job.bookId, chapterId: job.chapterId,
        revisionId: revision.id, jobId: job.id, entry, state: 'pending', entryId: null,
        stale: revision.kind==='final'?chapter.finalizedRevisionId!==revision.id:chapter.version!==revision.sourceVersion, requiresFinalization:revision.kind!=='final',createdAt: now() };
      return proposal;
    });
    this.store.db.transaction(() => { candidates.forEach((proposal) => this.putProposal(proposal)); })();
  }
  private saveReview(job: AiJob): void {
    if (this.rows<ChapterReview>('SELECT payload FROM story_reviews WHERE job_id=?', job.id).length) return;
    const revision = this.jobRevision(job); const parsed = parseModelJson(job.output);
    const issues: ReviewIssue[] = list(parsed.issues, '审阅问题', 100).map((value) => {
      const row = v.object(value, '审阅问题');
      const quote = v.string(row.quote ?? '', '审阅原文', 5_000);
      if (quote && !revision.plainText.includes(quote)) v.invalid('审阅结果引用了正文中不存在的文字，原始输出已保留。');
      const entryIds = names(row.entryIds, '关联资料 ID');
      for (const id of entryIds) if (this.getEntry(id).bookId !== job.bookId) v.invalid('审阅关联资料不属于同一作品。');
      return { id: randomUUID(), severity: oneOf(row.severity, ['warning', 'suggestion'] as const, '问题程度'),
        message: v.string(row.message, '审阅说明', 3_000, 1), quote, entryIds };
    });
    const review: ChapterReview = { id: randomUUID(), chapterId: job.chapterId, revisionId: revision.id,
      sourceVersion: job.inputVersion, jobId: job.id, issues, stale: this.store.getChapter(job.chapterId).version !== job.inputVersion, createdAt: now() };
    this.store.db.prepare('INSERT INTO story_reviews(id,book_id,chapter_id,job_id,payload,created_at) VALUES(?,?,?,?,?,?)')
      .run(review.id, job.bookId, job.chapterId, job.id, JSON.stringify(review), review.createdAt);
  }
  onFinalized(chapter: Chapter, oldRevisionId: string | null): void {
    if(chapter.finalizedRevisionId){
      const official=this.store.getRevision(chapter.id,chapter.finalizedRevisionId);
      for(const proposal of this.rows<StoryProposal>('SELECT payload FROM story_proposals WHERE chapter_id=?',chapter.id)){
        if(proposal.state!=='pending'||proposal.stale)continue;
        const source=this.store.getRevision(chapter.id,proposal.revisionId);
        if(source.kind==='final'||source.sourceVersion!==chapter.version||JSON.stringify(source.document)!==JSON.stringify(official.document))continue;
        proposal.entry.evidence=proposal.entry.evidence?.map((evidence)=>({...evidence,revisionId:evidence.revisionId===source.id?official.id:evidence.revisionId}));
        proposal.revisionId=official.id;proposal.requiresFinalization=false;proposal.stale=false;this.putProposal(proposal);
      }
    }
    if (!oldRevisionId || oldRevisionId === chapter.finalizedRevisionId) return;
    for (const previous of this.rawEntries(chapter.bookId)) {
      if (previous.status !== 'confirmed' || previous.needsReview || !previous.evidence.some((source) => source.revisionId === oldRevisionId)) continue;
      const entry: StoryEntry = { ...previous, needsReview: true, version: previous.version + 1, updatedAt: now() };
      this.putEntry(entry); this.event(entry, 'source_changed');
    }
  }
  confirmFinalizedProposals(chapter:Chapter,proposalIds:string[]):void {
    for(const id of new Set(proposalIds)){
      const row=this.store.db.prepare('SELECT payload FROM story_proposals WHERE id=?').get(id) as JsonRow|undefined;
      if(!row)notFound('候选资料');const proposal=JSON.parse(row.payload) as StoryProposal;
      if(proposal.chapterId!==chapter.id||proposal.bookId!==chapter.bookId)v.invalid('只能在本章定稿时确认本章建议。');
      this.decideProposal(id,true);
    }
  }
  impacts(bookId: string): StoryImpact[] {
    this.store.getBook(bookId);
    const dependencies = this.rows<Dependency>('SELECT payload FROM story_dependencies WHERE book_id=?', bookId);
    const staleEntries=this.rawEntries(bookId).map((entry) => this.current(entry)).filter((entry) => entry.status === 'confirmed' && entry.needsReview);
    const impacts=staleEntries.map((entry) => ({
      entryId: entry.id, title: entry.title, reason: '来源章节已经重新定稿；原证据保留在历史中，当前资料需要复核。',
      chapterIds: [...new Set(dependencies.filter((dependency) => dependency.entryIds.includes(entry.id)
        || entry.evidence.some((source) => dependency.revisionIds.includes(source.revisionId))).map((dependency) => dependency.chapterId))],
    }));
    const covered=new Set(staleEntries.flatMap((entry)=>entry.evidence.map((source)=>source.revisionId)));
    const references=new Map<string,Set<string>>();
    for(const dependency of dependencies)for(const revisionId of dependency.revisionIds){
      if(covered.has(revisionId))continue;
      const row=this.store.db.prepare('SELECT chapter_id,kind FROM document_revisions WHERE id=?').get(revisionId) as {chapter_id:string;kind:string}|undefined;
      if(!row||row.kind!=='final')continue;
      const source=this.store.getChapter(row.chapter_id);const target=this.store.getChapter(dependency.chapterId);
      if(source.finalizedRevisionId===revisionId||source.position>=target.position)continue;
      const affected=references.get(revisionId)??new Set<string>();affected.add(target.id);references.set(revisionId,affected);
    }
    for(const [revisionId,chapterIds]of references){const row=this.store.db.prepare('SELECT chapter_id,title FROM document_revisions WHERE id=?').get(revisionId) as {chapter_id:string;title:string};impacts.push({entryId:`revision:${revisionId}`,title:`${row.title} · 旧定稿引用`,reason:'这些后文章节的任务引用过已被替换的定稿原文，可能需要复核衔接和情节；原文引用不等于完整因果关系。',chapterIds:[...chapterIds]});}
    return impacts;
  }
  getEvidence(chapterId: string): { revisionId: string | null; paragraphs: ReturnType<typeof paragraphs> } {
    const chapter = this.store.getChapter(chapterId);
    return { revisionId: chapter.finalizedRevisionId, paragraphs: chapter.finalizedRevisionId ? paragraphs(this.store.getRevision(chapterId, chapter.finalizedRevisionId).document) : [] };
  }
  exportBook(bookId: string): StoryBackup {
    this.store.getBook(bookId);
    return { version: 1, entries: this.rawEntries(bookId).map((entry) => this.current(entry)),
      events: this.rows<StoryEvent>('SELECT payload FROM story_events WHERE book_id=? ORDER BY created_at,rowid', bookId),
      proposals: this.listProposals(bookId), reviews: this.rows<ChapterReview>('SELECT payload FROM story_reviews WHERE book_id=? ORDER BY created_at,rowid', bookId),
      dependencies: this.rows<Dependency>('SELECT payload FROM story_dependencies WHERE book_id=?', bookId) };
  }
  prepareRestore(payload: unknown, ids: Record<string, string>): void {
    if (payload === undefined) return;
    const backup = this.validateBackup(payload);
    for (const row of [...backup.entries, ...backup.events, ...backup.proposals, ...backup.reviews]) {
      if (ids[row.id]) v.invalid('备份资料 ID 重复。');
      ids[row.id] = randomUUID();
    }
  }
  private validateBackup(payload: unknown): StoryBackup {
    const row = v.object(payload, '故事资料备份');
    if (row.version !== 1) v.invalid('不支持的故事资料备份版本。');
    const parseEntry = (item: unknown): StoryEntry => {
      const value = v.object(item, '故事资料'); const input = storyInput(value);
      if (typeof value.needsReview !== 'boolean') v.invalid('资料复核状态不正确。');
      return {
        id: v.string(value.id, '资料 ID', 128, 1), bookId: v.string(value.bookId, '作品 ID', 128, 1),
        kind: input.kind, authority: input.authority, title: input.title, content: input.content,
        aliases: input.aliases ?? [], visibility: input.visibility ?? 'public', knownBy: input.knownBy ?? [],
        status: oneOf(value.status, ['idea', 'confirmed', 'withdrawn'] as const, '确认状态'), storyTime: input.storyTime ?? '',
        ...(input.attributes===undefined?{}:{attributes:input.attributes}),...(input.links===undefined?{}:{links:input.links}),...(input.branch===undefined?{}:{branch:input.branch}),
        narrative: input.narrative ?? 'unknown', validFromChapter: input.validFromChapter ?? 1,
        plannedPayoff: input.plannedPayoff ?? null, evidence: input.evidence ?? [], needsReview: value.needsReview,
        version: v.integer(value.version, '资料版本', 1), createdAt: v.string(value.createdAt, '创建时间', 100, 1),
        updatedAt: v.string(value.updatedAt, '修改时间', 100, 1),
      };
    };
    const entries = list(row.entries, '故事资料备份', 50_000).map(parseEntry);
    const events = list(row.events, '资料历史', 100_000).map((item) => {
      const value = v.object(item, '资料历史');
      v.string(value.id, '历史 ID', 128, 1); v.string(value.bookId, '作品 ID', 128, 1); v.string(value.entryId, '资料 ID', 128, 1);
      oneOf(value.action, ['confirm', 'update', 'withdraw', 'source_changed'] as const, '历史动作');
      v.integer(value.version, '历史版本', 1); const entry = parseEntry(value.entry); v.string(value.createdAt, '历史时间', 100, 1);
      if (entry.version !== value.version) v.invalid('资料历史版本不匹配。');
      return { ...(value as unknown as StoryEvent), entry };
    });
    const proposals = list(row.proposals, '候选资料', 100_000).map((item) => {
      const value = v.object(item, '候选资料');
      for (const key of ['id', 'bookId', 'chapterId', 'revisionId', 'jobId', 'createdAt']) v.string(value[key], key, 128, 1);
      const entry = storyInput(value.entry); oneOf(value.state, ['pending', 'accepted', 'rejected'] as const, '候选状态');
      if (value.entryId !== null) v.string(value.entryId, '已采纳资料', 128, 1);
      if (typeof value.stale !== 'boolean') v.invalid('候选状态不正确。');
      return { ...(value as unknown as StoryProposal), entry };
    });
    const reviews = list(row.reviews, '审阅记录', 100_000).map((item) => {
      const value = v.object(item, '审阅记录');
      for (const key of ['id', 'chapterId', 'revisionId', 'jobId', 'createdAt']) v.string(value[key], key, 128, 1);
      v.integer(value.sourceVersion, '审阅草稿版本', 1); if (typeof value.stale !== 'boolean') v.invalid('审阅状态不正确。');
      list(value.issues, '审阅问题', 100).forEach((issue) => {
        const data = v.object(issue); v.string(data.id, '问题 ID', 128, 1); v.string(data.message, '审阅说明', 3_000, 1);
        v.string(data.quote, '引用原文', 5_000); oneOf(data.severity, ['warning', 'suggestion'] as const, '问题程度'); names(data.entryIds, '关联资料');
      });
      return value as unknown as ChapterReview;
    });
    const dependencies = list(row.dependencies ?? [], '资料依赖', 100_000).map((item) => {
      const value = v.object(item);
      for (const key of ['jobId', 'bookId', 'chapterId']) v.string(value[key], key, 128, 1);
      list(value.entryIds,'关联资料',1000).forEach((id)=>v.string(id,'关联资料 ID',128,1));list(value.revisionIds,'关联版本',1000).forEach((id)=>v.string(id,'关联版本 ID',128,1));
      return value as unknown as Dependency;
    });
    return { version: 1, entries, events, proposals, reviews, dependencies };
  }
  restoreBook(oldBookId: string, newBookId: string, ids: Record<string, string>, payload: unknown): void {
    if (payload === undefined) return;
    const backup = this.validateBackup(payload);
    const mapped = (id: string): string => ids[id] ?? v.invalid('故事资料备份包含不存在的关联 ID。');
    const mapEvidence = (sources: StoryEvidence[]): StoryEvidence[] => sources.map((source) => ({ ...source, chapterId: mapped(source.chapterId), revisionId: mapped(source.revisionId) }));
    const mapLinks=(links:NonNullable<StoryEntry['links']>):NonNullable<StoryEntry['links']>=>({...(links.voiceId?{voiceId:mapped(links.voiceId)}:{}),...(links.planId?{planId:mapped(links.planId)}:{}),...(links.parentId?{parentId:mapped(links.parentId)}:{}),...(links.chapterIds?{chapterIds:links.chapterIds.map(mapped)}:{})});
    const mapEntry = (entry: StoryEntry): StoryEntry => {
      if (entry.bookId !== oldBookId) v.invalid('资料备份所属作品不匹配。');
      const output = { ...entry, id: mapped(entry.id), bookId: newBookId, evidence: mapEvidence(entry.evidence),...(entry.links?{links:mapLinks(entry.links)}:{}) };
      this.assertSources(newBookId, output.evidence, false); return output;
    };
    for (const entry of backup.entries) this.putEntry(mapEntry(entry));
    for (const original of backup.events) {
      if (original.bookId !== oldBookId || original.entry.id !== original.entryId) v.invalid('资料历史关联不正确。');
      const event: StoryEvent = { ...original, id: mapped(original.id), bookId: newBookId, entryId: mapped(original.entryId), entry: mapEntry(original.entry) };
      this.getEntry(event.entryId);
      this.store.db.prepare('INSERT INTO story_events(id,book_id,entry_id,payload,created_at) VALUES(?,?,?,?,?)')
        .run(event.id, newBookId, event.entryId, JSON.stringify(event), event.createdAt);
    }
    for (const original of backup.proposals) {
      if (original.bookId !== oldBookId) v.invalid('候选备份所属作品不匹配。');
      const proposal: StoryProposal = { ...original, id: mapped(original.id), bookId: newBookId,
        chapterId: mapped(original.chapterId), revisionId: mapped(original.revisionId), jobId: mapped(original.jobId),
        entryId: original.entryId ? mapped(original.entryId) : null,
        entry: { ...original.entry, evidence: mapEvidence(original.entry.evidence ?? []),...(original.entry.links?{links:mapLinks(original.entry.links)}:{}) } };
      if (this.store.getChapter(proposal.chapterId).bookId !== newBookId) v.invalid('候选证据不属于恢复作品。');
      this.store.getRevision(proposal.chapterId, proposal.revisionId); this.assertSources(newBookId, proposal.entry.evidence ?? [], false, true);
      this.putProposal(proposal);
    }
    for (const original of backup.reviews) {
      const review: ChapterReview = { ...original, id: mapped(original.id), chapterId: mapped(original.chapterId),
        revisionId: mapped(original.revisionId), jobId: mapped(original.jobId),
        issues: original.issues.map((issue) => ({ ...issue, id: randomUUID(), entryIds: issue.entryIds.map(mapped) })) };
      if (this.store.getChapter(review.chapterId).bookId !== newBookId) v.invalid('审阅不属于恢复作品。');
      this.store.getRevision(review.chapterId, review.revisionId);
      this.store.db.prepare('INSERT INTO story_reviews(id,book_id,chapter_id,job_id,payload,created_at) VALUES(?,?,?,?,?,?)')
        .run(review.id, newBookId, review.chapterId, review.jobId, JSON.stringify(review), review.createdAt);
    }
    for (const original of backup.dependencies) {
      if (original.bookId !== oldBookId) v.invalid('依赖不属于恢复作品。');
      const dependency: Dependency = { jobId: mapped(original.jobId), bookId: newBookId, chapterId: mapped(original.chapterId),
        entryIds: original.entryIds.map(mapped), revisionIds: original.revisionIds.map(mapped) };
      if (this.store.getChapter(dependency.chapterId).bookId !== newBookId) v.invalid('依赖章节不属于恢复作品。');
      this.store.db.prepare('INSERT INTO story_dependencies(job_id,book_id,chapter_id,payload) VALUES(?,?,?,?)')
        .run(dependency.jobId, newBookId, dependency.chapterId, JSON.stringify(dependency));
    }
  }
}
