import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

function rejected(): never {
  throw new AppError(403, 'LOCAL_REQUEST_REQUIRED', '本地服务只接受书间本机页面的请求，请从本机地址重新打开书间。');
}

function authority(value: unknown): URL {
  if (typeof value !== 'string' || !value || /[\s\\/@?#]/.test(value)) return rejected();
  let parsed: URL;
  try { parsed = new URL(`http://${value}`); } catch { return rejected(); }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'localhost' && hostname !== 'localhost.' && hostname !== '[::1]' && !/^127(?:\.\d{1,3}){3}$/.test(hostname)) return rejected();
  return parsed;
}

/** Stop rebinding/cross-site browser requests before they can read or mutate local state. */
export function assertLocalRequest(request: FastifyRequest): void {
  const host = authority(request.headers.host);
  const path = request.url.split('?')[0] ?? '/';
  const publicNavigation = ['GET', 'HEAD'].includes(request.method) && path !== '/api' && !path.startsWith('/api/')
    && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
  if (request.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation) return rejected();
  const rawOrigin = request.headers.origin;
  // Non-browser clients and normal same-origin GETs need not send Origin.
  if (rawOrigin === undefined) return;
  if (typeof rawOrigin !== 'string' || rawOrigin === 'null') return rejected();
  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { return rejected(); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return rejected();
  const expected = `${request.protocol}://${host.host}`;
  if (origin.origin !== expected) return rejected();
}
