# 设定图谱 API · 1.2

路径以 `/api` 为前缀。所有操作只在本机服务中使用；错误、事务、CAS、备份及任务预算规则沿用既有接口。类型定义：`packages/contracts/src/atlas.ts`。

| 方法 / 路径 | 用途 |
| --- | --- |
| GET `/books/:bookId/atlas` | 当前节点、关系、状态、布局、原场景规划和人物声音 |
| POST `/books/:bookId/story` / PUT `/story/:id` | 复用原资料节点，新增 `attributes`、`links`、`branch` 和 `idea` 状态 |
| GET `/books/:bookId/atlas/nodes/:id/mentions` | 关联与名称/别名提及章节 |
| POST `/atlas/nodes/:id/restore` | 使用 `eventId`、`expectedVersion` 恢复历史为新版 |
| POST `/books/:bookId/atlas/relations` | 新建关系；默认构思 |
| PUT `/atlas/relations/:id` | 编辑；需 `expectedVersion` |
| POST `/atlas/relations/:id/evolve` | 同一双方在更晚章节开始新阶段，旧阶段同时结束 |
| POST `/books/:bookId/atlas/states` / PUT `/atlas/states/:id` | 独立章节状态及属性变化 |
| GET `/atlas/relations/:id/history` / `/atlas/states/:id/history` | 不可变历史快照 |
| POST `/atlas/relations/:id/withdraw` / `/atlas/states/:id/withdraw` | 检查版本后撤回 |
| POST `/atlas/relations/:id/restore` / `/atlas/states/:id/restore` | 历史恢复为新版本 |
| PUT `/books/:bookId/atlas/view` | 独立布局 CAS；0–1 坐标、最多 5000 个位置、30 个选择 |
| POST `/books/:bookId/atlas/from-plan/:planId` | 关联原有 scene 规划，重复操作返回现有卡片 |
| GET `/books/:bookId/atlas/jobs` | 最近 100 条图谱讨论记录 |
| POST `/books/:bookId/atlas/import-job/:jobId` | 从已完成的图谱讨论导入待确认关系，原子校验与幂等 |

关系与状态共享 `phase`、`branch`、`fromChapter`、`storyTime`、`visibility`、`knownBy`、`evidence`、`sourceJobId`。关系另有 `fromId`、`toId`、`label`、`description`、`symmetric`、`toChapter`；状态另有 `nodeId`、`summary`、`changes`。确认关系/状态要求涉及节点已确认，不能早于节点或证据章节。自环、跨书引用、上级循环、不存在的声音/规划都拒绝。

AI 请求可增加 `atlas: {nodeIds, relationIds, includeIdeas, branch}`。ID 必须属于当前书；构思仅在明确选择且方案匹配时进入本次假设。章节、视角、作者秘密、失效来源过滤先于材料选择；原预览、预算与冻结材料机制不变。

完整备份扩展 `atlas.version=1`，保存 relations、states、events、view。恢复分配新标识并验证引用、每一修订版本和当前快照；任一错误回滚整次恢复。没有 atlas 扩展的旧备份兼容。
