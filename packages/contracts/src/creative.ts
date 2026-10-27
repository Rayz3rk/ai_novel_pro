import type { AiJobStatus, AiTaskKind, ContextItem, CreateAiJobInput, ModelCall, ModelSettings } from './collaboration.js';

export type CreativeContextNeed = 'current' | 'outline' | 'story' | 'style' | 'voices';
export interface SkillResource { path: string; text: string }
export interface SkillDefinition {
  name: string; title: string; description: string; tasks: AiTaskKind[];
  instructions: string; contextNeeds: CreativeContextNeed[]; resources: SkillResource[];
  license: string; source: string;
}
export interface CreativeSkill extends SkillDefinition {
  id: string; bookId: string | null; version: number; hash: string;
  builtin: boolean; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface SkillSelection { id: string; version: number; focus?: string; resourcePaths?: string[] }
export interface WritingStyle { narration: string; tone: string; pacing: string; avoid: string; example: string }
export interface CharacterVoice { id: string; name: string; aliases: string[]; traits: string; example: string }
export interface PreferenceExample {
  id: string; title: string; before: string; after: string; reason: string; condition: string; counterExample: string;
  status: 'pending' | 'confirmed' | 'withdrawn'; sourceJobId?: string; sourceChapterId?: string;
}
export interface CreativeProfile {
  bookId: string; version: number; style: WritingStyle; voices: CharacterVoice[]; preferences: PreferenceExample[];
  disabledSkillIds: string[]; defaultSkillIds: Partial<Record<AiTaskKind, string[]>>; updatedAt: string;
}
export type SaveCreativeProfile = Omit<CreativeProfile, 'bookId' | 'version' | 'updatedAt'> & { expectedVersion: number };
export interface SkillSnapshot {
  id: string; version: number; hash: string; definition: SkillDefinition;
  focus: string; resources: SkillResource[];
}
export interface CreativeSnapshot {
  skills: SkillSnapshot[]; profileVersion: number; profileHash: string;
  voiceIds: string[]; preferenceIds: string[];
}
export interface PromptMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface PromptSnapshot {
  schema: 1; hash: string; messages: PromptMessage[]; creativity: CreativeSnapshot;
}
export interface ContextPreview {
  fingerprint: string; chapterVersion: number; model: string; modelConnectionId: string;
  included: ContextItem[]; omitted: Array<{ item: ContextItem; reason: string }>;
  inputTokens: number; outputTokens: number; contextWindow: number;
  estimatedCost: number | null; currency: 'USD'; blocked: { code: string; message: string } | null;
  prompt: PromptSnapshot;
}
export interface CleanFinding { rule: string; message: string; quote: string; offset: number }
export interface CleanReport { chapterId: string; version: number; findings: CleanFinding[]; modelCalled: false }
export interface CreativeEvaluationSample {
  format: 'shujian-creative-evaluation'; version: 1; exportedAt: string;
  sourceJobId: string; task: AiTaskKind; input: CreateAiJobInput;
  prompt: PromptSnapshot | null; context: ContextItem[]; output: string;
  model: string; inputVersion: number;
  parameters: Omit<ModelSettings, 'hasApiKey'> | null;
  status: AiJobStatus; calls: ModelCall[];
}
