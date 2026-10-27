import { createHash } from 'node:crypto';
import type { CreativeSkill, SkillDefinition } from '@shujian/contracts';

export const creativeHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition = (name: string, title: string, description: string, tasks: SkillDefinition['tasks'], instructions: string, contextNeeds: SkillDefinition['contextNeeds']): SkillDefinition => ({
  name, title, description, tasks, instructions, contextNeeds, resources: [], license: 'Project-authored', source: '书间内置创作方法',
});
// Original, declarative methods. They never grant tools or change the task's output protocol.
const definitions: SkillDefinition[] = [
  definition('scene-turn', '场景目标与转折', '让一个场景产生可感知的变化，适用于规划、起草和局部修改。', ['discuss', 'plan', 'draft', 'revise', 'review'],
    '先识别视角人物此刻想得到什么、遇到什么具体阻力、采取什么行动。让行动引出反应及新的处境，结尾与开头有可辨认的变化。允许安静日常、犹豫和未解决的问题，不强加反转或章尾悬念。不凭空补全未确认设定。审阅时引用原句并解释变化不足之处；起草和改写时把方法落实在正文中，仍只输出当前任务要求的格式。', ['current', 'outline', 'story']),
  definition('dialogue-subtext', '人物对白与潜台词', '区分人物声音，让对话同时承载意图、关系与生活感。', ['discuss', 'draft', 'revise', 'review'],
    '区分说话者此刻的目的、习惯表达和不愿直接说出的内容。用回应、回避、停顿及必要的具体行动形成潜台词；不是每句话都附动作。保护人物之间的差异，避免所有人都机智、长篇解释或互相代说内心。保留作者要求的信息和表达特点。只对证据明确的问题提出建议，不把自然沉默当作必须填满的空白。', ['current', 'voices', 'style']),
  definition('slow-relationship', '慢热关系推进', '让关系变化有积累、有个性，适用于日常与感情线。', ['discuss', 'plan', 'draft', 'revise', 'review'],
    '先依据已给材料判断关系目前处于何种状态，未知则保留未知。本场景只推进有行动依据的一小步：注意、信任、偏袒、边界或自我认识。让双方保留各自目标和选择，配角也有独立动机。避免靠降智误会、反复吃醋或过度巧合推进。变化可有回撤，不用固定甜度公式；不要把推测写成确认的恋爱事实。', ['current', 'outline', 'story', 'voices']),
  definition('pov-continuity', '视角与连续性核对', '检查知情范围、时间和物品状态，结论需有证据。', ['discuss', 'plan', 'draft', 'revise', 'review', 'extract'],
    '分别识别故事发生时间、叙述顺序、人物所知和作者意图。回忆不代表当前状态，未来计划不代表事实。核对人物行动是否需要尚未知晓的信息，物品归属是否有交接依据，因果链是否缺环。审阅时给出当前原句与相关资料，缺少证据则明确为待核对；提取时只提取原文支持的变化。不扩大角色知情，不确认新的事实。', ['current', 'story']),
  definition('style-preservation', '文风保护与分层修订', '按场景、表达和字词逐层改进，保留作者有意的节奏。', ['discuss', 'draft', 'revise', 'review'],
    '先看场景因果和情绪组织，再看信息如何流动，最后处理字词。识别应保留的细节、句式节奏、人物口气和有意留白。减少旁白过度解释、模板化总结和不必要的同义重复。风格偏好以本次要求和本书档案为依据，不因为出现某个词就删除，不把朴素、粗粝或短句自动改成抒情长句。局部修改严格留在选区内。', ['current', 'style', 'voices']),
  definition('manuscript-clean', '稿件清洁检查', '关注提示残留、相邻重复和异常片段，避免泛化为文笔评分。', ['review', 'revise'],
    '检查正文是否混入生成说明、提示标签、占位文字、异常片段或明显相邻重复。用原句说明，不因正常外语、人物口头禅或刻意复沓就认定错误。对不确定内容保留作者决定权。只在当前任务允许的范围提出建议或候选；不把清洁检查当作文学质量分，不为追求所谓去AI味改变人物事实或文风。', ['current']),
];
export const builtinSkills: CreativeSkill[] = definitions.map((entry) => ({ ...entry, id: `builtin-${entry.name}`, bookId: null, version: 1,
  hash: creativeHash(entry), builtin: true, enabled: true, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }));

export function skillDefinition(skill: SkillDefinition): SkillDefinition {
  const { name, title, description, tasks, instructions, contextNeeds, resources, license, source } = skill;
  return { name, title, description, tasks, instructions, contextNeeds, resources, license, source };
}
