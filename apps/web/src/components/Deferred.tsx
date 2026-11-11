import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';

class LoadBoundary extends Component<{ children: ReactNode; retry: () => void }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: errorMessage(error) }; }
  render() {
    return this.state.error ? <div className="notice error deferred-state" role="alert"><p>暂时没能打开此功能，当前稿件仍保留。</p><button className="button secondary" onClick={this.props.retry}>重试加载</button></div> : this.props.children;
  }
}

/** Recreate React.lazy on retry; never reload the page and lose an unsaved editor. */
export function deferred<P extends object>(load: () => Promise<(props: P) => ReactNode>) {
  return function Deferred(props: P) {
    const [attempt, setAttempt] = useState(0);
    const Loaded = useMemo(() => lazy(async () => ({ default: await load() })), [attempt]);
    return <LoadBoundary key={attempt} retry={() => setAttempt(value => value + 1)}><Suspense fallback={<div className="deferred-state" role="status">正在打开…</div>}><Loaded {...props} /></Suspense></LoadBoundary>;
  };
}
