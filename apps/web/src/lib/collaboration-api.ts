import type { AiJob, ApplyAiJobInput, ApplyAiJobResult, ChapterReview, CreateAiJobInput, ModelSettings, SaveStoryEntryInput, StoryEntry, StoryImpact, StoryProposal, StorySearchResult, UpdateModelSettings } from '@shujian/contracts';
import { request } from './api';

export interface EvidenceParagraph { paragraphId: string; text: string; hash: string }
export const collaborationApi = {
  model: () => request<{ settings: ModelSettings }>('/model'),
  connections: () => request<{ connections: ModelSettings[]; activeId: string }>('/models'),
  addConnection: (input: UpdateModelSettings) => request<{settings:ModelSettings}>('/models',input,'POST'),
  activateConnection: (id:string) => request<{settings:ModelSettings}>(`/models/${id}/activate`,{},'POST'),
  modelCatalog: (id:string) => request<{models:string[]}>(`/models/${id}/catalog`),
  saveModel: (input: UpdateModelSettings) => request<{ settings: ModelSettings }>('/model', input, 'PUT'),
  testModel: () => request<{ ok: boolean; message: string }>('/model/test', {}, 'POST'),
  jobs: (bookId: string) => request<{ jobs: AiJob[] }>(`/books/${bookId}/jobs`),
  chapterJobs: (chapterId:string) => request<{jobs:AiJob[]}>(`/chapters/${chapterId}/jobs`),
  job: (id: string) => request<{ job: AiJob }>(`/jobs/${id}`),
  createJob: (input: CreateAiJobInput) => request<{ job: AiJob }>('/jobs', input, 'POST'),
  cancelJob: (id: string) => request<{ job: AiJob }>(`/jobs/${id}/cancel`, {}, 'POST'),
  retryJob: (id: string) => request<{ job: AiJob }>(`/jobs/${id}/retry`, {}, 'POST'),
  applyJob: (id: string, input: ApplyAiJobInput) => request<ApplyAiJobResult>(`/jobs/${id}/apply`, input, 'POST'),
  story: (bookId: string, query = '') => request<StorySearchResult>(`/books/${bookId}/story${query}`),
  createStory: (bookId: string, input: SaveStoryEntryInput) => request<{ entry: StoryEntry }>(`/books/${bookId}/story`, input, 'POST'),
  updateStory: (id: string, input: SaveStoryEntryInput) => request<{ entry: StoryEntry }>(`/story/${id}`, input, 'PUT'),
  withdrawStory: (id: string, expectedVersion: number) => request<{ entry: StoryEntry }>(`/story/${id}/withdraw`, { expectedVersion }, 'POST'),
  proposals: (bookId: string) => request<{ proposals: StoryProposal[] }>(`/books/${bookId}/proposals`),
  acceptProposal: (id: string) => request<{ entry: StoryEntry; proposal: StoryProposal }>(`/proposals/${id}/accept`, {}, 'POST'),
  rejectProposal: (id: string) => request<{ proposal: StoryProposal }>(`/proposals/${id}/reject`, {}, 'POST'),
  reviews: (id: string) => request<{ reviews: ChapterReview[] }>(`/chapters/${id}/reviews`),
  impacts: (bookId: string) => request<{ impacts: StoryImpact[] }>(`/books/${bookId}/impacts`),
  evidence: (id: string) => request<{ revisionId: string | null; paragraphs: EvidenceParagraph[] }>(`/chapters/${id}/evidence`),
  history: (id: string) => request<{ events: Array<{ id: string; action: string; version: number; entry: StoryEntry; createdAt: string }> }>(`/story/${id}/history`),
};
