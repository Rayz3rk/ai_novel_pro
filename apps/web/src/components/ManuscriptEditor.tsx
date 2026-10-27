import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import UniqueID from '@tiptap/extension-unique-id';
import { Bold, Italic, Heading2, Pilcrow, Quote, Undo2, Redo2 } from 'lucide-react';
import type { DocumentNode, ManuscriptDocument, TextSelection } from '@shujian/contracts';

interface Props { document: ManuscriptDocument; disabled: boolean; onChange: (document: ManuscriptDocument) => void; onComposition: (value: boolean) => void; onSelection?: (selection: TextSelection | null) => void; onSelectionAction?:(kind:'discuss'|'revise')=>void }

export function ManuscriptEditor({ document, disabled, onChange, onComposition, onSelection, onSelectionAction }: Props) {
  const onChangeRef = useRef(onChange);
  const replacing = useRef(false);
  onChangeRef.current = onChange;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, isAllowedUri: (url) => /^(https?:|mailto:|\/|#)/i.test(url) } }),
      Placeholder.configure({ placeholder: '从一句话开始，让故事慢慢展开……' }),
      UniqueID.configure({ types: ['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock'], attributeName: 'uid' }),
    ],
    content: document,
    editorProps: {
      attributes: { class: 'manuscript-prose', role: 'textbox', 'aria-label': '章节正文', 'aria-multiline': 'true', spellcheck: 'false' },
    },
    onUpdate: ({ editor: instance }) => {
      if (replacing.current) return;
      const json = instance.getJSON();
      onChangeRef.current({ type: 'doc', content: (json.content ?? []) as DocumentNode[] });
    },
  });
  useEffect(() => {
    if (!editor) return;
    replacing.current = true;
    try {
      if (JSON.stringify(editor.getJSON()) !== JSON.stringify(document)) editor.commands.setContent(document, { emitUpdate: false });
      editor.setEditable(!disabled, false);
    } finally { replacing.current = false; }
  }, [document, disabled, editor]);
  const [, refresh] = useStateCounter();
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      refresh();
      const { from, to } = editor.state.selection;
      if (from < to) onSelectionRef.current?.({ from, to, text: editor.state.doc.textBetween(from, to, '\n', '\n') });
      else if (editor.isFocused) onSelectionRef.current?.(null);
    };
    editor.on('selectionUpdate', update); editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor, refresh]);
  if (!editor) return <div className="editor-loading">正在展开稿纸……</div>;
  return <>
    <div className="editor-toolbar" aria-label="正文格式工具">
      <button type="button" className={`toolbar-button ${editor.isActive('paragraph') ? 'active' : ''}`} aria-label="正文段落" aria-pressed={editor.isActive('paragraph')} disabled={disabled} onClick={() => editor.chain().focus().setParagraph().run()}><Pilcrow size={17} /><span>正文</span></button>
      <span className="toolbar-divider" />
      <button type="button" className={`toolbar-button ${editor.isActive('bold') ? 'active' : ''}`} aria-label="加粗" aria-pressed={editor.isActive('bold')} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></button>
      <button type="button" className={`toolbar-button ${editor.isActive('italic') ? 'active' : ''}`} aria-label="斜体" aria-pressed={editor.isActive('italic')} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></button>
      <button type="button" className={`toolbar-button ${editor.isActive('heading') ? 'active' : ''}`} aria-label="小标题" aria-pressed={editor.isActive('heading')} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={18} /></button>
      <button type="button" className={`toolbar-button ${editor.isActive('blockquote') ? 'active' : ''}`} aria-label="引用" aria-pressed={editor.isActive('blockquote')} disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></button>
      <span className="toolbar-divider" />
      <button type="button" className="toolbar-button" aria-label="撤销" disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={17} /></button>
      <button type="button" className="toolbar-button" aria-label="重做" disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={17} /></button>
      <span className="toolbar-hint">⌘ / Ctrl + S 保存</span>
    </div>
    {onSelectionAction&&!editor.state.selection.empty&&<div className="selection-ai-tools"><span>对这段文字</span><button className="text-button" disabled={disabled} onMouseDown={(event)=>event.preventDefault()} onClick={()=>onSelectionAction('discuss')}>与 AI 讨论选区</button><button className="text-button" disabled={disabled} onMouseDown={(event)=>event.preventDefault()} onClick={()=>onSelectionAction('revise')}>请 AI 修改选区</button></div>}
    <div onCompositionStart={() => onComposition(true)} onCompositionEnd={() => onComposition(false)}><EditorContent editor={editor} /></div>
  </>;
}

function useStateCounter(): [number, () => void] {
  const [counter, setCounter] = useState(0);
  const increment = useCallback(() => setCounter((value) => value + 1), []);
  return [counter, increment];
}
