import type { PlanNode, StoryEntry, StoryEvidence, StoryVisibility } from './collaboration.js';
import type { CharacterVoice } from './creative.js';

export type AtlasPhase = 'idea' | 'confirmed' | 'withdrawn';
export interface AtlasSelection { nodeIds: string[]; relationIds: string[]; includeIdeas: boolean; branch: string }
export interface AtlasLinks { voiceId?: string; planId?: string; parentId?: string; chapterIds?: string[] }
export interface AtlasRecordBase {
  id: string; bookId: string; phase: AtlasPhase; branch: string;
  fromChapter: number; storyTime: string; visibility: StoryVisibility; knownBy: string[];
  evidence: StoryEvidence[]; sourceJobId: string | null; needsReview: boolean;
  version: number; createdAt: string; updatedAt: string;
}
export interface AtlasRelation extends AtlasRecordBase {
  fromId: string; toId: string; label: string; description: string; symmetric: boolean; toChapter: number | null;
}
export interface AtlasState extends AtlasRecordBase { nodeId: string; summary: string; changes: Record<string, string> }
export type SaveAtlasRelation = Omit<AtlasRelation, 'id' | 'bookId' | 'version' | 'createdAt' | 'updatedAt' | 'needsReview'> & { expectedVersion?: number };
export type SaveAtlasState = Omit<AtlasState, 'id' | 'bookId' | 'version' | 'createdAt' | 'updatedAt' | 'needsReview'> & { expectedVersion?: number };
export interface AtlasView {
  bookId: string; version: number; positions: Record<string, { x: number; y: number }>;
  selectedNodeIds: string[]; branch: string; updatedAt: string;
}
export interface AtlasEvent { id: string; bookId: string; kind: 'relation' | 'state'; recordId: string; snapshot: AtlasRelation | AtlasState; createdAt: string }
export interface AtlasBundle { nodes: StoryEntry[]; relations: AtlasRelation[]; states: AtlasState[]; view: AtlasView; plans: PlanNode[]; voices: CharacterVoice[] }
