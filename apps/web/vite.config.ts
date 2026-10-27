import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error('开发服务的 PORT 必须是 1 至 65535 之间的整数。');
const apiTarget = process.env.NOVEL_API_TARGET || `http://127.0.0.1:${backendPort}`;
try {
  const address = new URL(apiTarget);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('invalid');
} catch { throw new Error('NOVEL_API_TARGET 必须是有效的 HTTP(S) 地址，且不能包含账号或密码。'); }

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Keep browser Host and Origin aligned for the local API's source boundary.
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
