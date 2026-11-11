# 数据库配置与迁移

支持 SQLite 与 PostgreSQL，相同业务逻辑；默认 SQLite，PostgreSQL 不使用 SQLite 镜像。

## 配置

项目父目录的 `novel-private/database.json` 保存选择及连接，参考 `config-examples/database.example.json`，自行填写账号、密码和数据库名。目标库不存在时按权限创建，再初始化应用表；不删除或替换已有库。应使用专用数据库，不指向其它项目的不同表结构。

“数据库”界面保存的选择在重启后生效；两种后端各自保存，不持续同步。作品、正文、历史、资料、规划、任务、技能和图谱保存在数据库中。目前有 27 张应用表，包括可重建的引用索引、旧库导入记录和正文回填记录。密钥位于外置 `novel-private/credentials/`，数据库密码位于外置配置，两者不进入作品备份。

## 备份与迁移

完整 JSON 恢复建立独立作品，不覆盖已有作品。不要在线只复制 SQLite 主文件。

正文 schema v2 增加可空的 `archived_at` 字段，启动时在事务中升级旧库。归档保留章节 ID、正文、版本、定稿及证据，不出现在默认章节列表和正文导出中；带 `includeArchived=true` 可列出全部章节。完整备份包含归档章节，恢复后继续保持归档状态。章节顺序不会重排。作品统计只计算未归档章节。

引用与删除统一由 `ManuscriptLifecycle` 管理。模块声明引用来源和删除表顺序，按依赖方到被依赖方注册。检查引用时从当前记录和历史快照重建索引，精确匹配结构化字段中的章节、版本及任务 ID；索引 `(book_id,target_id)` 支持目标回查，避免依靠正文子串猜测引用。该索引是派生数据，不进入 JSON 作品备份。

可恢复文件从 `backups/managed/`、`backups/before-delete/` 和旧导入备份目录读取。恢复与清理均检查预览指纹，防止文件或列表变化后继续操作。清理保留各作品、章节和版本的最新副本；只处理符合格式且可验证的备份文件，不自动执行清理。路径校验限制在备份根目录内，并拒绝越界符号链接。

1. 停止源工作区，在外置配置中选择空白 PostgreSQL。
2. Windows 运行 `migrate.bat`；源码可运行 `pnpm db:migrate`。
3. 工具取得源库锁、保留快照，在事务中复制及逐表核对；目标有数据则拒绝，失败整批回滚。
4. 重启并核对当前后端。源 SQLite 和备份保留。

参数：`migrate.bat --source data/workspace.sqlite --database-file ../novel-private/database.json`。相对路径以软件根目录为准，不通过命令行传密码。报告位于 `data/storage-migration-report.json`，旧 16/20 表库可迁移，新模块从空白开始。

## 环境变量

`NOVEL_DATABASE_URL` 指定 PostgreSQL，`NOVEL_DATABASE_FILE` 指定外置配置，`NOVEL_DATA_DIR` 指定隔离数据目录。仅指定后者时使用该目录的 SQLite。模型连接及凭据分别用 `NOVEL_CONNECTIONS_FILE`、`NOVEL_CREDENTIAL_DIR` 指定。数据库配置在启动读取，模型连接文件支持更新后加载；凭据目录必须在项目之外。
