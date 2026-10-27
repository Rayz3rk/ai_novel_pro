import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('书间需要 Node.js 24 或更新版本。Windows 用户可以运行 start-dev.bat 自动选用本机可用运行时。');
  process.exit(1);
}
const backendPort = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
  console.error('开发服务的 PORT 必须是 1 至 65535 之间的整数。');
  process.exit(1);
}
const apiTarget = process.env.NOVEL_API_TARGET || `http://127.0.0.1:${backendPort}`;
try {
  const address = new URL(apiTarget);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('invalid');
} catch {
  console.error('NOVEL_API_TARGET 必须是有效的 HTTP(S) 地址，且不能包含账号或密码。');
  process.exit(1);
}

const entries = [
  { script: resolve(root, 'apps/server/node_modules/tsx/dist/cli.mjs'), args: ['watch', 'src/main.ts'], cwd: resolve(root, 'apps/server') },
  { script: resolve(root, 'apps/web/node_modules/vite/bin/vite.js'), args: [], cwd: resolve(root, 'apps/web') },
];
if (entries.some((entry) => !existsSync(entry.script))) {
  console.error('依赖尚未安装，请先运行 pnpm install，或使用 start-dev.bat。');
  process.exit(1);
}

const children = entries.map((entry) => spawn(process.execPath, [entry.script, ...entry.args], {
  cwd: entry.cwd, env: { ...process.env, PORT: String(backendPort), NOVEL_API_TARGET: apiTarget }, stdio: 'inherit', windowsHide: true,
}));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
children.forEach((child) => {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
