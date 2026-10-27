import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}

export function Dialog({ title, subtitle, children, onClose, wide, busy }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => { ref.current?.close(); }; }, []);
  return (
    <dialog ref={ref} aria-label={title} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="dialog-head">
        <div><span className="eyebrow">书间 · 创作空间</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="icon-button" aria-label="关闭窗口" onClick={onClose} disabled={busy}><X size={20} /></button>
      </div>
      {children}
    </dialog>
  );
}
