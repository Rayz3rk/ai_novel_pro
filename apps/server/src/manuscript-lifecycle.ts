import type { ChapterReference } from '@shujian/contracts';
import type { Store } from './store.js';

export interface ReferenceSource {
  table: string; label: string; historical?: boolean; key?: string;
  column?: string; chapterScoped?: boolean;
}
export interface ManuscriptModule {
  name: string; sources: ReferenceSource[]; bookTables: string[]; chapterTables?: string[];
}

/** Modules declare references and deletion order in one place. New modules can register here. */
export class ManuscriptLifecycle {
  private readonly modules: ManuscriptModule[] = [];
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS legacy_imports(source TEXT NOT NULL,project_id TEXT NOT NULL,book_id TEXT NOT NULL,PRIMARY KEY(source,project_id));
      CREATE TABLE IF NOT EXISTS manuscript_references (
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, module TEXT NOT NULL, title TEXT NOT NULL, historical INTEGER NOT NULL,
      path TEXT NOT NULL, chapter_id TEXT);
      CREATE INDEX IF NOT EXISTS manuscript_reference_target ON manuscript_references(book_id,target_id);`);
  }
  register(module: ManuscriptModule, first = false): void {
    for (const name of [...module.bookTables, ...(module.chapterTables ?? []), ...module.sources.flatMap(source => [source.table, source.key ?? 'id', source.column ?? 'payload'])]) {
      if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid lifecycle identifier');
    }
    if (this.modules.some(item => item.name === module.name)) throw new Error('Duplicate manuscript module');
    if(first)this.modules.unshift(module);else this.modules.push(module);
  }
  chapterReferences(chapterId: string): ChapterReference[] {
    return this.store.db.transaction(() => {
      const chapter = this.store.getChapter(chapterId);
      const targets = new Set([chapterId, ...this.store.listRevisions(chapterId).map(revision => revision.id),
        ...(this.store.db.prepare('SELECT id FROM ai_jobs WHERE chapter_id=?').all(chapterId) as { id: string }[]).map(job => job.id)]);
      // Rebuild from current records and immutable history so edits never leave a stale safety index.
      this.store.db.prepare('DELETE FROM manuscript_references WHERE book_id=?').run(chapter.bookId);
      const insert = this.store.db.prepare('INSERT INTO manuscript_references(book_id,source_id,target_id,module,title,historical,path,chapter_id) VALUES(?,?,?,?,?,?,?,?)');
      for (const module of this.modules) for (const source of module.sources) {
        const rows = this.store.db.prepare(`SELECT ${source.key ?? 'id'} AS id,${source.column ?? 'payload'} AS payload ${source.chapterScoped ? ',chapter_id' : ''} FROM ${source.table} WHERE book_id=?`).all(chapter.bookId) as {id: string; payload: string; chapter_id?: string}[];
        for (const row of rows) {
          if (row.chapter_id === chapterId) continue; // These records are deleted together with this chapter.
          const value: unknown = JSON.parse(row.payload);
          const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
          const title = `${source.label} · ${String(record.title ?? record.name ?? record.inputTitle ?? row.id).slice(0, 160)}`;
          const walk = (item: unknown, path: string, depth: number) => {
            if (depth > 80) return;
            if (typeof item === 'string') {
              if (targets.has(item)) insert.run(chapter.bookId, row.id, item, module.name, title, source.historical ? 1 : 0, path, row.chapter_id ?? null);
            } else if (Array.isArray(item)) item.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
            else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) walk(child, path ? `${path}.${key}` : key, depth + 1);
          };
          walk(value, '', 0);
        }
      }
      return (this.store.db.prepare(`SELECT source_id,module,title,historical,path,chapter_id FROM manuscript_references WHERE book_id=? AND target_id IN (SELECT id FROM chapters WHERE id=? UNION SELECT id FROM document_revisions WHERE chapter_id=? UNION SELECT id FROM ai_jobs WHERE chapter_id=?) ORDER BY historical,module,title,path`).all(chapter.bookId, chapterId, chapterId, chapterId) as {source_id:string;module:string;title:string;historical:number;path:string;chapter_id:string|null}[])
        .map(row => ({ id: row.source_id, module: row.module, title: row.title, historical: !!row.historical, path: row.path, ...(row.chapter_id ? { chapterId: row.chapter_id } : {}) }));
    })();
  }
  deleteRecords(bookId: string, chapterId?: string): void {
    for (const module of this.modules) for (const table of chapterId ? module.chapterTables ?? [] : module.bookTables) {
      this.store.db.prepare(`DELETE FROM ${table} WHERE ${chapterId ? 'chapter_id' : 'book_id'}=?`).run(chapterId ?? bookId);
    }
    this.store.db.prepare('DELETE FROM manuscript_references WHERE book_id=?').run(bookId);
  }
}

export function createManuscriptLifecycle(store: Store): ManuscriptLifecycle {
  const lifecycle = new ManuscriptLifecycle(store);
  const sources = (tables: string[], label: string) => tables.map(table => ({ table, label, historical: /history|events/.test(table) }));
  lifecycle.register({ name: '图谱', sources: sources(['atlas_relations', 'atlas_states', 'atlas_events'], '图谱记录'), bookTables: ['atlas_events', 'atlas_relations', 'atlas_states', 'atlas_views'] });
  lifecycle.register({ name: '剧情规划', sources: sources(['plans', 'plan_history'], '规划'), bookTables: ['plan_history', 'plans'] });
  lifecycle.register({ name: '文风与偏好', sources: [{ table: 'creative_profiles', key: 'book_id', label: '作者档案' }, ...sources(['creative_profile_history'], '档案历史')], bookTables: ['creative_skill_history', 'creative_skills', 'creative_profile_history', 'creative_profiles'] });
  lifecycle.register({ name: '故事资料', sources: [...sources(['story_entries', 'story_events'], '资料卡'), ...sources(['story_proposals', 'story_reviews', 'story_dependencies'], '审阅与依赖').map(source => ({ ...source, key: source.table === 'story_dependencies' ? 'job_id' : 'id', chapterScoped: true }))], bookTables: ['story_proposals', 'story_reviews', 'story_dependencies', 'story_events', 'story_entries'], chapterTables: ['story_proposals', 'story_reviews', 'story_dependencies'] });
  lifecycle.register({ name: 'AI 历史', sources: ['job', 'input'].map(column => ({ table: 'ai_jobs', column, label: 'AI 任务', historical: true, chapterScoped: true })), bookTables: ['ai_jobs'], chapterTables: ['ai_jobs'] });
  return lifecycle;
}
