import { describe, expect, it } from 'vitest';
import { storyReviewHints } from '../../apps/web/src/lib/story-review.js';

describe('nonbinding finalization reading cues', () => {
  it('does not turn future death plans into a current-state warning', () => {
    expect(storyReviewHints({ kind: 'plan', authority: 'plan', title: '未来发展', content: '计划第八章揭晓真实身份，第九章死亡。' })).toEqual([]);
  });
  it('flags passages for reading without mutating or certifying their meaning', () => {
    const entry = { kind: 'event' as const, authority: 'fact' as const, title: '回忆', content: '回忆中提到已去世的父亲，并不代表本章有人死亡。' };
    const original = structuredClone(entry);
    expect(storyReviewHints(entry)).toContain('涉及生死措辞');
    expect(entry).toEqual(original);
    expect(storyReviewHints({ kind: 'item', authority: 'setting', title: '保温杯', content: '普通灰色保温杯。' })).toEqual([]);
  });
});
