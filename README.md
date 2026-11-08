# 会话清理 / Session Cleanup

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A DeepSeek Harness plugin that previews and permanently deletes archived Sessions together with their per-conversation folders, Session logs, projection checkpoints, unreferenced attachments, spilled tool output, and the files they produced in the workspace. It adds a **Settings → Session cleanup** page and resolves each Session's real project or conversation folder for one-click inspection.

一个 DeepSeek Harness 插件：在 **设置 → 会话清理** 中选择已归档的会话，先完整预览，再点击两次确认永久删除。

## 删除范围

对每个选中的已归档会话，插件会清理：

1. **会话专用目录**（session-archive）：`<工作区>/conversations/<时间_标题>/`，包括 `work/`、`out/`、`session.json` 与 `AGENTS.md` 副本；同时从 `conversations/index.json` 移除该会话的映射。若目录仍被其他会话（包括子会话/分叉）使用，或含有 `work/out/session.json/AGENTS.md` 之外的顶层项，则默认保留；未知项需要显式勾选“同时删除会话目录中的其他文件”。
2. **会话日志**：`<DSH_HOME>/sessions/<项目目录>/<会话ID>/`（当前与历史格式文件、锁文件）。
3. **投影检查点**：`<DSH_HOME>/storages/session_projcache/sessions/<会话ID>.json`，并同步 `session_projcache` 存储域内存。
4. **工作区归档记录**：从 `workspace` 域的归档集合、置顶集合和项目 `sessionIds` 中移除；不会删除整个工作区或其他会话。
5. **仅被这些会话引用的附件**：图片对象、文件对象与文件引用硬链接；删除前扫描所有其余会话，仍被引用的附件保留。
6. **会话的工具输出溢出目录**：`dsh-spill-*` 根下以 `session-<sha256(id)[0..12]>` 命名的目录（包括当前与以往进程的默认根）。
7. **会话在工作区产生的文件**：来源包括 `write` / `edit` / `str_replace_editor` / `present` 的显式路径，以及会话时间窗内新建文件的目录扫描（用于 shell、Python 等命令生成的中间脚本和最终产物）。会话目录内的文件随目录整体删除，不会重复列出。
8. **可选的附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images`，可重建，不影响其他会话。

## 安全模型

- 只处理 **当前已归档** 且 **未被 Harness 加载** 的会话。`ctx.sessions` 里存在 Session 只说明它被加载，不代表正在工作；归档后可能留下空闲 Agent。此时界面显示“已打开（需重启）”，勾选框禁用，必须先重启 Harness（归档状态会保留）再清理，否则删除后会话会以“未分组”残留。
- “运行中”按 `ctx.agents.get(id)?.status === 'running'` 判断，包含等待审批/回答的回合；它与“已打开但空闲”是两个不同状态，分别显示“运行中”和“已打开（需重启）”。
- 预览与执行都由 Host 重新推导候选；浏览器只提交选择项，不能指定任意路径。
- Host 在执行时再次核对：路径必须位于工作区/会话目录内、不是符号链接、路径链上不能有 symlink/Junction、不是目录、不在受保护前缀中。工作区之外的文件、仍被其他会话引用的文件、引用状态未知的文件都**不可删除**，不是仅仅“默认不勾选”。
- 会话专用目录必须位于某个工作区下，且目录内 `session.json` 的 `sessionId`、`workspace`、`folder` 与当前会话完全匹配；删除前会扫描其余会话（包括运行中会话的 live events），目录仍被其他会话使用时保留。`index.json` 只移除当前会话的条目，并做读回校验；不会重建或覆盖其他条目。
- 受保护区域：`DSH_HOME` 的会话/存储/附件/缓存/配置目录、Harness 安装目录、系统目录、用户主目录下的 `.ssh` / `.aws` / `.gnupg` / `.kube` / `.config`，以及任何 `session.*.jsonl*` / `session.json` / `conversations/index.json` / `workspace.json` / `settings.yaml` / 凭据文件。
- 预览会返回短期 `previewToken`；执行删除必须携带该 token，且 token 绑定会话选择、选项和候选集合。选择或候选发生变化时，必须重新预览。
- 工作区文件默认不勾选：工作区之外的文件、仍被其他会话引用的文件、会话开始前已存在的文件（例如被 `edit` 的既有源码）；前两类即使手动勾选也不会被 Host 接受。
- 删除前需要两次点击确认（“永久删除所选内容” → “确认永久删除”）；操作不可撤销。

## 安装

```text
git clone https://github.com/THao712/dsh-session-cleaner.git
```

然后在 Harness 中把**本地仓库绝对路径**作为 bundle 安装（插件包名是 `@local/session-cleaner`）：

```text
plugin_manager install_bundle  target: <克隆目录的绝对路径>
```

安装完成后刷新页面，打开 **设置 → 会话清理**。刷新是为了载入新的 Client bundle；Host 路由只接受当前已登录的 Harness 页面请求。

## 使用

1. 勾选要删除的已归档会话。
2. 每条会话右侧的 **文件夹图标** 会优先打开 session-archive 为该对话创建的会话专用目录；没有专用目录时，回退到日志中的 `working_directory`/文件路径推导出的项目根目录，再回退到 `cwd` 或工作区目录。目录已被删除时只回退到仍存在的上层目录，不会创建目录。
3. 选择清理范围（会话专用目录、附件、工作区文件、时间窗扫描、工具输出溢出目录、图片请求缓存）。默认会整目录删除会话专用目录；若目录被其他会话共用或含有未知顶层项，预览会保留它并说明原因。未知顶层项需要显式勾选“同时删除会话目录中的其他文件”。
4. 点击 **预览清理**，逐项检查路径；可取消任意文件或附件。工作区外、共享引用、引用状态未知的文件会被禁用，不能删除。
5. 点击 **永久删除所选内容**，再点击 **确认永久删除**。Host 会核对本次预览 token；若预览后选择或候选发生变化，需要重新预览。
6. 查看结果报告；若侧边栏仍显示已删除会话，刷新页面。

## 接口与实现

- Host：`@local/session-cleaner` 的 `index.js`，注册 `POST /dsh-session-cleaner/api`，使用 `connection.requestRejection()` 做 Host/Origin 围栏与登录态校验。
- Client：`client.js` 注册 `settings.section`（id `session-cleaner`）。
- `preview` 返回短期 `previewToken`；`delete` 必须携带该 token，并重新推导候选、比较指纹，避免执行用户没看过的预览。
- 会话日志路径由 JSONL 后端的确定性布局推导，并在删除前再次校验目录名与根目录归属。
- 删除顺序：先完成会话目录/检查点/日志的文件系统删除，成功后才 detach/unarchive；失败时保留归档状态和原工作区位置。
- 兼容 `@local/session-archive`：读取 `conversations/index.json` 与每个目录的 `session.json`，并消费 `working-directory/change` 事件，因此相对工具路径会按会话专用目录解析。
- 附件按 `sha256:<hex>` 解析到 `attachments/v1/objects`、`file-objects` 与 `files`。

## 已知边界

- Harness 的持久化接口没有删除 API；会话日志与附件对象必须由本插件直接删除文件。Agent 正在运行、或 Session 仍被 Host 加载的会话都会被拒绝；前者请先停止，后者请关闭会话或重启 Harness。否则删除会让它在侧边栏以“未分组”残留。
- 工作区文件候选依赖工具调用记录与文件创建时间；扫描到的文件默认不勾选，需要在预览中确认。通过 shell 修改既有文件（而非新建）不会自动列出。
- 会话专用目录只在该目录存在且 `session.json` 完整匹配当前会话时才会删除；缺少或损坏 `session.json` 时只清理日志，不会猜测目录。目录仍被其他会话使用、含未知顶层项、或其余会话引用状态未知时，整目录删除会被阻止。
- 自定义 `baseDir` 的会话在日志里有 `working-directory/change` 时可由 facts 识别；若 `applyDirectory:false` 且没有切换过目录，且 baseDir 不是默认 `conversations`，列表和预览可能无法自动发现目录。此时建议先用默认 baseDir 或让会话切换一次目录。
- 共享引用检查其余会话日志与当前 live events 中的工具路径；其他进程、未提交草稿、外部程序直接引用同一附件对象的情况仍无法完全证明安全。相关文件/附件会被保留或要求逐项确认。
- 运行中状态和“已打开”都只在当前 Host 进程内检测；另一个 Host 进程若仍打开同一会话，本插件无法看到它的写入锁。请确保该会话没有被其他进程使用。归档不会自动卸载 Agent；清理这些会话前请重启一次 Harness。
- 预览与确认之间文件内容可能变化；执行时会重新推导候选、校验预览 token，并拒绝已失效的路径，但不会比较预览时与执行时的文件哈希。重要文件请在确认前重新预览。
- 若其他进程正占用日志或附件，Windows 可能拒绝删除；报告会列出失败项，可关闭占用后重试。
- 会话搜索索引是派生索引；删除后会在后台触发一次对账。若部署禁用了搜索，残留行会在下一次成功搜索时被清除。
- 删除文件后可能顺带移除因此变空的父目录（仅限工作区/会话目录边界内，且只移除空目录）。
- 未自动清理 OS 临时目录中的 `dsh-workspace-changes-*`、`dsh-subprocess-*` 等进程级临时目录；它们没有稳定的会话映射。
- 不会自动级联删除未归档的子会话、分叉或子代理会话；它们有独立的会话日志。若它们仍使用父会话目录，父目录会保留；若要清理这些会话，请先归档再分别选择。
- 归档的会话如果 Agent 仍在运行，或 Session 仍被 Host 加载，插件会拒绝删除；后者显示“已打开（需重启）”。先重启 Harness（归档状态不会丢），再回来清理。

## 测试

```text
npm test
```

回归测试覆盖：预览 token 单次使用、工作区外文件、不可读的其余会话、symlink/Junction 祖先、投影缓存实际删除、共享会话目录、未知目录项、索引保留其他条目、默认选项、运行中会话引用、detach 失败、嵌套 baseDir。

## License

MIT © 2026 THao712
