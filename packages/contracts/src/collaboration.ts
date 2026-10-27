import type { Chapter, ManuscriptDocument } from './index.js';
import type { PromptMessage, PromptSnapshot, SkillSelection } from './creative.js';
import type { AtlasLinks, AtlasSelection } from './atlas.js';

export interface ModelSettings {
  id: string; baseUrl: string; model: string; stream: boolean; temperature: number;
  name?: string; tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  sendTemperature?: boolean; includeStreamUsage?: boolean;
  maxOutputTokens: number; contextWindow: number; inputPricePerMillion: number | null;
  outputPricePerMillion: number | null; taskBudget: number | null; dailyBudget: number | null;
  hasApiKey: boolean;
}
export type UpdateModelSettings = Omit<ModelSettings, 'id' | 'hasApiKey'> & { apiKey?: string; clearApiKey?: boolean };
export type AiTaskKind = 'discuss' | 'plan' | 'draft' | 'revise' | 'review' | 'extract';
export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export interface TextSelection { from: number; to: number; text: string }
export interface CreateAiJobInput {
  requestId: string; kind: AiTaskKind; chapterId: string; expectedVersion: number;
  instruction: string; selection?: TextSelection; pov?: string; pinnedEntryIds?: string[]; excludedEntryIds?: string[];
  source?: 'draft' | 'final';
  skills?: SkillSelection[]; voiceIds?: string[]; previewFingerprint?: string;
  atlas?: AtlasSelection;
}
export interface ContextItem {
  id: string; label: string; source: 'instruction' | 'chapter' | 'outline' | 'premise' | 'canon' | 'history' | 'conversation' | 'skill' | 'style';
  text: string; chapterId?: string; revisionId?: string; entryId?: string; required: boolean;
}
export interface AiUsage {
  inputTokens: number | null; outputTokens: number | null; estimatedCost: number | null;
  attempts: number; currency: 'USD';
}
export interface ModelCall {
  id:string;jobId:string|null;attempt:number;model:string;status:'running'|'succeeded'|'failed'|'cancelled'|'interrupted';
  inputTokens:number|null;outputTokens:number|null;estimatedCost:number|null;error:string|null;output?:string;createdAt:string;updatedAt:string;
  requestMessages?: PromptMessage[]; promptHash?: string;
}
export interface AiJob {
  id: string; bookId: string; chapterId: string; kind: AiTaskKind; status: AiJobStatus;
  instruction: string; inputVersion: number; inputDocument: ManuscriptDocument; inputTitle: string; inputOutline: string;
  selection: TextSelection | null; output: string; error: string | null; model: string;
  candidateText?: string;
  modelConnectionId?: string;
  priceSnapshot?: { inputPricePerMillion: number | null; outputPricePerMillion: number | null };
  context: ContextItem[]; promptVersion: string; usage: AiUsage;
  promptSnapshot?: PromptSnapshot;
  skillBindings?: Array<{ snapshotId: string; skillId: string }>;
  appliedVersion: number | null; createdAt: string; updatedAt: string;
}
export interface ApplyAiJobInput { expectedVersion: number; text?: string; target: 'document' | 'outline' }
export interface ApplyAiJobResult { chapter: Chapter; alreadyApplied: boolean }

export type StoryEntryKind = 'character' | 'rule' | 'event' | 'item' | 'foreshadow' | 'plan' | 'location' | 'organization' | 'scene' | 'note';
export type StoryAuthority = 'setting' | 'fact' | 'plan';
export type StoryVisibility = 'public' | 'author' | 'characters';
export interface StoryEvidence {
  chapterId: string; revisionId: string; paragraphId: string; quote: string; hash: string;
}
export interface StoryEntry {
  id: string; bookId: string; kind: StoryEntryKind; authority: StoryAuthority;
  title: string; content: string; aliases: string[]; visibility: StoryVisibility; knownBy: string[];
  status: 'idea' | 'confirmed' | 'withdrawn'; storyTime: string; narrative: 'normal' | 'flashback' | 'unknown';
  validFromChapter: number; plannedPayoff: number | null; evidence: StoryEvidence[];
  needsReview: boolean; version: number; createdAt: string; updatedAt: string;
  attributes?: Record<string, string>; links?: AtlasLinks; branch?: string;
}
export interface SaveStoryEntryInput {
  kind: StoryEntryKind; authority: StoryAuthority; title: string; content: string; aliases?: string[];
  visibility?: StoryVisibility; knownBy?: string[]; storyTime?: string;
  narrative?: 'normal' | 'flashback' | 'unknown'; validFromChapter?: number;
  plannedPayoff?: number | null; evidence?: StoryEvidence[]; expectedVersion?: number;
  status?: StoryEntry['status']; attributes?: Record<string, string>; links?: AtlasLinks; branch?: string;
}
export interface StoryProposal {
  id: string; bookId: string; chapterId: string; revisionId: string; jobId: string;
  entry: SaveStoryEntryInput; state: 'pending' | 'accepted' | 'rejected'; entryId: string | null; stale: boolean;
  createdAt: string;
  requiresFinalization?: boolean;
}
export interface StoryImpact {
  entryId: string; title: string; reason: string; chapterIds: string[];
}
export interface ReviewIssue {
  id: string; severity: 'warning' | 'suggestion'; message: string; quote: string; entryIds: string[];
}
export interface ChapterReview {
  id: string; chapterId: string; revisionId: string; sourceVersion: number; jobId: string;
  issues: ReviewIssue[]; stale: boolean; createdAt: string;
}
export interface StorySearchResult { entries: StoryEntry[]; coverage: { finalizedChapters: number; withEvidence: number; pendingProposals: number } }
export interface StorySourceHit { chapterId:string;revisionId:string;paragraphId:string;title:string;position:number;text:string;hash:string }

export interface PlanNode {
  id: string; bookId: string; parentId: string | null; level: 'book' | 'arc' | 'chapter' | 'scene';
  chapterId: string | null; title: string; content: string; position: number; version: number;
  createdAt: string; updatedAt: string;
}
export type SavePlanInput = Pick<PlanNode, 'parentId' | 'level' | 'chapterId' | 'title' | 'content' | 'position'> & { expectedVersion?: number };
