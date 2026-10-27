import { useCallback, useEffect, useRef, useState } from 'react';
import type { Book } from '@shujian/contracts';
import { api, errorMessage } from './lib/api';
import { Library } from './components/Library';
import { Workbench, type NavigationGuard } from './components/Workbench';

interface Route { bookId?: string; chapterId?: string }
function readRoute(): Route {
  const match = /^#\/books\/([^/]+)(?:\/chapters\/([^/]+))?$/.exec(window.location.hash);
  return match?.[1] ? { bookId: match[1], chapterId: match[2] } : {};
}
const routeUrl = (route: Route) => route.bookId ? `#/books/${route.bookId}${route.chapterId ? `/chapters/${route.chapterId}` : ''}` : '#';

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const guard = useRef<NavigationGuard>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const result = await api.books(); setBooks(result.books); setError(null); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (!route.bookId) void refresh(); }, [route.bookId, refresh]);
  const registerGuard = useCallback((next: NavigationGuard) => { guard.current = next; }, []);
  const navigate = useCallback(async (next: Route) => {
    await guard.current?.();
    setNavigationError(null);
    window.history.pushState(null, '', routeUrl(next));
    setRoute(next);
  }, []);
  useEffect(() => {
    const back = () => {
      const next = readRoute();
      void (async () => {
        try { await guard.current?.(); setRoute(next); setNavigationError(null); }
        catch (failure) { window.history.pushState(null, '', routeUrl(routeRef.current)); setNavigationError(errorMessage(failure)); }
      })();
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  return <>{navigationError && <div className="navigation-notice notice error" role="alert">{navigationError}<button className="text-button" onClick={() => setNavigationError(null)}>知道了</button></div>}{route.bookId ? <Workbench bookId={route.bookId} chapterId={route.chapterId} onBack={() => navigate({})} onSelect={(bookId, chapterId) => navigate({ bookId, chapterId })} registerGuard={registerGuard} /> : <Library books={books} loading={loading} error={error} onRefresh={refresh} onOpen={async (book) => { const result = await api.chapters(book.id); await navigate({ bookId: book.id, chapterId: result.chapters[0]?.id }); }} />}</>;
}
