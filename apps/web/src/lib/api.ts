import type { ApiErrorBody, Book, Chapter, ChapterSummary, CreateBookInput, DocumentRevision, RevisionSummary, SaveDraftInput, StorageInfo, UpdateBookInput, WorkspaceBackup } from '@shujian/contracts';

export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly currentVersion?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('暂时无法连接本地服务。未保存的文字仍显示在编辑器中，请保持页面打开并重试。', 'NETWORK_ERROR', 0);
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as ApiErrorBody | null;
    throw new ApiError(failure?.error?.message ?? `请求失败（${response.status}）`, failure?.error?.code ?? 'REQUEST_FAILED', response.status, failure?.error?.currentVersion);
  }
  return response.json() as Promise<T>;
}

export const api = {
  storage: () => request<{ storage: StorageInfo }>('/storage'),
  selectStorage: (driver: StorageInfo['driver']) => request<{ storage: StorageInfo }>('/storage/preference', { driver }, 'PUT'),
  books: () => request<{ books: Book[] }>('/books'),
  createBook: (input: CreateBookInput) => request<{ book: Book }>('/books', input, 'POST'),
  book: (id: string) => request<{ book: Book }>(`/books/${id}`),
  updateBook: (id: string, input: UpdateBookInput) => request<{ book: Book }>(`/books/${id}`, input, 'PATCH'),
  chapters: (bookId: string) => request<{ chapters: ChapterSummary[] }>(`/books/${bookId}/chapters`),
  createChapter: (bookId: string) => request<{ chapter: Chapter }>(`/books/${bookId}/chapters`, {}, 'POST'),
  chapter: (id: string) => request<{ chapter: Chapter }>(`/chapters/${id}`),
  saveDraft: (id: string, input: SaveDraftInput) => request<{ chapter: Chapter }>(`/chapters/${id}/draft`, input, 'PUT'),
  versions: (id: string) => request<{ versions: RevisionSummary[] }>(`/chapters/${id}/versions`),
  version: (id: string, revisionId: string) => request<{ version: DocumentRevision }>(`/chapters/${id}/versions/${revisionId}`),
  checkpoint: (id: string, expectedVersion: number, label?: string) => request<{ version: DocumentRevision }>(`/chapters/${id}/versions`, { expectedVersion, label }, 'POST'),
  restore: (id: string, expectedVersion: number, revisionId: string) => request<{ chapter: Chapter }>(`/chapters/${id}/restore`, { expectedVersion, revisionId }, 'POST'),
  finalize: (id: string, expectedVersion: number, proposalIds?:string[]) => request<{ chapter: Chapter }>(`/chapters/${id}/finalize`, { expectedVersion,...(proposalIds?{proposalIds}:{}) }, 'POST'),
  restoreBackup: (backup: WorkspaceBackup) => request<{ books: Book[] }>('/backup/restore', { backup }, 'POST'),
  importText: (filename: string, text: string) => request<{ book: Book; chapters: ChapterSummary[] }>('/import', { filename, text }, 'POST'),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}

export async function downloadUrl(path: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(path).catch(() => { throw new Error('下载失败，请检查本地服务连接后重试。'); });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorBody | null;
    throw new Error(body?.error?.message ?? '下载失败，请重试。');
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let filename = fallbackFilename;
  if (encoded) { try { filename = decodeURIComponent(encoded); } catch { /* Use safe fallback. */ } }
  downloadBlob(await response.blob(), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }), filename);
}
