export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(label = '内容'): never {
  throw new AppError(404, 'NOT_FOUND', `${label}不存在。`);
}

export function conflict(currentVersion: number): never {
  throw new AppError(409, 'VERSION_CONFLICT', '这章已在其他位置更新。请保留当前文字，重新读取后对比。', currentVersion);
}
