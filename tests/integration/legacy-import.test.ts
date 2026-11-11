import { describe, it, expect } from 'vitest';
import { convertLegacyBook, type LegacyChapter } from '../../apps/server/src/legacy-import.js';
import { backup } from '../../apps/server/src/validation.js';

describe('legacy import', () => {
  it('preserves an intentionally empty saved draft and the original manuscript and all versions', () => {
    const time = '2026-01-01T00:00:00.000Z';
    const project = { id: 'old-book', title: '旧小说', genre: '悬疑', premise: '设想', created_at: time };
    const chapter: LegacyChapter = { id: 'old-chapter', project_id: project.id, number: 1, title: '原标题', content: '已保存正文',
      draft_title: '草稿标题', draft_content: '', draft_saved_at: time, goal: '目标', conflict: '冲突', hook: '悬念', tone: '', beats: [], created_at: time, updated_at: time };
    const entry = convertLegacyBook(project, [chapter], [{ id: 'old-version', chapter_id: chapter.id, title: '旧版标题', content: '更早正文', created_at: time }]);
    expect(entry.chapters[0]?.chapter.title).toBe('草稿标题');
    expect(entry.chapters[0]?.chapter.plainText).toBe('');
    expect(entry.chapters[0]?.revisions.map(v => v.plainText)).toEqual(['更早正文', '已保存正文']);
    expect(entry.chapters[0]?.chapter.outline).toContain('冲突：冲突');
    expect(backup({ format: 'shujian-backup', version: 1, exportedAt: time, books: [entry] }).books).toHaveLength(1);
  });
});
