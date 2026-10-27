# 书间 · AI Novel Pro

作者掌舵的本机中文小说工作台。讨论设定与剧情，逐章生成、修改和定稿；作品及历史保存在本地。

当前版本 **1.2.0**，支持 SQLite 与 PostgreSQL、多套 OpenAI Chat Completions 兼容 API，以及小说设定卡和关系图谱。

## 启动

需要 Node.js 24 与 pnpm 11。

```bash
git clone https://github.com/Rayz3rk/ai_novel_pro.git
cd ai_novel_pro
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 http://127.0.0.1:4318 。Windows 也可双击 `start.bat`；开发模式为 `pnpm dev` 或 `start-dev.bat`，前端地址 http://127.0.0.1:5173 。停止时在终端按 Ctrl+C。

## 功能

- 书架、章节、正文编辑、自动保存、版本检查、应急副本与冲突稿导出。
- 留稿、版本恢复、作者定稿、TXT/Markdown 导入导出与完整 JSON 备份恢复。
- 多平台连接、讨论、分层规划、候选起草、选区改稿、差异查看与明确采纳。
- 持久任务、流式进度、取消、重试、断流文字保留、实际输入与费用记录。
- 资料证据、角色知情范围、旧章影响提示、创作技能、人物声音与作者偏好案例。
- 人物、地点、道具、组织、场景及便签卡；关系图、方案对照与章节状态时间线。
- 子图讨论/起草、出处回查、历史撤销；AI 关系建议先作为待确认构思。

模型输出不会自动变成正文或正式事实。所有生成由使用者发起；预览材料本身不调用模型。

## 配置与隐私

默认 SQLite，数据为 `data/workspace.sqlite`。数据库与模型连接配置位于项目父目录的 `novel-private/`，不放进源码仓库。

- 模型配置：参考 `config-examples/connections.example.json`，保存为 `../novel-private/connections.json`，或在“模型连接”界面设置。
- 数据库配置：参考 `config-examples/database.example.json`，保存为 `../novel-private/database.json`。
- API 密钥保存于 `../novel-private/credentials/`，不进入作品数据库和应用备份。
- 作品、配置、备份、日志、测试输出、参考源码副本和本机审计由 `.gitignore` 排除；发布前仍须检查实际提交文件。

连接模型时，所选正文和资料会发往配置的平台。备份及冻结评测样本可能含有作品，应按私人文件保管。

## 开发与测试

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm eval:creative
```

测试使用隔离数据库和固定模型样本。浏览器脚本见 `tests/e2e/`，需要 Python Playwright；可用 `NOVEL_TEST_URL` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定地址和浏览器。不要针对个人作品库运行写入测试。

Windows 发布构建为 `pnpm release`，输出到 `artifacts/`。仓库只保存源码与发布脚本，不包含配置、作品或构建包。

## 文档

- [整体规划](docs/PROJECT_PLAN.md) · [实现说明](docs/IMPLEMENTATION.md)
- [数据库与迁移](docs/STORAGE.md) · [Windows 说明](docs/PORTABLE_GUIDE.md)
- [基础 API](docs/M1_API.md) · [AI API](docs/M2_M3_API.md) · [图谱 API](docs/ATLAS_API.md)
- [创作技能](docs/CREATIVE_GUIDE.md) · [设定与关系图](docs/SETTING_GUIDE.md)
- [离线评测](docs/QUALITY_COMPARISON.md) · [功能验收](docs/ACCEPTANCE.md)
- [参考项目与取舍](docs/REFERENCES.md) · [更新记录](CHANGELOG.md)
