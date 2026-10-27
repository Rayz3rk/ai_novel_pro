# M1 接口契约

共享类型见 `packages/contracts/src/index.ts`。JSON 成功响应使用以下外层字段，错误为 `{ error: { code, message, currentVersion? } }`。SQLite 文件通过 `NOVEL_DATA_DIR` 覆盖，默认项目根目录 `data/`，默认 API 端口 4318。本机监听 127.0.0.1。时间为 ISO 字符串。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| GET /api/health | — | `{ ok: true }` |
| GET /api/books | — | `{ books: Book[] }` |
| POST /api/books | CreateBookInput | `{ book: Book }`，自动创建空白第一章 |
| GET /api/books/:bookId | — | `{ book: Book }` |
| PATCH /api/books/:bookId | UpdateBookInput | `{ book: Book }` |
| GET /api/books/:bookId/chapters | — | `{ chapters: ChapterSummary[] }` |
| POST /api/books/:bookId/chapters | `{ title?: string, outline?: string }` | `{ chapter: Chapter }` |
| GET /api/chapters/:chapterId | — | `{ chapter: Chapter }` |
| PUT /api/chapters/:chapterId/draft | SaveDraftInput | `{ chapter: Chapter }` |
| POST /api/chapters/:chapterId/versions | `{ expectedVersion, label? }` | `{ version: DocumentRevision }` |
| GET /api/chapters/:chapterId/versions | — | `{ versions: RevisionSummary[] }` |
| GET /api/chapters/:chapterId/versions/:revisionId | — | `{ version: DocumentRevision }` |
| POST /api/chapters/:chapterId/restore | `{ expectedVersion, revisionId }` | `{ chapter: Chapter }` |
| POST /api/chapters/:chapterId/finalize | `{ expectedVersion }` | `{ chapter: Chapter }` |
| GET /api/books/:bookId/export?format=txt\|md | — | UTF-8 下载文件，使用当前工作草稿 |
| GET /api/backup | — | WorkspaceBackup 的 JSON 下载 |
| POST /api/backup/restore | `{ backup: WorkspaceBackup }` | `{ books: Book[] }`，作为新作品导入，原数据不覆盖 |
| POST /api/import | `{ filename: string, text: string, title?: string }` | `{ book: Book, chapters: ChapterSummary[] }` |

草稿保存每次成功递增 version；过期 expectedVersion 返回 409/`VERSION_CONFLICT`，不覆盖新内容。状态按工作稿是否与定稿相同计算。恢复创建恢复前快照，恢复为工作草稿，不删除任何历史。重复对同一 version 定稿返回同一结果，不能重复制造定稿版本；空章返回 422。标题与章纲随草稿同一版本保存。

M1 便携备份使用数据库一致性读事务导出所有作品、草稿、快照及定稿关系；恢复验证完整数据后原子导入为新作品并重映射 ID。当前没有附件或凭据；物理数据库备份与附件包留待后续版本升级场景。上传大小限制和 schema 校验由后端明确实现。

服务导出 `createApp({ dataDir, logger? })` 工厂用于集成测试，关闭 app 时释放数据库。正式启动优先提供已构建的前端静态页面；开发前端通过 /api 代理访问后端。
