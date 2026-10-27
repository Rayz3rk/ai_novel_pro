import { randomUUID } from 'node:crypto';
import type { DocumentNode, ManuscriptDocument } from '@shujian/contracts';

/** Anchors are persisted with prose, including programmatic imports and AI adoption. */
export function withParagraphIds(document: ManuscriptDocument): ManuscriptDocument {
  const seen = new Set<string>();
  const visit = (node: DocumentNode): DocumentNode => {
    let attrs = node.attrs;
    if (['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock'].includes(node.type)) {
      let uid = typeof attrs?.uid === 'string' ? attrs.uid : '';
      if (!uid || seen.has(uid)) uid = randomUUID();
      seen.add(uid);
      attrs = { ...attrs, uid };
    }
    return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(visit) } : {}) };
  };
  return { type: 'doc', content: document.content.map(visit) };
}
