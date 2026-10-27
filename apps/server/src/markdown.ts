import type { DocumentNode, ManuscriptDocument } from '@shujian/contracts';

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]<>~]/g, '\\$&');
}

function inline(node: DocumentNode): string {
  if (node.type === 'hardBreak') return '  \n';
  if (node.type !== 'text') return (node.content ?? []).map(inline).join('');
  const raw = node.text ?? '';
  if (node.marks?.some((mark) => mark.type === 'code')) {
    const runs = raw.match(/`+/g) ?? [];
    const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 1));
    const padding = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
    return `${fence}${padding}${raw}${padding}${fence}`;
  }
  let result = escape(raw);
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') result = `**${result}**`;
    if (mark.type === 'italic') result = `*${result}*`;
    if (mark.type === 'strike') result = `~~${result}~~`;
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      const href = encodeURI(mark.attrs.href).replace(/[<>]/g, (character) => character === '<' ? '%3C' : '%3E');
      result = `[${result}](<${href}>)`;
    }
    // Markdown has no native underline syntax. Text remains intact; backup keeps the original mark.
  }
  return result;
}

function block(node: DocumentNode): string {
  const children = node.content ?? [];
  if (node.type === 'paragraph') return children.map(inline).join('');
  if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${children.map(inline).join('')}`;
  if (node.type === 'horizontalRule') return '---';
  if (node.type === 'blockquote') return children.map(block).join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
  if (node.type === 'codeBlock') {
    const text = children.map((child) => child.text ?? '').join('');
    const runs = text.match(/`+/g) ?? [];
    const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
    const language = typeof node.attrs?.language === 'string' ? node.attrs.language.replace(/[^\w+-]/g, '') : '';
    return `${fence}${language}\n${text}\n${fence}`;
  }
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const start = Number(node.attrs?.start ?? 1);
    return children.map((item, index) => {
      const marker = node.type === 'orderedList' ? `${start + index}. ` : '- ';
      const text = block(item);
      return marker + text.replace(/\n/g, `\n${' '.repeat(marker.length)}`);
    }).join('\n');
  }
  if (node.type === 'listItem') return children.map(block).join('\n\n');
  return children.map(block).join('\n\n');
}

export function documentToMarkdown(document: ManuscriptDocument): string {
  return document.content.map(block).join('\n\n');
}

export function markdownHeading(title: string): string {
  return escape(title.replace(/[\r\n]+/g, ' '));
}
