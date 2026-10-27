import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = metadata.version;
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前发布任务需要在 Windows x64 上运行。');
const node = process.env.NOVEL_RELEASE_NODE ?? process.execPath;
const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', windowsHide: true }));
if (Number(runtime.version.split('.')[0]) < 24 || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new Error('发布运行环境必须为 Windows x64 Node.js 24 或更新版本。');
const license = join(root, `scripts/release-resources/node-v${runtime.version}-LICENSE.txt`);
if (!existsSync(license)) throw new Error('缺少与打包运行时完全对应的 Node.js 许可文件，请先补齐。');
const pnpm = process.env.npm_execpath;
if (!pnpm || !pnpm.toLowerCase().includes('pnpm')) throw new Error('请从项目根目录使用 pnpm release 运行发布构建。');
async function command(args) {
  await new Promise((done, reject) => {
    const process = spawn(node, [pnpm, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    process.once('error', reject); process.once('exit', (code) => code === 0 ? done() : reject(new Error(`发布步骤未完成，退出码 ${code}`)));
  });
}
if (!process.argv.includes('--skip-build')) await command(['build']);
const workParent = join(root, 'test-results/release-build'); await mkdir(workParent, { recursive: true });
const work = await mkdtemp(join(workParent, 'build-')); const stage = join(work, `shujian-${version}-windows-x64`);
await mkdir(dirname(join(stage, 'apps/server')), { recursive: true });
// pnpm 11 legacy deploy changes this generated source-workspace state even though deployment is isolated.
const stateFile = join(root, 'node_modules/.pnpm-workspace-state-v1.json');
const oldState = existsSync(stateFile) ? await readFile(stateFile) : null;
const oldLock = await readFile(join(root, 'pnpm-lock.yaml'));
try { await command(['--filter', '@shujian/server', 'deploy', '--prod', '--legacy', join(stage, 'apps/server')]); }
finally {
  if (oldState) await writeFile(stateFile, oldState);
  if (!(await readFile(join(root, 'pnpm-lock.yaml'))).equals(oldLock)) await writeFile(join(root, 'pnpm-lock.yaml'), oldLock);
}
await mkdir(join(stage, '.runtime'), { recursive: true });
await cp(node, join(stage, '.runtime/node.exe')); await cp(license, join(stage, '.runtime/LICENSE.node.txt'));
for (const file of ['main.js', 'postgres-worker.js', 'migrate.js']) if (!existsSync(join(stage, 'apps/server/dist', file))) throw new Error(`缺少发布入口 ${file}`);
await cp(join(root, 'apps/web/dist'), join(stage, 'apps/web/dist'), { recursive: true });
await mkdir(join(stage, 'scripts'), { recursive: true });
for (const file of ['start.ps1', 'migrate.ps1', 'prepare-runtime.mjs']) await cp(join(root, 'scripts', file), join(stage, 'scripts', file));
for (const file of ['start.bat', 'migrate.bat']) await cp(join(root, file), join(stage, file));
await cp(join(root, 'docs/PORTABLE_GUIDE.md'), join(stage, '使用说明.md'));
await cp(join(root, 'docs/CREATIVE_GUIDE.md'), join(stage, '创作技能说明.md'));
await cp(join(root, 'docs/SETTING_GUIDE.md'), join(stage, '设定图谱说明.md'));
await cp(join(root, 'CHANGELOG.md'), join(stage, 'CHANGELOG.md'));
await cp(join(root, 'config-examples'), join(stage, 'config-examples'), { recursive: true });
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'shujian-portable', version, private: true, type: 'module' }, null, 2));
await writeFile(join(stage, '.distribution.json'), JSON.stringify({ app: 'shujian', schema: 1, version, platform: 'win32', arch: 'x64', nodeVersion: runtime.version }, null, 2));

const files = new Map(); const links = [];
const slash = (path) => path.split(sep).join('/');
function safeRelative(base, target) { const path = relative(base, target); if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('发布包出现外部依赖链接，已停止构建。'); return slash(path); }
async function walk(path, base, output, collectLinks) {
  const status = await lstat(path); const name = slash(relative(base, path));
  if (!collectLinks && ['scripts/audit-personal-atlas-upgrade.mjs', 'tests/live-provider-check.ts'].includes(name)) return;
  if (status.isSymbolicLink()) {
    if (!collectLinks) throw new Error(`源码清单不应包含链接：${name}`);
    let target = resolve(dirname(path), await readlink(path));
    if (name === 'apps/server/node_modules/.pnpm/node_modules/@shujian/server' && target.toLowerCase() === resolve(root, 'apps/server').toLowerCase()) target = join(stage, 'apps/server');
    links.push({ path: name, target: safeRelative(base, target) }); return;
  }
  if (status.isDirectory()) {
    for (const child of (await readdir(path)).sort()) {
      if (!collectLinks && ['node_modules', '__pycache__', '.pytest_cache'].includes(child)) continue;
      if (name.startsWith('apps/server/node_modules') && ['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.package-map.json'].includes(child)) continue;
      if (name === 'apps/server/node_modules/.pnpm' && child === 'lock.yaml') continue;
      await walk(join(path, child), base, output, collectLinks);
    }
  } else if (status.isFile()) output.set(name, await readFile(path));
}
// Explicit input list excludes src, data, credentials, references, audit builds and developer caches copied by deploy.
for (const path of ['.runtime', 'apps/server/dist', 'apps/server/node_modules', 'apps/server/package.json', 'apps/web/dist', 'scripts', 'config-examples', 'package.json', '.distribution.json', 'start.bat', 'migrate.bat', '使用说明.md', '创作技能说明.md', '设定图谱说明.md', 'CHANGELOG.md']) await walk(join(stage, path), stage, files, true);
files.set('dependency-links.json', Buffer.from(JSON.stringify(links, null, 2)));

const notices = [];
const visited = new Set();
async function dependencyRoot(name, from) {
  let folder = from;
  for (;;) {
    const path = join(folder, 'node_modules', name, 'package.json');
    if (existsSync(path)) return realpath(dirname(path));
    const parent = dirname(folder); if (parent === folder) return null; folder = parent;
  }
}
async function licenses(folder) {
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  if (pkg.name.startsWith('@shujian/')) return;
  const identity = `${pkg.name}@${pkg.version}`; if (visited.has(identity)) return; visited.add(identity);
  const originals = (await readdir(folder)).filter((name) => /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name));
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'see package', files: originals });
  for (const file of originals) if ((await stat(join(folder, file))).isFile()) files.set(`third-party-licenses/${identity.replace(/[^a-zA-Z0-9._-]/g, '_')}/${file}`, await readFile(join(folder, file)));
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const name of Object.keys(dependencies).sort()) { const target = await dependencyRoot(name, folder); if (target) await licenses(target); }
}
for (const folder of ['apps/server', 'apps/web', 'packages/contracts']) {
  const pkg = JSON.parse(await readFile(join(root, folder, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) { const target = await dependencyRoot(name, join(root, folder)); if (target) await licenses(target); }
}
files.set('third-party-licenses/index.json', Buffer.from(JSON.stringify(notices.sort((a, b) => a.name.localeCompare(b.name)), null, 2)));
files.set('THIRD_PARTY_NOTICES.md', Buffer.from(`# 第三方组件\n\nNode.js ${runtime.version} 的完整许可位于 .runtime/LICENSE.node.txt。官方来源：https://github.com/nodejs/node/blob/v${runtime.version}/LICENSE 。\n\n应用前后端依赖的原始许可与版本索引位于 third-party-licenses/；生产依赖包内原有许可文件也一并保留。参考研究项目未纳入运行包。\n`));
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventory = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: checksum(bytes) }));
files.set('release-manifest.json', Buffer.from(JSON.stringify({ version, platform: 'windows-x64', nodeVersion: runtime.version, dependencies: notices.length, files: inventory }, null, 2)));

const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
async function publish(path, content) {
  const temporary = join(work, path.split(sep).at(-1));
  await writeFile(temporary, content);
  await rename(temporary, path);
}
const archivePath = join(artifacts, `shujian-${version}-windows-x64.zip`);
if (existsSync(archivePath) && !process.argv.includes('--replace')) throw new Error('同版本发布包已存在。确认重建时使用 --replace，避免静默覆盖交付物。');
function archive(entries, prefix) {
  return zipSync(Object.fromEntries([...entries].map(([name, bytes]) => [`${prefix}/${name}`, [new Uint8Array(bytes), { mtime: new Date('2026-01-01T00:00:00Z'), level: name.endsWith('.exe') ? 6 : 6 }]])), { level: 6 });
}
const runtimeZip = archive(files, `shujian-${version}-windows-x64`);
const sourceFiles = new Map();
for (const path of ['apps/server/src', 'apps/server/package.json', 'apps/server/tsconfig.json', 'apps/server/tsup.config.ts', 'apps/web/src', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'packages/contracts', 'scripts', 'tests', 'config-examples', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.config.ts', '.node-version', '.gitignore', 'start.bat', 'start-dev.bat', 'migrate.bat', 'README.md', 'CHANGELOG.md']) {
  // Contract workspace dependencies are never vendored into the source archive.
  if (path === 'packages/contracts') {
    for (const child of ['src', 'package.json', 'tsconfig.json']) await walk(join(root, path, child), root, sourceFiles, false);
  } else await walk(join(root, path), root, sourceFiles, false);
}
for (const file of ['PROJECT_PLAN.md', 'IMPLEMENTATION.md', 'M1_API.md', 'M2_M3_API.md', 'STORAGE.md', 'PORTABLE_GUIDE.md', 'ACCEPTANCE.md', 'RELEASE_AUDIT.md', 'RELEASE_AUDIT-1.1.md', 'CREATIVE_GUIDE.md', 'QUALITY_COMPARISON.md', 'SETTING_GUIDE.md', 'SETTING_WORKBENCH_DESIGN.md', 'ATLAS_API.md', 'RELEASE_AUDIT-1.2.md', 'REFERENCES.md']) await walk(join(root, 'docs', file), root, sourceFiles, false);
sourceFiles.set('README.md', Buffer.from(`# 书间 ${version} · 源码交付\n\n作者掌舵的本机中文小说工作台，包含完整前后端源码、测试、锁定依赖与发布构建脚本。\n\n## 运行\n\n需要 Node.js 24 与 pnpm 11。Windows 可双击 start.bat；其它开发方式为 pnpm install、pnpm dev。生产构建使用 pnpm check，Windows 便携包使用 pnpm release。\n\n默认 SQLite；PostgreSQL 与模型配置保存在项目目录旁的 novel-private。此源码包不包含任何个人数据库、真实密钥、运行缓存或研究项目源码。\n\n## 文档\n\n- [整体规划](docs/PROJECT_PLAN.md)\n- [实现说明](docs/IMPLEMENTATION.md)\n- [数据库与迁移](docs/STORAGE.md)\n- [Windows 发布包使用说明](docs/PORTABLE_GUIDE.md)\n- [API 契约](docs/M1_API.md)与[AI / 故事资料 API](docs/M2_M3_API.md)\n- [创作技能指南](docs/CREATIVE_GUIDE.md)\n- [设定图谱指南](docs/SETTING_GUIDE.md)\n- [离线评测](docs/QUALITY_COMPARISON.md)\n- [更新记录](CHANGELOG.md)\n\n独立的 Windows x64 发布包已包含运行环境与生产依赖，普通使用者无需安装开发工具。\n`));
const sourceZipPath = join(artifacts, `shujian-${version}-source.zip`);
const sourceZip = archive(sourceFiles, `shujian-${version}-source`);
const sums = `${checksum(runtimeZip)}  ${archivePath.split(sep).at(-1)}\n${checksum(sourceZip)}  ${sourceZipPath.split(sep).at(-1)}\n`;
const report = { version, runtimeArchive: archivePath, sourceArchive: sourceZipPath, runtimeBytes: runtimeZip.length, sourceBytes: sourceZip.length, runtimeFiles: files.size, dependencyLinks: links.length, sourceFiles: sourceFiles.size, personalDataIncluded: false, thirdPartyPackages: notices.length };
await publish(archivePath, runtimeZip); await publish(sourceZipPath, sourceZip);
await publish(join(artifacts, `shujian-${version}-SHA256SUMS.txt`), sums);
await publish(join(artifacts, `shujian-${version}-build-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
