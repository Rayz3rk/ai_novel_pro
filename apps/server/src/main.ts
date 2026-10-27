import { createApp } from './app.js';
import { AppError } from './errors.js';

let app: ReturnType<typeof createApp> | undefined;

try {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, 'INVALID_PORT', '启动端口必须是 1 至 65535 之间的整数。');
  app = createApp({ logger: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app!.close().then(() => process.exit(0)); });
  }
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  if (error instanceof AppError) console.error(error.message);
  else if ((error as { code?: string })?.code === 'EADDRINUSE') console.error('启动地址已被其他进程使用。请关闭重复启动的窗口，或为这个工作区设置不同的 PORT。');
  else console.error('书间启动未完成，请检查运行环境和数据库配置。');
  await app?.close();
  process.exitCode = 1;
}
