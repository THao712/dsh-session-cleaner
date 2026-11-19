# 开发记忆：会话清理插件

最后更新：2026-11-17

当前版本：`1.10.0`（本轮代码提交 `62397ca`，上一轮 `0f3031f`）

配套插件：`@local/session-archive` `1.2.1`（[GitHub](https://github.com/THao712/dsh-session-archive)）

本文件记录已经确认的架构决策、完成记录和仍然缺少的证据。下次修改前先读这里，再读 `OPTIMIZATION_PLAN.md` 中剩余的待办。

## 项目定位

DeepSeek Harness 的会话清理插件。设置页列出已归档会话和对话目录，先预览、再两次确认，删除会话日志、投影检查点、仅被这些会话引用的附件、溢出目录、工作区文件，以及可选的 session-archive 对话目录。

## 不可破坏的安全约束

- 浏览器只提交选择项，不提交权威路径；Host 在预览和执行时都重新推导候选。
- 只处理已归档会话。运行中的会话拒绝删除；已加载但空闲的会话可以删除文件，工作区/归档记账延后到下次启动。
- 工作区外、受保护路径、symlink/Junction 链、共享引用、引用状态未知的文件/附件不可删除。
- 预览 token 绑定会话 revision、文件身份、日志清单、目录递归清单、选项和候选集合；执行前重新计算。
- 删除顺序：先解析并校验日志目录，再处理检查点与日志；所有日志结果确定后才处理对话目录和 detach/unarchive。日志定位失败不得删除检查点或归档记账。
- 恢复旧任务只重新预览、重新确认，不自动重放删除。

## 两把锁

### 清理锁

`<DSH_HOME>/session-cleaner.lock`，保护会话清理与目录清理的整个执行过程。

- 通过创建描述符写入 owner；空文件或未写完的 JSON 视为“创建中”，等待后返回 `cleanup-locked`。
- 只有确认 PID 退出才接管陈旧锁；接管先重命名隔离，再核对 `dev/ino/size/mtime/birthtime` 和锁内容。
- 释放时核对 token，只移除自己的锁。
- 启动恢复使用同一把锁；另一个进程仍持锁时保留 `running` journal。
- 同进程用 `globalThis` 注册表识别仍在执行的模块实例，避免插件重载后自我抢锁。

### 索引锁

`<workspace>/conversations/.index.lock`，由清理插件和 session-archive 共用。

- 保护 `conversations/index.json` 的读取-合并-原子替换。
- **没有租约，没有按年龄接管**。持有者 PID 仍存活时，无论任务耗时多久都保持锁；只有确认进程退出才恢复。
- 内容不完整时按创建窗口等待；陈旧文件通过重命名、身份核对后清理。
- 索引更新使用“对最新快照重新应用删除”的合并方式：外部新增、字段更新、外部删除都保留；失败写入报告和 journal warning。

## Journal

`<DSH_HOME>/session-cleaner-journal.json` 是最近任务，`session-cleaner-journal-history/` 是历史。

- 版本 2，字段包括 `kind`、`requestId`、`ids`、`options`、`fingerprintHash`、`completedSessions`、`failedSessions`、`pending`、`resources`、`resumeIds`、`summary`。
- `resources` 覆盖会话日志、投影检查点、文件、附件、溢出目录、会话目录；记录路径、字节、身份、状态和错误。
- 会话清理和目录清理都写 journal；目录任务用 `kind: "folders"` 和 `folders` 数组。
- 历史裁剪只回收 `completed` 任务，未完成（`running` / `interrupted` / `partial`）不参与 20 条上限。
- `journal` API 支持 `taskId`、`requestId` 查询；Client 请求超时后用 `requestId` 找回原任务。

## 恢复入口

- `resumeIds` 是恢复范围的权威来源，Client 不再用 `completedSessions` 过滤它。
- 恢复预览带 `options.recoveryMode: true`。Host 允许已取消归档但仍留有失败资源的会话进入恢复模式。
- 恢复模式校验：会话 ID 安全、非运行中、任务确有失败资源、日志已缺失；日志重新出现时返回 `not-archived`，保护新日志。
- 恢复模式不删除日志、不重复 unarchive/detach；只重试失败资源（文件、附件、溢出目录、检查点）。
- 文件恢复候选默认不勾选；身份变化显示 `recovery-changed`，要求重新确认。
- 附件在预览中记录所有所选会话的 `sessionIds`，journal 资源继承这一归属；剩余会话的共享引用仍单独检查。
- 检查点删除区分 `missing`、`removed`、`changed`、`failed`；失败进入 errors、资源和 `resumeIds`。重试同步 storageDomain 与文件。

## Pending 收尾

- 已加载会话删除文件后写入 `session-cleaner-pending.json`，下次启动 detach/unarchive/unpin。
- 收尾前检查日志：日志重新出现则取消 detach/unarchive，移除 pending 并写 `session-cleaner-pending-conflicts.json`；日志不可读则保留 pending；确认缺失才收尾。

## 已完成里程碑

### 1.9.0（第 12 节）

- 跨进程清理锁：创建窗口、身份接管、启动恢复互斥。
- 索引并发：合并提交、共享 `.index.lock`、外部新增/更新/删除保留。
- pending 日志重现识别。
- journal v2、资源记录、目录 journal、任务历史与查询。
- 日志错误分类：`ENOENT` 才是 missing，`EACCES`/`EPERM`/I/O 是失败。

### 1.10.0（第 13 节补充）

- 活跃索引锁不再按 15 秒年龄接管，两侧插件统一为“PID 存活即保持”。
- 文件/附件/检查点失败后的恢复入口打通：`recoveryMode`、动态归档夹具、`resumeIds` 不过滤。
- 附件记录所选会话归属，支持独占附件和多会话共享附件。
- 检查点失败进入逐项资源、任务状态和恢复计划。
- 历史裁剪保留未完成任务；目录任务和会话任务一致。

## 验证基线

```text
清理插件：npm test -> 57 项通过，0 失败，0 跳过
session-archive：npm test -> 冒烟通过（1.2.1）
node --check index.js / client.js
npm pack --dry-run -> 9 个文件
git diff --check
```

关键回归名称：

- `an incomplete lock file blocks deletion instead of being stolen`
- `a live index lock is not taken over after 15 seconds`
- `a failed file deletion is recorded for targeted recovery`
- `a checkpoint failure is recorded and recoverable after unarchive`
- `an attachment failure keeps its selected Session and is recoverable`
- `one attachment records every selected owner`
- `an unfinished task survives journal history pruning`
- `folder cleanup writes a queryable task record`

## 仍需真实环境验证

- 真实 Host 的启动恢复、已加载会话、后台写入、正常退出、插件重载和 pending 收尾。
- 两个真实进程交错读写索引；目前有共享锁协议和单进程注入测试。
- 逐阶段故障矩阵：目录、检查点、日志、附件、工作区文件、记账分别中断。
- `ENOENT`、`EACCES`、`EPERM`、一般 I/O 的逐项断言；当前主要覆盖 `ENOENT`/`EACCES`。
- 性能基准：冷启动、重复预览、文件系统访问次数、峰值内存、100-200 会话缓存命中。
- 真实页面：恢复按钮完整流程、键盘焦点、执行状态播报、窄屏和大列表。
- 兼容性：最低 Harness 版本、历史/压缩日志格式、后端 location 信息、Windows/POSIX 删除语义。

## 操作注意

- profile 中 `node_modules/dsh-session-cleaner-thao712` 是指向 `D:\deepseek-chat-delete` 的 Junction；改动后必须完全重启 Harness 才加载新的 Host/Client bundle。
- 测试夹具的 `archivedSessionIds` 必须是动态 getter，`detachSession` 必须同步从 `sessionIds` 移除；否则恢复测试会掩盖真实的 `not-archived` 行为。
- 修改 Client 恢复逻辑时，保持 `resumeIds` 优先级，不要把 `completedSessions` 重新用作过滤条件。
- 修改索引写入时，两侧插件必须同时更新 `.index.lock` 协议，且不能给活跃持有者设置年龄接管。
