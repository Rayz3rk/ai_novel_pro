# 协作与资料 API

本机前缀 `/api`，错误沿用 `{error:{code,message,currentVersion?}}`。共享类型在 `packages/contracts/src/collaboration.ts`。所有正文变更必须匹配 `expectedVersion`。

## 模型连接

| 请求 | 作用 |
| --- | --- |
| GET /model | 当前连接的公开参数与 hasApiKey，不返回密钥 |
| PUT /model | 更新当前连接；空密钥保留，clearApiKey 明确清除 |
| GET /models | connections 和 activeId |
| POST /models | 保存新连接并设为当前连接 |
| POST /models/:connectionId/activate | 切换新任务使用的连接，在途任务保留原连接 |
| GET /models/:connectionId/catalog | 用该连接读取 /models，仍允许手工填写模型名 |
| POST /model/test | 真实短请求；记录调用和可得用量 |

`ModelSettings` 包含基础地址、模型、流式/温度/额度、上下文窗口、单价和预算，以及 `tokenParameter`、`sendTemperature`、`includeStreamUsage` 兼容选项。当前协议为 OpenAI Chat Completions，多平台通过独立连接使用该协议。

默认本机文件为项目父目录 `novel-private/connections.json`，`connections` 数组中的每项有唯一英文/数字/短横线 id。`activeConnection` 指定当前项。文件内容改变后自动导入，未变化时不覆盖界面修改。凭据单独存放在同一私有目录的 `credentials`，均排除于作品备份。

## 任务

| 请求 | 作用 |
| --- | --- |
| POST /jobs | CreateAiJobInput，返回 {job} |
| GET /jobs/:id | 当前持久快照 |
| GET /books/:bookId/jobs | 最近 200 项作品任务 |
| GET /chapters/:chapterId/jobs | 最近 200 项本章任务，用于旧章回查 |
| GET /jobs/:id/events | SSE，递增事件 ID；回放进度后发送当前 job 快照 |
| GET /jobs/:id/calls | 每次调用的状态、原始输出和可得用量 |
| POST /jobs/:id/cancel | 停止接收/后续阶段，保留部分输出 |
| POST /jobs/:id/retry | 按当前版本创建新任务；旧选区失效时拒绝 |
| POST /jobs/:id/apply | {expectedVersion,target,text?}，采纳前后留稿，重复采纳不重复改正文 |

任务类型为 discuss / plan / draft / revise / review / extract。`selection` 使用 ProseMirror 位置和原句校验，修订只能替换该范围。可提供 pov、pinnedEntryIds 和 excludedEntryIds。提取可选 `source: draft | final`，默认 final；草稿提取只产生候选，不能提前确认事实。

每次请求的输入快照、依据清单、提示版本、模型参数和价格依据冻结。网络未收到文字时最多重试一次，结构或证据错误最多修正一次，总尝试不超过三次；全部尝试都重新校验预算和上下文。

## 故事资料

| 请求 | 作用 |
| --- | --- |
| GET /books/:bookId/story | q/kind/chapterPosition/pov/includeWithdrawn 过滤，返回 entries 和 coverage |
| POST /books/:bookId/story | 作者确认新资料 |
| GET /story/:id | 资料及来源失效状态 |
| PUT /story/:id | 带 expectedVersion 修改并追加历史 |
| POST /story/:id/withdraw | 带 expectedVersion 撤回 |
| GET /story/:id/history | 追加的确认、修改、撤回和来源失效记录 |
| GET /books/:bookId/proposals | 候选列表；stale 和 requiresFinalization 明确状态 |
| POST /proposals/:id/accept 或 reject | 明确决定；未定稿来源不能直接接受 |
| GET /chapters/:id/evidence | 当前定稿的段落标识、原文和 hash |
| GET /chapters/:id/reviews | 绑定正文快照的检查结果，旧版本标记 stale |
| GET /books/:bookId/sources?q= | 当前定稿原文的中文子串回查，最多 100 个段落 |
| GET /books/:bookId/impacts | 来源失效和后文任务使用过的旧定稿引用 |

确认事实必须引用同一本书的作者定稿，摘录、段落和 hash 需匹配。作者设定、未来规划与模型候选分别记录。未确认、撤回、失效和知情范围不允许的信息不作为写作依据；旧章改稿保留原定稿效力，重新定稿后标记来源变化。

## 定稿提交

`POST /chapters/:id/finalize` 扩展输入 `{expectedVersion,proposalIds?:string[]}`。保存正文后，审稿和资料候选提取在事务外执行。作者选择候选后，用一次短事务设置定稿指针、把匹配当前快照的候选证据绑定到定稿、确认所选事实并追加历史。

重复提交同版和相同候选不会重复确认。过期或跨章候选使本次定稿事务整体回滚，已经保存的草稿保留。未准备资料或模型失败时，作者可以不选候选直接定稿。

## 分层规划

GET/POST `/books/:bookId/plans`、PUT `/plans/:id`，使用 PlanNode / SavePlanInput。全书 → 故事弧 → 章节 → 场景；场景归属章节规划，关联章节必须同书。更新带 expectedVersion。规划保留历史，进入模型时明确标注尚未发生。

备份仍使用 `shujian-backup` version 1，通过每本书的 extensions.ai / story / planning 扩展。正文、任务、调用、资料、事件和规划恢复时统一重映射 ID；模型连接和密钥不会被打包。

## 1.1 创作技能与预览

以下路径同样使用 `/api` 前缀，完整输入输出类型见 `packages/contracts/src/creative.ts`。

- GET/PUT `/books/:bookId/creative`：读取档案与可用方法，使用 `expectedVersion` 保存文风、声音、偏好及任务常用设置；GET `/creative/history` 读取档案历史。
- POST `/books/:bookId/skills`、PUT `/books/:bookId/skills/:skillId`：保存自定义技能版本。内置方法只允许建立副本；被常用设置引用的方法需先解除引用再停用或缩小任务范围。
- POST `/books/:bookId/skills/import`：受限 `SKILL.md` 或 `shujian-skill` JSON 文本包；GET `/skills/:skillId/export`、`/skills/:skillId/history`：导出与版本历史。
- POST `/jobs/preview`：与创建任务相同的输入，返回 `ContextPreview`；不调用模型、不建立任务/留稿/预算预留。任务输入新增 `skills`、`voiceIds` 和可选 `previewFingerprint`。正式发起时指纹不符返回 409。
- GET `/jobs/:jobId/evaluation-sample`：导出材料、技能/提示、公开模型参数、原始输出及实际调用；不导出连接密钥。旧任务缺失快照或参数时保留空值，不推断历史。
- GET `/chapters/:chapterId/clean-check`：无需模型的已保存稿检查，返回版本及原句线索，不改稿、不阻止定稿。

备份增加 `extensions.creative`，兼容没有该扩展的 1.0 备份。恢复后的活动关联重映射到新作品，冻结提示保留原始定义、版本、资源和哈希。重试以原方法快照配合当前保存稿、档案及模型设置创建独立候选，仍检查当前启停和 CAS。
