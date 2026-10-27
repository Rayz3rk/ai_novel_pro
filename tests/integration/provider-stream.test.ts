import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSettings } from '@shujian/contracts';
import { complete } from '../../apps/server/src/ai/provider.js';

const settings: ModelSettings = {
  id: 'stream-fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', hasApiKey: false,
  stream: true, temperature: 0.7, maxOutputTokens: 1024, contextWindow: 32768,
  inputPricePerMillion: null, outputPricePerMillion: null, taskBudget: null, dailyBudget: null,
};
const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const done = 'data: [DONE]\n\n';
const encode = (text: string) => new TextEncoder().encode(text);
function upstream(chunks: Uint8Array[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } })));
}
const run = (onText: (text: string) => void, signal = new AbortController().signal) => complete({
  settings, apiKey: '', messages: [{ role: 'user', content: 'fixture' }], signal, onText, onUsage: () => undefined,
});

afterEach(() => vi.unstubAllGlobals());

describe('stream batching and event loop responsiveness', () => {
  it('persists a batch of tiny frames in one callback without losing order', async () => {
    const text = '中文🙂'.repeat(100);
    upstream([encode([...text].map(frame).join('') + done)]);
    const onText = vi.fn();
    await run(onText);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith(text);
  });

  it('preserves the valid prefix when a later frame in the same batch is malformed', async () => {
    upstream([encode(frame('已收到的文字。') + 'data: {invalid}\n\n')]);
    const onText = vi.fn();
    await expect(run(onText)).rejects.toThrow('无法读取的数据');
    expect(onText).toHaveBeenCalledExactlyOnceWith('已收到的文字。');
  });

  it('decodes Chinese and emoji split across byte boundaries', async () => {
    const text = '雨停了🙂，伞还没找到。';
    const bytes = encode(frame(text) + done);
    upstream([...bytes].map((byte) => new Uint8Array([byte])));
    const onText = vi.fn();
    await run(onText);
    expect(onText.mock.calls.map(([value]) => value).join('')).toBe(text);
  });

  it('lets cancellation run between already buffered batches', async () => {
    upstream([...Array.from({ length: 100 }, () => encode(frame('甲'))), encode(done)]);
    const controller = new AbortController();
    const onText = vi.fn(() => { setImmediate(() => controller.abort()); });
    await expect(run(onText, controller.signal)).rejects.toThrow();
    expect(onText).toHaveBeenCalledExactlyOnceWith('甲');
  });

  it('keeps the full prefix when the provider reports the output limit', async () => {
    const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;
    upstream([encode(frame('上限前的文字。') + end + done)]);
    const onText = vi.fn();
    await expect(run(onText)).rejects.toThrow('输出上限');
    expect(onText).toHaveBeenCalledExactlyOnceWith('上限前的文字。');
  });
});
