# 会话清理 / Session Cleanup

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A DeepSeek Harness plugin that previews and permanently deletes archived Sessions together with their per-conversation folders, Session logs, projection checkpoints, unreferenced attachments, spilled tool output, and the files they produced in the workspace. It adds a **Settings → Session cleanup** page and resolves each Session's real project or conversation folder for one-click inspection.

一个 DeepSeek Harness 插件：在 **设置 → 会话清理** 中选择已归档的会话，先完整预览，再点击两次确认永久删除。

## 删除范围

对每个选中的已归档会话，插件会清理：

1. **会话专用目录（可选）**（session-archive）：`<工作区>/conversations/<时间_标题>/`，包括 `work/`、`out/`、`session.json` 与 `AGENTS.md` 副本；同时从 `conversations/index.json` 移除该会话的映射。会话清理里该选项默认关闭；需要整目录删除时才勾选。若要保留 `out/`，使用独立的“对话目录”清理。
2. **会话日志**：`<DSH_HOME>/sessions/<项目目录>/<会话ID>/`（当前与历史格式文件、锁文件）。
3. **投影检查点**：`<DSH_HOME>/storages/session_projcache/sessions/<会话ID>.json`，并同步 `session_projcache` 存储域内存。
4. **工作区归档记录**：从 `workspace` 域的归档集合、置顶集合和项目 `sessionIds` 中移除；不会删除整个工作区或其他会话。
5. **仅被这些会话引用的附件**：图片对象、文件对象与文件引用硬链接；删除前扫描所有其余会话，仍被引用的附件保留。
6. **会话的工具输出溢出目录**：`dsh-spill-*` 根下以 `session-<sha256(id)[0..12]>` 命名的目录（包括当前与以往进程的默认根）。
7. **会话在工作区产生的文件**：来源包括 `write` / `edit` / `str_replace_editor` / `present` 的显式路径，以及会话时间窗内新建文件的目录扫描（用于 shell、Python 等命令生成的中间脚本和最终产物）。会话目录内的文件随目录整体删除，不会重复列出。
8. **可选的附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images`，可重建，不影响其他会话。
9. **对话目录清理（独立功能）**：扫描每个工作区 `conversations/` 下的所有目录，包括会话记录已不存在的残留目录。每个目录可以选：
   - **保留 out**：删除 `work/` 与 `AGENTS.md` 副本，保留 `out/`、`session.json` 和其他未知文件；其他会话只引用 `out/` 时不会阻止这一模式；
   - **全部删除**：删除整个目录，并移除 `index.json` 中指向它的条目。
   目录清理只处理目录内容，不删除会话日志/附件；会话记录仍用上面的“会话清理”。

## 安全模型

- 只处理 **当前已归档** 的会话。`ctx.sessions` 里存在 Session 只说明它被 Harness 加载，不代表正在工作；归档后可能留下空闲 Agent。此时界面显示“已打开”，文件可以立即删除，工作区/归档记账会写入 `session-cleaner-pending.json`，并在下一次 Harness 启动时自动收尾，不会掉进“未分组”。
- “运行中”按 `ctx.agents.get(id)?.status === 'running'` 判断，包含等待审批/回答的回合；运行中的会话仍拒绝删除。“已打开但空闲”是另一个状态，显示“已打开”，可直接清理。
- 预览与执行都由 Host 重新推导候选；浏览器只提交选择项，不能指定任意路径。
- Host 在执行时再次核对：路径必须位于工作区/会话目录内、不是符号链接、路径链上不能有 symlink/Junction、不是目录、不在受保护前缀中。工作区之外的文件、仍被其他会话引用的文件、引用状态未知的文件都**不可删除**，不是仅仅“默认不勾选”。
- 会话专用目录必须位于某个工作区下，且目录内 `session.json` 的 `sessionId`、`workspace`、`folder` 与当前会话完全匹配。共享判断统一覆盖：其他会话的 cwd 等于目录、cwd 位于目录内部、显式文件/交付路径位于目录内部，以及 parent/child 子会话关系；冷会话和已加载会话使用同一套判断。删除前会扫描其余会话（包括运行中会话的 live events），目录仍被其他会话使用时保留。`index.json` 只移除当前会话的条目，并做读回校验与并发条目合并；不会重建或覆盖其他条目。
- 预览 token 现在同时绑定：会话 revision、文件身份（dev/ino/size/mtime/ctime/birthtime）、会话目录递归清单摘要、选项和候选集合。预览后文件被改写、替换、删除后重建，或目录中新增/删除/深层变化，都会使原 token 失效，必须重新预览。
- token 在首次异步执行前即被占用；同一 token 的并发请求会得到 `preview-in-use` / `preview-consumed`，最多执行一次。会话清理与目录清理共用 Host 内写操作队列；pending 的追加、移除和启动收尾也串行更新。
- 受保护区域：`DSH_HOME` 的会话/存储/附件/缓存/配置目录、Harness 安装目录、系统目录、用户主目录下的 `.ssh` / `.aws` / `.gnupg` / `.kube` / `.config`，以及任何 `session.*.jsonl*` / `session.json` / `conversations/index.json` / `workspace.json` / `settings.yaml` / 凭据文件。
- 工作区文件默认不勾选：工作区之外的文件、仍被其他会话引用的文件、会话开始前已存在的文件（例如被 `edit` 的既有源码）；前两类即使手动勾选也不会被 Host 接受。默认勾选只针对可由创建时间证明“会话期间新建”且来源为 `write` / `str_replace_editor` 的文件；`edit` / `present` / 扫描结果需要手动确认。文件创建时间晚于会话最后事件 5 分钟后，不再算作会话期间新建。
- 删除前需要两次点击确认（“永久删除所选内容” → “确认永久删除”）；操作不可撤销。
- 驻留会话的收尾：文件删除成功后，插件把会话 ID 写入 `<DSH_HOME>/session-cleaner-pending.json`，保留工作区记账与归档标记直到下一次启动；启动时 `finalizePending()` 再 detach/unarchive/unpin。detach、unarchive 或 unpin 失败的普通会话也会写入 pending，下次启动重试，不再只留下警告。这样既不需要为了删除而重启，也不会产生“未分组”幽灵。
- 每次会话清理都会在首个不可逆操作前写入 `<DSH_HOME>/session-cleaner-journal.json`，记录任务 ID、已确认的会话/选项、预览指纹摘要、当前阶段、已处理/失败/待收尾会话和最终报告摘要。进程中断后，下次启动会把 `running` 记录标记为 `interrupted`，并对 journal 中已完成日志删除的会话只恢复 detach/unarchive/unpin 记账；不会自动重放文件/附件/目录删除。设置页会显示上次任务，恢复删除仍需重新预览确认。
- 目录统计与递归清单在同一次遍历中完成；扫描受条目预算限制，超限、权限不足或读取失败会显示为“不完整”，整目录删除会被阻止，而不是把部分大小当作完整大小。

## 安装

从 GitHub 安装（当前为 GitHub-only 分发，不依赖 npm）：

```text
dsh plugin --profile <profile> add github:THao712/dsh-session-cleaner
```

包名是 `dsh-session-cleaner-thao712`。Desktop 用户也可以通过 dsh-market 的插件页安装。

本地开发时，把**本地仓库绝对路径**作为 bundle 安装：

```text
plugin_manager install_bundle  target: <仓库绝对路径>
```

安装完成后刷新页面，打开 **设置 → 会话清理**。刷新是为了载入新的 Client bundle；Host 路由只接受当前已登录的 Harness 页面请求。

## 使用

1. 已归档会话列表默认按 **会话日志大小从大到小** 排列，方便先处理最占空间的会话；可切换为 **按时间**（最新优先）。日志缺失或大小未知的会话始终排在最后。
2. 勾选要删除的已归档会话；单次最多 200 个，会话列表支持按大小或时间排序。
3. 每条会话右侧的 **文件夹图标** 会优先打开 session-archive 为该对话创建的会话专用目录；没有专用目录时，回退到日志中的 `working_directory`/文件路径推导出的项目根目录，再回退到 `cwd` 或工作区目录。目录已被删除时只回退到仍存在的上层目录，不会创建目录。
4. 选择清理范围（附件、工作区文件、时间窗扫描、工具输出溢出目录、图片请求缓存）。**会话目录清理默认关闭**；需要整目录删除时再勾选“同时整目录删除会话专用目录（不保留 out）”。
5. 点击 **预览清理**，逐项检查路径；可取消任意文件或附件。工作区外、共享引用、引用状态未知的文件会被禁用，不能删除；预览中的“当前勾选预计释放”会随勾选实时更新。
6. 点击 **永久删除所选内容**，再点击 **确认永久删除**。Host 会核对本次预览 token、文件身份和目录清单；若预览后选择、候选或内容发生变化，需要重新预览。
7. 查看结果报告；若侧边栏仍显示已删除会话，刷新页面。
8. **对话目录清理**（同一页面下方）：勾选要处理的 `conversations/<目录>`，选择 **保留 out** 或 **全部删除**，先 **预览目录清理**，再两次确认执行。该列表包含没有会话记录的残留目录；显示“已打开”的目录也可以直接清理（只要 Agent 不在运行）。

## 接口与实现

- Host：`dsh-session-cleaner-thao712` 的 `index.js`，注册 `POST /dsh-session-cleaner/api`，使用 `connection.requestRejection()` 做 Host/Origin 围栏与登录态校验。
- Client：`client.js` 注册 `settings.section`（id `session-cleaner`）。
- `journal` 返回最近一次会话清理任务的 journal；设置页在任务中断或部分完成时显示任务 ID、阶段、已处理/失败/待收尾数量和重新预览提示。
- `preview` 返回短期 `previewToken`；`delete` 必须携带该 token，并重新推导候选、比较文件身份与会话目录清单摘要，避免执行用户没看过的预览。同一 token 只能执行一次，执行中或已完成会分别返回 `preview-in-use` / `preview-consumed`。
- 对话目录：`folders` 返回目录清单与 `previewToken`；token 为每个目录保存独立指纹，`folders-delete` 只校验本次实际选中的目录，重新扫描目录大小/修改时间/递归清单/状态指纹。删除前再次校验目录位于 `conversations/` 直接子目录、不是 symlink/Junction、元数据匹配（有 `session.json` 时）；运行中的目录被拒绝，已加载但空闲的目录允许清理。
- 会话日志路径由 JSONL 后端的确定性布局推导，并在删除前再次校验目录名与根目录归属。
- 删除顺序：先处理检查点与会话日志；等所有会话的日志结果确定后，再删除会话目录并执行 detach/unarchive。这样批量选择中某个会话删除失败时，仍存活的会话所依赖的会话目录会保留。失败时同样保留归档状态和原工作区位置，并把可重试的记账写入 pending。
- 兼容 `@local/session-archive`：读取 `conversations/index.json` 与每个目录的 `session.json`，并消费 `working-directory/change` 事件，因此相对工具路径会按会话专用目录解析。
- 附件按 `sha256:<hex>` 解析到 `attachments/v1/objects`、`file-objects` 与 `files`。

## 已知边界

- Harness 的持久化接口没有删除 API；会话日志与附件对象必须由本插件直接删除文件。Agent 正在运行的会话会被拒绝，请先停止；仍被 Host 加载但空闲的会话可以立即删除文件，其工作区/归档记账会延后到下次 Harness 启动收尾，不会以“未分组”残留。
- 对话目录清理独立于会话清理：它只处理 `conversations/` 下的文件，不删除会话日志、投影检查点或附件；`保留 out` 只删除 `work/` 和 `AGENTS.md`，保留 `out/`、`session.json` 及未知顶层文件；`全部删除` 删除整个目录并移除 `index.json` 中指向该目录的条目。残留目录、未归档会话目录都会列出。
- 对话目录删除前会扫描所有会话日志与当前 live events，仍被其他会话使用（cwd 等于目录、cwd 位于目录内部，或显式文件路径位于该目录）的目录会阻止“全部删除”；“保留 out”只把对 `work/`、根目录文件或 cwd 的占用视为阻止条件，只引用 `out/` 的会话不会阻止删除中间文件。运行中的目录被禁用，已加载但空闲的目录仍可清理。但其他进程、未提交草稿、外部程序直接引用目录内文件的情况无法完全证明安全。
- 工作区文件候选依赖工具调用记录与文件创建时间；创建时间早于会话、晚于会话最后事件 5 分钟、或在多个所选会话时间窗之外的文件不会被默认勾选。扫描结果、`edit`、`present` 也需要在预览中手动确认。通过 shell 修改既有文件（而非新建）不会自动列出。
- 会话专用目录只在该目录存在且 `session.json` 完整匹配当前会话时才会删除；缺少或损坏 `session.json` 时只清理日志，不会猜测目录。目录仍被其他会话使用、含未知顶层项、扫描不完整、或其余会话引用状态未知时，整目录删除会被阻止。
- 自定义 `baseDir` 的会话在日志里有 `working-directory/change` 时可由 facts 识别；若 `applyDirectory:false` 且没有切换过目录，且 baseDir 不是默认 `conversations`，列表和预览可能无法自动发现目录。此时建议先用默认 baseDir 或让会话切换一次目录。
- 共享引用检查其余会话日志与当前 live events 中的工具路径；其他进程、未提交草稿、外部程序直接引用同一附件对象的情况仍无法完全证明安全。相关文件/附件会被保留或要求逐项确认。
- 运行中状态和“已打开”都只在当前 Host 进程内检测；另一个 Host 进程若仍打开同一会话，本插件无法看到它的写入锁。请确保该会话没有被其他进程使用。归档不会自动卸载 Agent，但已打开的空闲会话可以在不重启的情况下清理文件；工作区/归档记账会在下次启动自动收尾。
- 预览与确认之间文件内容可能变化；执行时会重新推导候选、校验文件身份和目录递归清单，并拒绝已失效的路径。内容哈希成本较高，未被纳入每次校验；重要文件请在确认前重新预览。
- journal 只记录任务与阶段，会自动恢复已完成日志删除会话的记账，但不会在崩溃后自动重放文件/附件/目录删除；恢复删除需要重新选择并预览。若日志在中断后重新出现或后台写入恢复，恢复逻辑会保留该日志并把会话视为新的/恢复的会话，仍需以新预览和运行状态检查为准。
- 若其他进程正占用日志或附件，Windows 可能拒绝删除；报告会列出失败项，可关闭占用后重试。
- 会话搜索索引是派生索引；删除后会在后台触发一次对账。若部署禁用了搜索，残留行会在下一次成功搜索时被清除。
- 删除文件后可能顺带移除因此变空的父目录（仅限工作区/会话目录边界内，且只移除空目录）。
- 未自动清理 OS 临时目录中的 `dsh-workspace-changes-*`、`dsh-subprocess-*` 等进程级临时目录；它们没有稳定的会话映射。
- 不会自动级联删除未归档的子会话、分叉或子代理会话；它们有独立的会话日志。若它们仍使用父会话目录，父目录会保留；若要清理这些会话，请先归档再分别选择。
- 归档的会话如果 Agent 仍在运行，插件会拒绝删除；如果只是被 Host 加载但空闲，会显示“已打开”，可以直接清理文件。工作区/归档记账写入待收尾记录，下次启动时自动完成，不需要为了删除而立即重启。

## 测试

```text
npm test
```

回归测试覆盖：预览 token 单次使用、已加载会话删除与待收尾记账、下次启动 finalize、工作区外文件、不可读的其余会话、symlink/Junction 祖先、投影缓存实际删除、共享会话目录、未知目录项、索引保留其他条目、默认选项、运行中会话引用、detach 失败、嵌套 baseDir，以及对话目录的保留 out/全部删除、残留目录、已加载目录清理。

## License

MIT © 2026 THao712
