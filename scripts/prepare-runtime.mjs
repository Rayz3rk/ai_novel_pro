import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function inside(path) {
  const result = relative(root, path);
  if (result.startsWith(`..${sep}`) || result === '..' || isAbsolute(result)) throw new Error('发布包的依赖路径不正确，请重新完整解压。');
  return path;
}
try {
  const manifest = JSON.parse(await readFile(resolve(root, '.distribution.json'), 'utf8'));
  if (manifest.app !== 'shujian' || manifest.schema !== 1) throw new Error('无法识别发布包，请重新完整解压。');
  const links = JSON.parse(await readFile(resolve(root, 'dependency-links.json'), 'utf8'));
  if (!Array.isArray(links) || links.length > 5000) throw new Error('发布包依赖清单不正确。');
  for (const entry of links) {
    if (typeof entry.path !== 'string' || typeof entry.target !== 'string') throw new Error('发布包依赖清单不正确。');
    const path = inside(resolve(root, entry.path)); const target = inside(resolve(root, entry.target));
    await lstat(target);
    let current;
    try { current = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current) {
      if (!current.isSymbolicLink()) throw new Error('依赖位置存在其它文件，请把发布包重新解压到一个新目录。');
      const old = resolve(dirname(path), await readlink(path));
      if (old.toLowerCase() === target.toLowerCase()) continue;
      // This is a verified link inside the application, never a recursive target deletion.
      await unlink(path);
    }
    await mkdir(dirname(path), { recursive: true });
    try { await symlink(process.platform === 'win32' ? target : relative(dirname(path), target), path, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await lstat(path)).isSymbolicLink()
        || resolve(dirname(path), await readlink(path)).toLowerCase() !== target.toLowerCase()) throw error;
    }
  }
  const privateDir = resolve(root, '../novel-private');
  const stateFile = resolve(root, '.portable-profile.json');
  let previous;
  try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('运行配置记录无法读取，请先保留作品，再检查软件目录。'); }
  let configurationExists = false;
  try { configurationExists = (await lstat(resolve(privateDir, 'database.json'))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.privateDir && previous.privateDir.toLowerCase() !== privateDir.toLowerCase() && !configurationExists
    && !process.env.NOVEL_DATABASE_FILE && !process.env.NOVEL_DATABASE_URL) {
    throw new Error(`软件移到了不同的父目录。请把原来的 novel-private 一起移到新目录旁，或设置外置配置路径后再启动。原配置目录：${previous.privateDir}。未创建新的空白工作区。`);
  }
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(resolve(privateDir, 'database.json'), JSON.stringify({ driver: 'sqlite', sqlite: { filename: 'data/workspace.sqlite' } }, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await writeFile(stateFile, JSON.stringify({ schema: 1, privateDir }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : '发布包准备失败，请重新完整解压。');
  process.exitCode = 1;
}
