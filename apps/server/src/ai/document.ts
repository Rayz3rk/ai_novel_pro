import { Schema, Fragment, Slice, type Node as PmNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import type { ManuscriptDocument, TextSelection } from '@shujian/contracts';
import { document as validateDocument } from '../validation.js';
import { AppError } from '../errors.js';

const attrs = { uid: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs },
    heading: { group: 'block', content: 'inline*', attrs: { ...attrs, level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+', attrs },
    bulletList: { group: 'block', content: 'listItem+' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, type: { default: null } } },
    listItem: { content: 'paragraph block*', attrs },
    codeBlock: { group: 'block', content: 'text*', marks: '', code: true, attrs: { ...attrs, language: { default: null } } },
    horizontalRule: { group: 'block' }, text: { group: 'inline' }, hardBreak: { group: 'inline', inline: true, selectable: false },
  },
  marks: {
    bold: {}, italic: {}, strike: {}, underline: {}, code: { excludes: '_' },
    link: { attrs: { href: {}, target: { default: null }, rel: { default: null }, class: { default: null } }, inclusive: false },
  },
});

function parse(document: ManuscriptDocument): PmNode {
  const result = schema.nodeFromJSON(document); result.check(); return result;
}
export function verifySelection(document: ManuscriptDocument, selection: TextSelection): void {
  const parsed = parse(document);
  if (selection.from < 0 || selection.to > parsed.content.size || parsed.textBetween(selection.from, selection.to, '\n', '\n') !== selection.text) {
    throw new AppError(409, 'SELECTION_CHANGED', '选中的文字与保存稿不一致，请重新选择后再试。');
  }
}
export function replaceSelection(document: ManuscriptDocument, selection: TextSelection, replacement: string): ManuscriptDocument {
  verifySelection(document, selection);
  const parsed = parse(document);
  const lines = replacement.replace(/\r\n?/g, '\n').split('\n');
  const inline = lines.length === 1;
  const fragment = inline
    ? Fragment.from(replacement ? schema.text(replacement) : [])
    : Fragment.fromArray(lines.map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null)));
  const transformed = new Transform(parsed).replaceRange(selection.from, selection.to, new Slice(fragment, inline ? 0 : 1, inline ? 0 : 1));
  const json: unknown = transformed.doc.toJSON();
  return validateDocument(json);
}
