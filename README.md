# 会话清理 / Session Cleanup

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A DeepSeek Harness plugin that previews and permanently deletes archived Sessions together with their Session logs, projection checkpoints, unreferenced attachments, spilled tool output, and the files they produced in the workspace. It adds a **Settings → Session cleanup** page and resolves each Session's real project directory for one-click inspection.

一个 DeepSeek Harness 插件：在 **设置 → 会话清理** 中选择已归档的会话，先完整预览，再点击两次确认永久删除。

## 删除范围

对每个选中的已归档会话，插件会清理：

1. **会话日志**：`<DSH_HOME>/sessions/<项目目录>/<会话ID>/`（当前与历史格式文件、锁文件）。
2. **投影检查点**：`<DSH_HOME>/storages/session_projcache/sessions/<会话ID>.json`，并同步 `session_projcache` 存储域内存。
3. **工作区归档记录**：从 `workspace` 域的归档集合、置顶集合和项目 `sessionIds` 中移除；不会删除整个工作区或其他会话。
4. **仅被这些会话引用的附件**：图片对象、文件对象与文件引用硬链接；删除前扫描所有其余会话，仍被引用的附件保留。
5. **会话的工具输出溢出目录**：`dsh-spill-*` 根下以 `session-<sha256(id)[0..12]>` 命名的目录（包括当前与以往进程的默认根）。
6. **会话在工作区产生的文件**：来源包括 `write` / `edit` / `str_replace_editor` / `present` 的显式路径，以及会话时间窗内新建文件的目录扫描（用于 shell、Python 等命令生成的中间脚本和最终产物）。
7. **可选的附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images`，可重建，不影响其他会话。

## 安全模型

- 只处理 **当前已归档** 且 **未在本进程运行** 的会话。
- 预览与执行都由 Host 重新推导候选；浏览器只提交选择项，不能指定任意路径。
- Host 在执行时再次核对：路径必须位于工作区/会话目录内、不是符号链接、不是目录、不在受保护前缀中。
- 受保护区域：`DSH_HOME` 的会话/存储/附件/缓存/配置目录、Harness 安装目录、系统目录、用户主目录下的 `.ssh` / `.aws` / `.gnupg` / `.kube` / `.config`，以及任何 `session.*.jsonl*` / `workspace.json` / `settings.yaml` / 凭据文件。
- 默认不勾选：工作区之外的文件、仍被其他会话引用的文件、会话开始前已存在的文件（例如被 `edit` 的既有源码）。
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
2. 每条会话右侧的 **文件夹图标** 会先在 Host 侧解析该会话实际工作的项目目录：优先使用日志中的 `working_directory` 和文件工具/交付路径的公共项目根目录，其次回退到会话 `cwd` 或工作区目录，再在系统文件管理器中打开。项目目录已被删除时只回退到仍存在的上层目录，不会创建目录。
3. 选择清理范围（附件、工作区文件、时间窗扫描、工具输出溢出目录、图片请求缓存）。
4. 点击 **预览清理**，逐项检查路径；可取消任意文件或附件。
5. 点击 **永久删除所选内容**，再点击 **确认永久删除**。
6. 查看结果报告；若侧边栏仍显示已删除会话，刷新页面。

## 接口与实现

- Host：`@local/session-cleaner` 的 `index.js`，注册 `POST /dsh-session-cleaner/api`，使用 `connection.requestRejection()` 做 Host/Origin 围栏与登录态校验。
- Client：`client.js` 注册 `settings.section`（id `session-cleaner`）。
- 会话日志路径由 JSONL 后端的确定性布局推导，并在删除前再次校验目录名与根目录归属。
- 附件按 `sha256:<hex>` 解析到 `attachments/v1/objects`、`file-objects` 与 `files`。

## 已知边界

- Harness 的持久化接口没有删除 API；会话日志与附件对象必须由本插件直接删除文件。运行中会话会被拒绝，请先结束/关闭会话。
- 工作区文件候选依赖工具调用记录与文件创建时间；扫描到的文件默认不勾选，需要在预览中确认。通过 shell 修改既有文件（而非新建）不会自动列出。
- 共享引用只检查其余会话日志中的工具路径：其他会话通过 shell 新建/修改同一文件，或未提交草稿、外部程序直接引用同一附件对象的情况，无法完全证明安全；相关文件/附件应逐项确认。
- 运行中会话只在当前 Host 进程内检测；另一个 Host 进程若仍打开同一会话，本插件无法看到它的写入锁。请确保该会话没有被其他进程使用。
- 预览与确认之间文件内容可能变化；执行时会重新推导候选并拒绝已失效的路径，但不会比较预览时与执行时的文件哈希。重要文件请在确认前重新预览。
- 若其他进程正占用日志或附件，Windows 可能拒绝删除；报告会列出失败项，可关闭占用后重试。
- 会话搜索索引是派生索引；删除后会在后台触发一次对账。若部署禁用了搜索，残留行会在下一次成功搜索时被清除。
- 删除文件后可能顺带移除因此变空的父目录（仅限工作区/会话目录边界内，且只移除空目录）。
- 未自动清理 OS 临时目录中的 `dsh-workspace-changes-*`、`dsh-subprocess-*` 等进程级临时目录；它们没有稳定的会话映射。
- 不会自动级联删除未归档的子会话、分叉或子代理会话；它们有独立的会话日志。若也要清理，请先归档再分别选择。
- 归档的会话如果仍被某个界面打开，插件会拒绝删除；请先关闭该会话。

## License

MIT © 2026 THao712
