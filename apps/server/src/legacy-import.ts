import { randomUUID } from 'node:crypto';
import { countWords, documentToText, textToDocument, type BackupBook, type DocumentRevision, type Chapter } from '@shujian/contracts';

export interface LegacyChapter {
  id: string; project_id: string; number: number; title: string; content: string;
  draft_title: string | null; draft_content: string | null; draft_saved_at: string | null;
  goal: string; conflict: string; hook: string; tone: string; beats: unknown;
  created_at: string; updated_at: string;
}
export interface LegacyVersion { id: string; chapter_id: string; title: string; content: string; created_at: string }
export interface LegacyProject { id: string; title: string; genre: string; premise: string; created_at: string }

/** Keep the legacy saved manuscript and every version alongside the latest draft. */
export function convertLegacyBook(project: LegacyProject, chapters: LegacyChapter[], versions: LegacyVersion[]): BackupBook {
  const entries = [...chapters].sort((a, b) => a.number - b.number).map((old, index) => {
    const outline = [['本章目标', old.goal], ['冲突', old.conflict], ['悬念', old.hook], ['基调', old.tone],
      ['节拍', typeof old.beats === 'string' ? old.beats : JSON.stringify(old.beats ?? [])]]
      .filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n');
    const hasDraft = old.draft_saved_at !== null && old.draft_content !== null;
    const document = textToDocument(hasDraft ? old.draft_content! : old.content);
    const text = documentToText(document);
    const revisions: DocumentRevision[] = versions.filter(v => v.chapter_id === old.id).map(v => {
      const document = textToDocument(v.content); const plainText = documentToText(document);
      return { id: randomUUID(), chapterId: old.id, title: v.title, outline, document, plainText,
        wordCount: countWords(plainText), label: '旧项目历史版本', kind: 'checkpoint', sourceVersion: 1, createdAt: v.created_at };
    });
    const savedDocument = textToDocument(old.content); const savedText = documentToText(savedDocument);
    revisions.push({ id: randomUUID(), chapterId: old.id, title: old.title, outline, document: savedDocument,
      plainText: savedText, wordCount: countWords(savedText), label: '旧项目已保存正文', kind: 'checkpoint', sourceVersion: 1, createdAt: old.updated_at });
    const chapter: Chapter = { id: old.id, bookId: project.id, position: index + 1,
      title: hasDraft ? old.draft_title ?? old.title : old.title, outline, document, plainText: text,
      wordCount: countWords(text), version: 1, finalizedRevisionId: null, status: 'draft', createdAt: old.created_at, updatedAt: old.updated_at };
    return { chapter, revisions };
  });
  return { book: { id: project.id, title: project.title, genre: project.genre, premise: project.premise,
    targetWords: 100_000, accent: '#244a42', createdAt: project.created_at, updatedAt: project.created_at,
    chapterCount: entries.length, wordCount: entries.reduce((sum, entry) => sum + entry.chapter.wordCount, 0) }, chapters: entries };
}
