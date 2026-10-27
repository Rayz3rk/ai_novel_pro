import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('development API proxy selects the intended backend', () => {
  it('follows a custom backend PORT instead of a personal server on 4318', async () => {
    vi.stubEnv('PORT', '44321'); vi.stubEnv('NOVEL_API_TARGET', undefined);
    const config = (await import('../../apps/web/vite.config.js')).default;
    expect(config.server?.proxy?.['/api']).toEqual({ target: 'http://127.0.0.1:44321', changeOrigin: false });
  });
  it('honors an explicit API target without exposing credentials', async () => {
    vi.stubEnv('PORT', '44321'); vi.stubEnv('NOVEL_API_TARGET', 'http://127.0.0.1:44322');
    const config = (await import('../../apps/web/vite.config.js')).default;
    expect(config.server?.proxy?.['/api']).toEqual({ target: 'http://127.0.0.1:44322', changeOrigin: false });
  });
  it('rejects invalid ports and credential-bearing targets with a sanitized error', async () => {
    vi.stubEnv('PORT', '0'); vi.stubEnv('NOVEL_API_TARGET', undefined);
    await expect(import('../../apps/web/vite.config.js')).rejects.toThrow('PORT 必须');
    vi.resetModules(); vi.stubEnv('PORT', '44321'); vi.stubEnv('NOVEL_API_TARGET', 'http://user:fixture-secret@localhost:44322');
    await expect(import('../../apps/web/vite.config.js')).rejects.toThrow('不能包含账号或密码');
  });
});
