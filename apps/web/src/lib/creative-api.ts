import type { AiJob, CleanReport, ContextPreview, CreateAiJobInput, CreativeEvaluationSample, CreativeProfile, CreativeSkill, SaveCreativeProfile, SkillDefinition } from '@shujian/contracts';
import { request } from './api';

export const creativeApi = {
  data: (bookId: string) => request<{ profile: CreativeProfile; skills: CreativeSkill[] }>(`/books/${bookId}/creative`),
  saveProfile: (bookId: string, profile: SaveCreativeProfile) => request<{ profile: CreativeProfile }>(`/books/${bookId}/creative`, profile, 'PUT'),
  profileHistory: (bookId: string) => request<{ profiles: CreativeProfile[] }>(`/books/${bookId}/creative/history`),
  saveSkill: (bookId: string, definition: SkillDefinition, enabled: boolean, expectedVersion: number, id?: string) => request<{ skill: CreativeSkill }>(`/books/${bookId}/skills${id ? `/${id}` : ''}`, { definition, enabled, expectedVersion }, id ? 'PUT' : 'POST'),
  importSkill: (bookId: string, input: unknown) => request<{ skill: CreativeSkill }>(`/books/${bookId}/skills/import`, input, 'POST'),
  exportSkill: (bookId: string, id: string) => request<{ format: string; version: number; definition: SkillDefinition }>(`/books/${bookId}/skills/${id}/export`),
  skillHistory: (bookId: string, id: string) => request<{ skills: CreativeSkill[] }>(`/books/${bookId}/skills/${id}/history`),
  preview: (input: CreateAiJobInput) => request<{ preview: ContextPreview }>('/jobs/preview', input, 'POST'),
  clean: (id: string) => request<CleanReport>(`/chapters/${id}/clean-check`),
  evaluationSample: (job: AiJob) => request<CreativeEvaluationSample>(`/jobs/${job.id}/evaluation-sample`),
};
