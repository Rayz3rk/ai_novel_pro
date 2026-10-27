export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export * from './collaboration.js';
export * from './creative.js';
export * from './atlas.js';

export interface StorageInfo {
  driver: 'sqlite' | 'postgresql'; database: string; host?: string; port?: number; configFile?: string;
  nextDriver?: 'sqlite' | 'postgresql'; canSelect?: boolean; hasPostgresConfig?: boolean;
}

export interface DocumentNode {
  type: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: Array<{ type: string; attrs?: Record<string, JsonValue> }>;
  content?: DocumentNode[];
}

export interface ManuscriptDocument {
  type: 'doc';
  content: DocumentNode[];
}

export type ChapterStatus = 'draft' | 'final' | 'revising';

export interface Book {
  id: string;
  title: string;
  genre: string;
  premise: string;
  targetWords: number;
  accent: string;
  chapterCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterSummary {
  id: string;
  bookId: string;
  position: number;
  title: string;
  outline: string;
  status: ChapterStatus;
  wordCount: number;
  version: number;
  finalizedRevisionId: string | null;
  updatedAt: string;
}

export interface Chapter extends ChapterSummary {
  document: ManuscriptDocument;
  plainText: string;
  createdAt: string;
}

export interface RevisionSummary {
  id: string;
  chapterId: string;
  label: string;
  kind: 'checkpoint' | 'final' | 'before_restore';
  wordCount: number;
  sourceVersion: number;
  createdAt: string;
}

export interface DocumentRevision extends RevisionSummary {
  title: string;
  outline: string;
  document: ManuscriptDocument;
  plainText: string;
}

export interface CreateBookInput {
  title: string;
  genre?: string;
  premise?: string;
  targetWords?: number;
  accent?: string;
}

export type UpdateBookInput = Partial<CreateBookInput>;

export interface SaveDraftInput {
  expectedVersion: number;
  title: string;
  outline: string;
  document: ManuscriptDocument;
}

export interface ApiErrorBody {
  error: { code: string; message: string; currentVersion?: number };
}

export interface BackupBook {
  book: Book;
  chapters: Array<{ chapter: Chapter; revisions: DocumentRevision[] }>;
  extensions?: Record<string, JsonValue>;
}

export interface WorkspaceBackup {
  format: 'shujian-backup';
  version: 1;
  exportedAt: string;
  books: BackupBook[];
}

export function emptyDocument(): ManuscriptDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function documentToText(document: ManuscriptDocument): string {
  const render = (node: DocumentNode): string => {
    if (node.type === 'hardBreak') return '\n';
    if (node.text !== undefined) return node.text;
    const children = (node.content ?? []).map(render);
    if (['bulletList', 'orderedList', 'listItem'].includes(node.type)) return children.join('\n');
    if (node.type === 'blockquote') return children.join('\n\n');
    return children.join('');
  };
  return document.content.map(render).join('\n\n');
}

/** Count letters and numbers by Unicode code point; punctuation and whitespace excluded. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export function textToDocument(text: string): ManuscriptDocument {
  return {
    type: 'doc',
    content: text.replace(/\r\n?/g, '\n').split(/\n\s*\n|\n/).map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}
