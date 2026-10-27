import type { ModelSettings } from '@shujian/contracts';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AppError } from '../errors.js';

export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface ProviderUsage { inputTokens: number | null; outputTokens: number | null }
export interface CompletionOptions {
  settings: ModelSettings; apiKey: string; messages: Message[]; signal: AbortSignal;
  onText: (text: string) => void; onUsage: (usage: ProviderUsage) => void;
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); this.name = 'ProviderError'; }
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const token = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function usage(value: unknown): ProviderUsage | null {
  const r = record(value); if (!r) return null;
  return { inputTokens: token(r.prompt_tokens ?? r.input_tokens), outputTokens: token(r.completion_tokens ?? r.output_tokens) };
}
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => { const r = record(part); return typeof r?.text === 'string' ? r.text : ''; }).join('');
  return '';
}

/** OpenAI-compatible endpoint; neither raw provider errors nor authorization are logged or returned. */
export async function complete(options: CompletionOptions): Promise<void> {
  const { settings, apiKey, messages, signal, onText, onUsage } = options;
  const endpoint = settings.baseUrl.endsWith('/chat/completions') ? settings.baseUrl : `${settings.baseUrl}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages, stream: settings.stream,
        ...(settings.sendTemperature===false?{}:{temperature:settings.temperature}),
        [settings.tokenParameter??'max_tokens']:settings.maxOutputTokens,
        ...(settings.stream && settings.includeStreamUsage!==false ? { stream_options: { include_usage: true } } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      redirect: 'error',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError('模型连接中断或等待超时，请检查模型地址与网络。', true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const hint = response.status === 401 || response.status === 403 ? '模型验证失败，请检查密钥和模型权限。'
      : response.status === 404 ? '模型地址或名称不存在，请检查兼容接口地址。'
        : response.status === 429 ? '模型服务限流或额度不足，请稍后重试。' : `模型服务返回错误（HTTP ${response.status}）。`;
    throw new ProviderError(hint, response.status === 429 || response.status >= 500, response.status);
  }
  if (!settings.stream) {
    let body: unknown;
    try { body = await response.json(); } catch { throw new ProviderError('模型返回了无法读取的结果。', false); }
    const r = record(body); const first = record(Array.isArray(r?.choices) ? r.choices[0] : null);
    const text = content(record(first?.message)?.content);
    if (!text.trim()) throw new ProviderError('模型未返回正文，请检查模型是否支持 Chat Completions。', false);
    if (text.length > 1_000_000) throw new AppError(413, 'OUTPUT_TOO_LARGE', '模型结果过长，已停止接收。请缩小生成范围。');
    onText(text); const u = usage(r?.usage); if (u) onUsage(u);
    if (first?.finish_reason === 'length') throw new ProviderError('模型达到输出上限，已保留收到的文字；请提高额度或缩小范围后重试。', false);
    return;
  }
  if (!response.body) throw new ProviderError('模型未提供流式响应。', false);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let total = 0; let terminal = false; let truncated = false; let pendingText = '';
  const flushText = () => { const text = pendingText; pendingText = ''; if (text) onText(text); };
  const event = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { terminal = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw new ProviderError('模型流中包含无法读取的数据，已保留收到的文字。', false); }
    const r = record(parsed); if (r?.error) throw new ProviderError('模型在生成过程中报告错误，已保留收到的文字。', true);
    const u = usage(r?.usage); if (u) onUsage(u);
    const first = record(Array.isArray(r?.choices) ? r.choices[0] : null);
    const text = content(record(first?.delta)?.content);
    if (text) { total += text.length; if (total > 1_000_000) throw new AppError(413, 'OUTPUT_TOO_LARGE', '模型结果过长，已停止接收。'); pendingText += text; }
    if (typeof first?.finish_reason === 'string') { terminal = true; truncated = first.finish_reason === 'length'; }
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000) throw new ProviderError('模型流格式异常，已停止接收。', false);
      // One durable callback per network packet, including valid text before a bad frame.
      try { for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer); if (!match || match.index === undefined) break;
        event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      } } finally { flushText(); }
      // A buffered upstream must not monopolize the loop with synchronous disk writes.
      await yieldToEventLoop();
    }
    try { buffer += decoder.decode(); if (buffer.trim()) event(buffer); } finally { flushText(); }
  } catch (error) {
    if (signal.aborted || error instanceof ProviderError || error instanceof AppError) throw error;
    throw new ProviderError('模型流意外断开，已保留收到的文字。', true);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!terminal) throw new ProviderError('模型流在结束标记前中断，已保留收到的文字。', true);
  if (!total) throw new ProviderError('模型未返回可用文字。', false);
  if (truncated) throw new ProviderError('模型达到输出上限，已保留收到的文字；请提高额度或缩小范围后重试。', false);
}
