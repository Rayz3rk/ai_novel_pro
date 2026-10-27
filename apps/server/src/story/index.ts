import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../store.js';
import * as v from '../validation.js';
import { StoryService } from './service.js';
import { kinds } from './validation.js';

export { StoryService } from './service.js';
export type { StoryBackup, StoryEvent } from './service.js';

function param(request: FastifyRequest, key: string): string {
  return v.string(v.object(request.params)[key], '记录 ID', 128, 1);
}

export function registerStoryRoutes(app: FastifyInstance, store: Store): StoryService {
  const story = new StoryService(store);
  app.get('/api/books/:bookId/sources',async(request)=>({sources:story.searchSources(param(request,'bookId'),v.string(v.object(request.query).q??'','原文关键词',500))}));
  app.get('/api/books/:bookId/story', async (request) => {
    const query = v.object(request.query);
    const q = query.q === undefined ? undefined : v.string(query.q, '搜索内容', 500);
    const kind = query.kind === undefined || query.kind === '' ? undefined : v.string(query.kind, '资料类型', 30);
    if (kind && !kinds.includes(kind as typeof kinds[number])) v.invalid('资料类型不正确。');
    const chapterPosition = query.chapterPosition === undefined ? undefined : Number(query.chapterPosition);
    if (chapterPosition !== undefined) v.integer(chapterPosition, '章节位置', 1, 1_000_000);
    const pov = query.pov === undefined ? undefined : v.string(query.pov, '视角人物', 120);
    return story.search(param(request, 'bookId'), { q, kind, chapterPosition, pov, includeWithdrawn: query.includeWithdrawn === 'true' });
  });
  app.post('/api/books/:bookId/story', async (request, reply) => reply.code(201).send({ entry: story.saveEntry(param(request, 'bookId'), request.body) }));
  app.get('/api/story/:id', async (request) => ({ entry: story.getEntry(param(request, 'id')) }));
  app.put('/api/story/:id', async (request) => {
    const id = param(request, 'id'); return { entry: story.saveEntry(story.getEntry(id).bookId, request.body, id) };
  });
  app.post('/api/story/:id/withdraw', async (request) => ({ entry: story.withdrawEntry(param(request, 'id'), v.integer(v.object(request.body).expectedVersion, '资料版本', 1)) }));
  app.get('/api/story/:id/history', async (request) => ({ events: story.history(param(request, 'id')) }));
  app.get('/api/books/:bookId/proposals', async (request) => ({ proposals: story.listProposals(param(request, 'bookId')) }));
  app.post('/api/proposals/:id/accept', async (request) => ({ proposal: story.decideProposal(param(request, 'id'), true) }));
  app.post('/api/proposals/:id/reject', async (request) => ({ proposal: story.decideProposal(param(request, 'id'), false) }));
  app.get('/api/chapters/:id/reviews', async (request) => ({ reviews: story.listReviews(param(request, 'id')) }));
  app.get('/api/chapters/:id/evidence', async (request) => story.getEvidence(param(request, 'id')));
  app.get('/api/books/:bookId/impacts', async (request) => ({ impacts: story.impacts(param(request, 'bookId')) }));
  return story;
}
