import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/postgres-worker.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: ['@shujian/contracts'],
  external: ['node:sqlite'],
  removeNodeProtocol: false,
  sourcemap: true,
});
