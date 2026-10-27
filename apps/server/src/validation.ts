import {
  countWords, documentToText,
  type Book, type Chapter, type CreateBookInput, type DocumentNode, type DocumentRevision,
  type JsonValue, type ManuscriptDocument, type SaveDraftInput, type UpdateBookInput,
  type WorkspaceBackup,
} from '@shujian/contracts';
import { AppError } from './errors.js';

const NODE_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'hardBreak', 'text', 'codeBlock', 'horizontalRule']);
const MARK_TYPES = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link']);
const INLINE_TYPES = new Set(['text', 'hardBreak']);
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule']);
const ATTRIBUTES: Record<string, Set<string>> = {
  paragraph: new Set(['uid']), heading: new Set(['uid', 'level']), blockquote: new Set(['uid']),
  listItem: new Set(['uid']), codeBlock: new Set(['uid', 'language']),
  bulletList: new Set(), orderedList: new Set(['start', 'type']),
  text: new Set(), hardBreak: new Set(), horizontalRule: new Set(),
};
const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_TEXT_LENGTH = 1_000_000;

export function invalid(message: string): never {
  throw new AppError(400, 'VALIDATION_ERROR', message);
}

export function object(value: unknown, label = '请求'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label}格式不正确。`);
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string, max = 500, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min) invalid(`${label}应为 ${min}–${max} 个字符的文本。`);
  return value;
}

export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}超出允许范围。`);
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${label}格式不正确或数量过多。`);
  return value;
}

function json(value: unknown, depth = 0): JsonValue {
  if (depth > 5) invalid('正文属性嵌套过深。');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return string(value, '正文属性', 2_000);
  if (Array.isArray(value)) return array(value, '正文属性', 50).map((item) => json(item, depth + 1));
  const item = object(value, '正文属性');
  if (Object.keys(item).length > 30) invalid('正文属性过多。');
  const out: Record<string, JsonValue> = {};
  for (const [key, val] of Object.entries(item)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('正文属性名称不合法。');
    out[string(key, '正文属性名', 50)] = json(val, depth + 1);
  }
  return out;
}

export function document(value: unknown): ManuscriptDocument {
  const doc = object(value, '正文');
  if (doc.type !== 'doc') invalid('正文根节点必须为 doc。');
  if (Object.keys(doc).some((key) => !['type', 'content'].includes(key))) invalid('正文根节点包含不支持的字段。');
  let count = 0;
  let textLength = 0;
  const node = (raw: unknown, depth: number): DocumentNode => {
    count++;
    if (depth > 12 || count > 20_000) invalid('正文结构过于复杂。');
    const item = object(raw, '正文节点');
    if (Object.keys(item).some((key) => !['type', 'text', 'attrs', 'marks', 'content'].includes(key))) invalid('正文节点包含不支持的字段。');
    const type = string(item.type, '节点类型', 30, 1);
    if (!NODE_TYPES.has(type)) invalid(`不支持的正文节点：${type}`);
    const parsed: DocumentNode = { type };
    if (item.text !== undefined) {
      if (type !== 'text') invalid('只有文本节点可直接包含文字。');
      parsed.text = string(item.text, '正文文字', MAX_TEXT_LENGTH);
      if (parsed.text.length === 0) invalid('文本节点不能为空。');
      textLength += parsed.text.length;
      if (textLength > MAX_TEXT_LENGTH) invalid('单章正文过长。');
    }
    if (type === 'text' && (item.text === undefined || item.content !== undefined)) invalid('文本节点格式不正确。');
    if (item.attrs !== undefined) {
      const attrs = object(item.attrs, '节点属性');
      if (Object.keys(attrs).some((key) => !ATTRIBUTES[type]?.has(key))) invalid(`节点 ${type} 包含不支持的属性。`);
      if (attrs.uid !== undefined && attrs.uid !== null) string(attrs.uid, '段落标识', 128, 1);
      if (attrs.level !== undefined) integer(attrs.level, '标题级别', 1, 6);
      if (attrs.start !== undefined) integer(attrs.start, '列表起始序号', 1, 1_000_000_000);
      if (attrs.language !== undefined && attrs.language !== null) string(attrs.language, '代码语言', 80);
      if (attrs.type !== undefined && attrs.type !== null) string(attrs.type, '列表样式', 10);
      parsed.attrs = json(attrs) as Record<string, JsonValue>;
    }
    if (item.marks !== undefined) {
      if (!INLINE_TYPES.has(type)) invalid('文字样式只能作用于行内节点。');
      parsed.marks = array(item.marks, '文字样式', 10).map((rawMark) => {
        const mark = object(rawMark, '文字样式');
        if (Object.keys(mark).some((key) => !['type', 'attrs'].includes(key))) invalid('文字样式包含不支持的字段。');
        const markType = string(mark.type, '样式类型', 30, 1);
        if (!MARK_TYPES.has(markType)) invalid('正文含不支持的文字样式。');
        const attrs = mark.attrs === undefined ? undefined : json(object(mark.attrs, '样式属性')) as Record<string, JsonValue>;
        if (attrs && Object.keys(attrs).some((key) => markType !== 'link' || !['href', 'target', 'rel', 'class'].includes(key))) invalid('文字样式包含不支持的属性。');
        if (attrs) for (const [key, val] of Object.entries(attrs)) if (val !== null) string(val, `链接 ${key}`, 2_000);
        if (markType === 'link' && attrs?.href !== undefined) {
          const href = string(attrs.href, '链接地址', 2_000);
          if (!/^(https?:|mailto:|\/|#)/i.test(href)) invalid('链接仅支持 http、https、mailto 或站内地址。');
        }
        return { type: markType, ...(attrs ? { attrs } : {}) };
      });
      const markNames = parsed.marks.map((mark) => mark.type);
      if (new Set(markNames).size !== markNames.length || (markNames.includes('code') && markNames.length > 1)) invalid('文字样式组合不正确。');
    }
    if (item.content !== undefined) {
      if (['text', 'hardBreak', 'horizontalRule'].includes(type)) invalid('叶子节点不能包含子节点。');
      parsed.content = array(item.content, '正文节点', 20_000).map((child) => node(child, depth + 1));
    }
    const children = parsed.content ?? [];
    if (['paragraph', 'heading'].includes(type) && children.some((child) => !INLINE_TYPES.has(child.type))) invalid('段落和标题只能包含文字或换行。');
    if (type === 'codeBlock' && children.some((child) => child.type !== 'text' || (child.marks?.length ?? 0) > 0)) invalid('代码块只能包含无样式文字。');
    if (type === 'blockquote' && (children.length === 0 || children.some((child) => !BLOCK_TYPES.has(child.type)))) invalid('引用块应包含一个或多个段落。');
    if (['bulletList', 'orderedList'].includes(type) && (children.length === 0 || children.some((child) => child.type !== 'listItem'))) invalid('列表应由列表项组成。');
    if (type === 'listItem' && (children[0]?.type !== 'paragraph' || children.some((child) => !BLOCK_TYPES.has(child.type)))) invalid('列表项应以段落开头。');
    return parsed;
  };
  const content = array(doc.content, '正文段落', 20_000).map((item) => node(item, 1));
  if (content.length === 0 || content.some((item) => !BLOCK_TYPES.has(item.type))) invalid('正文顶层应由一个或多个段落等块节点组成。');
  const parsed: ManuscriptDocument = { type: 'doc', content };
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_DOCUMENT_BYTES) invalid('单章正文过大，请拆成多个章节。');
  return parsed;
}

export function createBook(value: unknown): CreateBookInput {
  const item = object(value);
  const result: CreateBookInput = { title: string(item.title, '作品名', 120, 1).trim() };
  if (item.genre !== undefined) result.genre = string(item.genre, '题材', 60);
  if (item.premise !== undefined) result.premise = string(item.premise, '作品设想', 20_000);
  if (item.targetWords !== undefined) result.targetWords = integer(item.targetWords, '目标字数', 0, 100_000_000);
  if (item.accent !== undefined) {
    const accent = string(item.accent, '封面颜色', 7);
    if (!/^#[0-9a-f]{6}$/i.test(accent)) invalid('封面颜色应为六位十六进制颜色。');
    result.accent = accent;
  }
  return result;
}

export function updateBook(value: unknown): UpdateBookInput {
  const item = object(value);
  const validated = createBook({ title: item.title ?? '_', ...item });
  if (item.title === undefined) delete (validated as UpdateBookInput).title;
  return validated;
}

export function saveDraft(value: unknown): SaveDraftInput {
  const item = object(value);
  return {
    expectedVersion: integer(item.expectedVersion, '草稿版本', 1),
    title: string(item.title, '章节标题', 200),
    outline: string(item.outline, '本章计划', 20_000),
    document: document(item.document),
  };
}

function date(value: unknown, label: string): string {
  const result = string(value, label, 40, 1);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label}不是有效时间。`);
  return result;
}

function id(value: unknown): string { return string(value, '记录 ID', 128, 1); }

function bookRecord(value: unknown): Book {
  const item = object(value, '备份作品');
  const fields = createBook(item);
  return {
    id: id(item.id), title: fields.title, genre: fields.genre ?? '', premise: fields.premise ?? '',
    targetWords: fields.targetWords ?? 0, accent: fields.accent ?? '#244a42',
    chapterCount: integer(item.chapterCount, '章节数量', 0, 10_000),
    wordCount: integer(item.wordCount, '作品字数', 0),
    createdAt: date(item.createdAt, '创建时间'), updatedAt: date(item.updatedAt, '更新时间'),
  };
}

function chapterRecord(value: unknown): Chapter {
  const item = object(value, '备份章节');
  const content = document(item.document);
  const text = documentToText(content);
  if (item.plainText !== text || item.wordCount !== countWords(text)) invalid('备份中的正文或字数与文档不一致。');
  if (!['draft', 'final', 'revising'].includes(String(item.status))) invalid('章节状态不正确。');
  return {
    id: id(item.id), bookId: id(item.bookId), position: integer(item.position, '章节序号', 1, 100_000),
    title: string(item.title, '章节标题', 200), outline: string(item.outline, '本章计划', 20_000),
    status: item.status as Chapter['status'], wordCount: countWords(text), version: integer(item.version, '草稿版本', 1),
    finalizedRevisionId: item.finalizedRevisionId === null ? null : id(item.finalizedRevisionId),
    document: content, plainText: text, createdAt: date(item.createdAt, '创建时间'), updatedAt: date(item.updatedAt, '更新时间'),
  };
}

function revisionRecord(value: unknown): DocumentRevision {
  const item = object(value, '备份版本');
  const content = document(item.document);
  const text = documentToText(content);
  if (item.plainText !== text || item.wordCount !== countWords(text)) invalid('备份版本的正文或字数与文档不一致。');
  if (!['checkpoint', 'final', 'before_restore'].includes(String(item.kind))) invalid('版本种类不正确。');
  return {
    id: id(item.id), chapterId: id(item.chapterId), label: string(item.label, '版本名称', 120),
    kind: item.kind as DocumentRevision['kind'], sourceVersion: integer(item.sourceVersion, '源版本', 1),
    title: string(item.title, '章节标题', 200), outline: string(item.outline, '本章计划', 20_000),
    document: content, plainText: text, wordCount: countWords(text), createdAt: date(item.createdAt, '创建时间'),
  };
}

export function backup(value: unknown): WorkspaceBackup {
  const item = object(value, '备份');
  if (item.format !== 'shujian-backup' || item.version !== 1) invalid('不是支持的书间备份文件。');
  const ids = new Set<string>();
  const unique = (recordId: string): void => {
    if (ids.has(recordId)) invalid('备份包含重复的记录 ID。');
    ids.add(recordId);
  };
  let chapterCount = 0;
  let revisionCount = 0;
  const books = array(item.books, '作品', 200).map((rawBook) => {
    const entry = object(rawBook, '备份作品');
    const book = bookRecord(entry.book);
    unique(book.id);
    const positions = new Set<number>();
    const chapters = array(entry.chapters, '章节', 10_000).map((rawChapter) => {
      if (++chapterCount > 10_000) invalid('备份章节数量过多。');
      const chapterEntry = object(rawChapter, '备份章节');
      const chapter = chapterRecord(chapterEntry.chapter);
      unique(chapter.id);
      if (chapter.bookId !== book.id || positions.has(chapter.position)) invalid('备份章节的作品关系或序号不正确。');
      positions.add(chapter.position);
      const finalVersions = new Set<number>();
      const revisions = array(chapterEntry.revisions, '章节版本', 50_000).map((rawRevision) => {
        if (++revisionCount > 50_000) invalid('备份版本数量过多。');
        const revision = revisionRecord(rawRevision);
        unique(revision.id);
        if (revision.chapterId !== chapter.id || revision.sourceVersion > chapter.version) invalid('备份版本的章节关系或源版本不正确。');
        if (revision.kind === 'final') {
          if (finalVersions.has(revision.sourceVersion)) invalid('同一草稿版本不能包含重复定稿。');
          finalVersions.add(revision.sourceVersion);
        }
        return revision;
      });
      if (chapter.finalizedRevisionId !== null && !revisions.some((revision) => revision.id === chapter.finalizedRevisionId && revision.kind === 'final')) invalid('备份缺少对应定稿版本。');
      if (chapter.finalizedRevisionId === null && chapter.status !== 'draft') invalid('备份定稿状态不一致。');
      if (chapter.finalizedRevisionId !== null) {
        const final = revisions.find((revision) => revision.id === chapter.finalizedRevisionId)!;
        const expectedStatus = final.title === chapter.title && final.outline === chapter.outline && JSON.stringify(final.document) === JSON.stringify(chapter.document) ? 'final' : 'revising';
        if (chapter.status !== expectedStatus) invalid('备份中的章节状态与定稿正文不一致。');
      }
      return { chapter, revisions };
    });
    if (book.chapterCount !== chapters.length || book.wordCount !== chapters.reduce((sum, entry) => sum + entry.chapter.wordCount, 0)) invalid('备份中的作品统计与章节不一致。');
    let extensions: Record<string, import('@shujian/contracts').JsonValue> | undefined;
    if (entry.extensions !== undefined) {
      const raw = object(entry.extensions, '扩展备份');
      if (Object.keys(raw).some((key) => !['ai', 'story', 'planning', 'creative', 'atlas'].includes(key))) invalid('备份包含当前版本不支持的扩展数据。');
      extensions = raw as Record<string, import('@shujian/contracts').JsonValue>;
    }
    return { book, chapters, ...(extensions ? { extensions } : {}) };
  });
  return { format: 'shujian-backup', version: 1, exportedAt: date(item.exportedAt, '备份时间'), books };
}
