import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './app.js';
import { migrateSqliteToPostgres } from './storage-migration.js';
import { loadStorageConfig } from './storage-config.js';

const value = (flag: string, fallback: string) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1] ?? fallback; };
const dataDir = resolve(projectRoot, process.env.NOVEL_DATA_DIR ?? 'data');
const privateDir = resolve(projectRoot, '../novel-private');
try {
  const file = resolve(projectRoot, value('--database-file', process.env.NOVEL_DATABASE_FILE ?? resolve(privateDir, 'database.json')));
  const loaded = loadStorageConfig(projectRoot, dataDir, file);
  if (loaded.config.driver !== 'postgresql') throw new Error('请先在项目外数据库配置中选择 PostgreSQL，再迁移。');
  const report = await migrateSqliteToPostgres(resolve(projectRoot, value('--source', resolve(dataDir, 'workspace.sqlite'))), loaded.config.postgres, {
    dataDir, credentialDir: process.env.NOVEL_CREDENTIAL_DIR ?? resolve(privateDir, 'credentials'),
    connectionsFile: process.env.NOVEL_CONNECTIONS_FILE ?? resolve(privateDir, 'connections.json'),
  });
  await writeFile(resolve(dataDir, 'storage-migration-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : '数据库迁移未完成，原 SQLite 文件保持不变。');
  process.exitCode = 1;
}
