import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/server/src/app.js';
import { migrateSqliteToPostgres, workspaceTables } from '../../apps/server/src/storage-migration.js';
import { Postgres } from '../../apps/server/src/postgres.js';
import { storageHarness } from './storage-harness.js';

const harness = storageHarness('migration');
const suite = process.env.NOVEL_TEST_POSTGRES === '1' ? describe : describe.skip;
suite('SQLite to native PostgreSQL full workspace migration', () => {
  it('preserves IDs, all backup sections, model tasks and final pointers; refuses a nonempty target', async () => {
    harness.reset(); if (harness.storage?.driver !== 'postgresql') throw new Error('PG fixture required');
    const directory = await mkdtemp(join(tmpdir(), 'shujian-migration-'));
    const options = { dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json') };
    const fixture = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text) as { messages: Array<{ content: string }> };
      const messages = input.messages.map((item) => item.content).join('\n');
      const output = messages.includes('检查此正文快照') ? '{"issues":[]}' : messages.includes('从本章冻结快照提取')
        ? JSON.stringify({ entries: [{ kind: 'event', authority: 'fact', title: '迁移事实', content: '已保存的校园正文🙂。', evidence: [{ paragraphId: 'source-p', quote: '已保存的校园正文🙂。' }] }] }) : '独立候选。';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
    let source: ReturnType<typeof createApp> | undefined = createApp(options);
    let destination: ReturnType<typeof createApp> | undefined;
    try {
      const api = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
        const result = await source!.inject({ method, url, ...(payload ? { payload } : {}) }); expect(result.statusCode, result.body).toBeLessThan(300); return result.json();
      };
      await source.ready();
      const { book } = await api('POST', '/api/books', { title: '迁移测试' });
      const { chapters } = await api('GET', `/api/books/${book.id}/chapters`);
      const { chapter } = await api('PUT', `/api/chapters/${chapters[0].id}/draft`, { expectedVersion: 1, title: '第一章', outline: '本章意图', document: { type: 'doc', content: [{ type: 'paragraph', attrs: { uid: 'source-p' }, content: [{ type: 'text', text: '已保存的校园正文🙂。' }] }] } });
      await api('POST', `/api/chapters/${chapter.id}/versions`, { expectedVersion: chapter.version, label: '中文留稿' });
      await api('POST', `/api/chapters/${chapter.id}/finalize`, { expectedVersion: chapter.version });
      await api('POST', `/api/books/${book.id}/plans`, { level: 'book', title: '全书方向', content: '未来计划', parentId: null, chapterId: null });
      await api('POST', `/api/books/${book.id}/story`, { kind: 'rule', authority: 'setting', title: '文风', content: '自然生活感' });
      const creative = await api('GET', `/api/books/${book.id}/creative`);
      const original = creative.skills[0];
      const { id: _id, bookId: _bookId, version: _version, hash: _hash, builtin: _builtin, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = original;
      const custom = await api('POST', `/api/books/${book.id}/skills`, { definition: { ...definition, name: 'migration-skill', title: '迁移技能' }, enabled: true, expectedVersion: 0 });
      await api('PUT', `/api/books/${book.id}/creative`, { ...creative.profile, expectedVersion: 0, style: { ...creative.profile.style, tone: '自然生活感' }, defaultSkillIds: { discuss: [custom.skill.id] }, voices: [{ id: randomUUID(), name: '甲', aliases: [], traits: '简短克制', example: '先把伞放好。' }] });
      await api('PUT', '/api/model', { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'migration-fixture', stream: false, temperature: 0.7, maxOutputTokens: 1024, contextWindow: 32768, inputPricePerMillion: null, outputPricePerMillion: null, taskBudget: null, dailyBudget: null, apiKey: 'migration-fixture-secret' });
      for (const kind of ['discuss', 'review', 'extract']) {
        let { job } = await api('POST', '/api/jobs', { requestId: randomUUID(), kind, chapterId: chapter.id, expectedVersion: chapter.version, instruction: '本机迁移测试。' });
        for (let count = 0; count < 300 && ['queued', 'running'].includes(job.status); count++) { await pause(10); job = (await api('GET', `/api/jobs/${job.id}`)).job; }
        expect(job.status, job.error).toBe('succeeded');
      }
      const proposals = (await api('GET', `/api/books/${book.id}/proposals`)).proposals;
      expect(proposals).toHaveLength(1); await api('POST', `/api/proposals/${proposals[0].id}/accept`, {});
      const person=(await api('POST',`/api/books/${book.id}/story`,{kind:'character',authority:'setting',title:'迁移人物',content:'档案',attributes:{identity:'学生'}})).entry;
      const item=(await api('POST',`/api/books/${book.id}/story`,{kind:'item',authority:'setting',title:'迁移道具',content:'档案'})).entry;
      await api('POST',`/api/books/${book.id}/atlas/relations`,{fromId:person.id,toId:item.id,label:'保管',symmetric:false,phase:'confirmed'});
      await api('POST',`/api/books/${book.id}/atlas/states`,{nodeId:item.id,summary:'状态变化',changes:{status:'完好'},phase:'confirmed'});
      await api('PUT',`/api/books/${book.id}/atlas/view`,{expectedVersion:0,positions:{[person.id]:{x:.3,y:.5}},selectedNodeIds:[person.id],branch:'主线'});
      const before = await api('GET', '/api/backup'); delete before.exportedAt;
      await source.close(); source = undefined;
      const report = await migrateSqliteToPostgres(join(options.dataDir, 'workspace.sqlite'), harness.storage.postgres, options);
      expect(report.tables.every((table) => table.identical)).toBe(true);
      destination = harness.createApp(options); await destination.ready();
      const after = (await destination.inject('/api/backup')).json(); delete after.exportedAt;
      expect(after).toEqual(before);
      expect((await destination.inject('/api/model')).json().settings.hasApiKey).toBe(true);
      await destination.close(); destination = undefined;
      await expect(migrateSqliteToPostgres(join(options.dataDir, 'workspace.sqlite'), harness.storage.postgres, options)).rejects.toThrow('Destination contains workspace data');
      destination = harness.createApp(options); await destination.ready();
      const preserved = (await destination.inject('/api/backup')).json(); delete preserved.exportedAt; expect(preserved).toEqual(before);
    } finally { await source?.close(); await destination?.close(); fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done())); }
  }, 30000);

  it('rolls back every copied table when a later foreign key is invalid', async () => {
    harness.reset(); if (harness.storage?.driver !== 'postgresql') throw new Error('PG fixture required');
    const directory = await mkdtemp(join(tmpdir(), 'shujian-migration-rollback-'));
    const options = { dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json') };
    const source = createApp(options); await source.ready();
    await source.inject({ method: 'POST', url: '/api/books', payload: { title: '必须回滚的作品' } }); await source.close();
    const file = join(options.dataDir, 'workspace.sqlite'); const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys=OFF');
    raw.prepare('INSERT INTO story_entries(id,book_id,payload,status,updated_at) VALUES(?,?,?,?,?)').run('orphan', 'missing-book', '{}', 'confirmed', '2026-10-26T00:00:00.000Z'); raw.close();
    await expect(migrateSqliteToPostgres(file, harness.storage.postgres, options)).rejects.toThrow();
    const target = new Postgres(harness.storage.postgres);
    try { for (const table of workspaceTables) expect((target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count).toBe(0); } finally { target.close(); }
  }, 30000);
  it.each([16,20])('upgrades a stopped %i-table SQLite workspace while preserving its IDs', async (oldTables) => {
    harness.reset(); if (harness.storage?.driver !== 'postgresql') throw new Error('PG fixture required');
    const directory = await mkdtemp(join(tmpdir(), 'shujian-migration-legacy-'));
    const options = { dataDir: join(directory, 'data'), credentialDir: join(directory, 'credentials'), connectionsFile: join(directory, 'connections.json') };
    const source = createApp(options); await source.ready();
    const result = await source.inject({ method: 'POST', url: '/api/books', payload: { title: '旧版本工作区' } }); const id = result.json().book.id;
    await source.close(); const file = join(options.dataDir, 'workspace.sqlite'); const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE atlas_events; DROP TABLE atlas_views; DROP TABLE atlas_states; DROP TABLE atlas_relations');
    if(oldTables===16)raw.exec('DROP TABLE creative_skill_history; DROP TABLE creative_skills; DROP TABLE creative_profile_history; DROP TABLE creative_profiles'); raw.close();
    const report = await migrateSqliteToPostgres(file, harness.storage.postgres, options);
    expect(report.tables).toHaveLength(workspaceTables.length); expect(report.tables.filter((row) => row.name.startsWith('creative_')).every((row) => row.rows === 0 && row.identical)).toBe(true);
    const destination = harness.createApp(options); try { await destination.ready(); expect((await destination.inject(`/api/books/${id}/creative`)).json().profile.version).toBe(0); } finally { await destination.close(); }
  }, 30000);
});
