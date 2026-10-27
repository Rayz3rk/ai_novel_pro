import type { SaveStoryEntryInput } from '@shujian/contracts';

/** Reading cues only: never confirm a fact, infer a death, or block author finalization. */
export function storyReviewHints(entry: Pick<SaveStoryEntryInput, 'kind' | 'authority' | 'title' | 'content'>): string[] {
  if (entry.authority === 'plan') return [];
  const text = `${entry.title}\n${entry.content}`;
  const hints: string[] = [];
  if (/死亡|死去|身亡|遇害|去世|丧生|杀死|自杀|复活/.test(text)) hints.push('涉及生死措辞');
  if (/真实身份|身份揭露|身份揭晓|身份暴露|揭露身份|凶手是|真凶|身世|血缘/.test(text)) hints.push('涉及身份信息');
  if (entry.kind === 'rule') hints.push('涉及故事规则');
  if (entry.kind === 'item' && /转交|交给|归还|赠予|丢失|遗失|取得|获得|失去|持有|归属|损毁|损坏|销毁/.test(text)) hints.push('涉及物品状态');
  return hints;
}
