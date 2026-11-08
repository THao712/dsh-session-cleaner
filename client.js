/**
 * Session Cleanup — browser half.
 *
 * A Settings page that lists archived Sessions, previews every file and
 * attachment a permanent deletion would touch, and only then asks for a second
 * confirmation click. All authority stays on the Host: this page sends Session
 * ids, menu choices, and a confirmation flag, never an authoritative path.
 */
window.__ModuleLoader__.load({
  id: '@local/session-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'session-cleaner'
    const ROUTE = '/dsh-session-cleaner/api'
    const FILE_PAGE = 80

    const DICTIONARIES = {
      zh: {
        navLabel: '会话清理',
        title: '会话清理',
        intro: '选择已归档的会话，先预览将被永久删除的全部内容，再确认执行。删除范围包括会话日志、投影检查点、仅被这些会话引用的附件，以及会话在工作区中产生的文件。',
        dangerNote: '永久删除不可撤销。预览会逐项列出将被删除的路径；请确认其中没有你仍需保留的文件。',
        openNote: '显示“已打开（需重启）”的会话仍被 Harness 加载。请先重启 Harness（归档状态会保留），再回来清理；否则删除后它会以“未分组”残留。',
        loading: '正在读取已归档会话…',
        loadFailed: '无法读取已归档会话：{message}',
        retry: '重试',
        refresh: '刷新',
        empty: '当前没有已归档的会话。',
        selectAll: '全选',
        clear: '清空',
        selected: '已选 {count} 个会话',
        totalSize: '列表合计 {size}',
        live: '运行中',
        opened: '已打开（需重启）',
        missing: '日志缺失',
        untitled: '未命名会话',
        messages: '{count} 条记录',
        workspace: '工作区',
        noWorkspace: '未归入工作区',
        openWorkspace: '打开目录',
        openWorkspaceFailed: '无法打开目录：{message}',
        noWorkspacePath: '该会话没有可打开的目录',
        optionsTitle: '清理范围',
        optConversationFolder: '删除会话专用目录',
        optConversationFolderHint: '删除 session-archive 为每个对话创建的 conversations/<时间_标题>/ 目录，包括 work、out、session.json 与 AGENTS.md 副本；同时移除 index.json 中的映射。若目录仍被其他会话使用，或含有未知顶层文件，则默认保留。',
        optFolderUnknown: '同时删除会话目录中的其他文件',
        optFolderUnknownHint: '仅在目录含有 work/out/session.json/AGENTS.md 之外的文件时需要。默认关闭；关闭时整目录删除会被阻止，未知文件会列在预览中。',
        optAttachments: '删除仅被这些会话引用的附件',
        optAttachmentsHint: '删除前会扫描其余会话；仍被引用的附件会保留。只检查会话日志中的引用，未提交草稿或外部程序的引用无法检测。',
        optFiles: '删除这些会话在工作区产生的文件',
        optFilesHint: '依据文件工具调用与会话时间窗生成候选；扫描到的文件默认不勾选，请在预览中确认或使用“全选文件”。',
        optScan: '扫描会话期间新建的文件',
        optScanHint: '用于发现 shell、Python 等命令生成的中间文件和最终产物；扫描结果默认不勾选。',
        optSpills: '删除会话的工具输出临时文件',
        optSpillsHint: '清理 dsh-spill 根目录下以会话哈希命名的目录（过大的工具结果溢出文件）。',
        optImageCache: '同时清空附件请求缓存',
        optImageCacheHint: '删除全局可重建的缩略图/请求图像缓存。它会被所有会话共用，因此会影响其他会话的缓存命中，但不会删除持久附件。',
        preview: '预览清理',
        previewing: '正在扫描并核对引用…',
        previewFailed: '预览失败：{message}',
        previewTitle: '删除预览',
        previewStale: '选择或选项已变化，请重新预览。',
        sessionsSection: '会话数据',
        attachmentsSection: '附件',
        filesSection: '工作区文件',
        spillsSection: '工具输出临时文件',
        warnings: '提示',
        noAttachments: '没有被这些会话引用的附件。',
        noFiles: '没有发现可清理的工作区文件。',
        noSpills: '没有发现该会话的溢出文件目录。',
        logDir: '日志目录',
        logFiles: '文件：{names}',
        conversationFolder: '会话目录',
        conversationFolderSelected: '将整目录删除',
        conversationFolderKept: '保留目录',
        noConversationFolder: '未检测到对话专用目录',
        projectionCache: '投影检查点',
        noProjection: '无检查点',
        readError: '日志读取失败：{message}',
        sharedWith: '仍被 {count} 个其他会话引用',
        outsideWorkspace: '位于工作区之外，已保留',
        protectedItem: '受保护，不会删除',
        missingFile: '文件已不存在',
        symlink: '符号链接，不会删除',
        symlinkAncestor: '路径经过符号链接或 Junction，不会删除',
        referencesUnknown: '引用状态未知，已保留',
        sharedFolder: '所在会话目录仍被其他会话使用，已保留',
        notDeletable: '安全校验未通过，不会删除',
        folderUnknownEntries: '目录含 {count} 个未知顶层项',
        fileOrigin: '来源：{origins}',
        createdDuring: '会话期间新建',
        preExisting: '会话前已存在或创建时间未知',
        originWrite: '写入',
        originEdit: '编辑',
        originReplace: '替换编辑',
        originPresent: '交付',
        originScan: '扫描',
        attachmentImage: '图片',
        attachmentFile: '文件',
        attachmentUnknown: '附件',
        attachmentReasonShared: '仍被其他会话引用，已保留',
        attachmentReasonUnreadableSelected: '所选会话日志无法读取，已保留',
        attachmentReasonUnreadableRemaining: '其余会话日志无法读取，已保留',
        attachmentReasonUnrecognised: '附件标识无法定位，已保留',
        selectAllFiles: '全选文件',
        clearFiles: '清空文件',
        selectAllAttachments: '全选附件',
        clearAttachments: '清空附件',
        showAll: '显示全部 {count} 项',
        showLess: '收起',
        totals: '合计',
        sessionBytes: '会话日志',
        projectionBytes: '投影检查点',
        conversationBytes: '会话目录',
        attachmentBytes: '附件',
        fileBytes: '工作区文件',
        spillBytes: '工具输出临时文件',
        totalBytes: '总计',
        deleteTitle: '永久删除',
        deleteIntro: '将永久删除 {sessions} 个会话及其已勾选的内容。此操作不可撤销。',
        confirmNote: '点击“确认永久删除”后立即执行，无法恢复。',
        confirmButton: '确认永久删除',
        cancel: '取消',
        deleteButton: '永久删除所选内容',
        deleting: '正在删除…',
        deleteFailed: '删除失败：{message}',
        resultTitle: '清理完成',
        resultSummary: '已处理 {sessions} 个会话，删除日志 {logs} 份、检查点 {projections} 份、会话目录 {folders} 个、附件 {attachments} 个、工作区文件 {files} 个、工具输出临时目录 {spills} 个，共释放 {bytes}。',
        resultSkipped: '因共享引用、工作区边界或安全校验保留：附件 {attachments} 个、工作区文件 {files} 个、临时目录 {spills} 个。',
        resultConversationSkipped: '有 {count} 个会话目录因仍被其他会话使用或含有未知文件而保留。',
        resultMissing: '其中 {count} 个会话的日志此前已缺失，只清理了归档记录。',
        resultImageCache: '附件请求缓存已清空（{bytes}）。',
        resultErrors: '未完成的项目',
        resultWarnings: '提示',
        closeResult: '返回列表',
        refreshHint: '若侧边栏仍显示已删除的会话，刷新页面即可。',
        requestFailed: '请求失败：{message}',
        requestTimeout: '请求超时或已取消，请重试。',
        stalePreview: '预览已过期，已为你清除。请重新预览后再删除。',
        dangerBadge: '永久',
        archiveOnly: '仅归档记录',
      },
      en: {
        navLabel: 'Session cleanup',
        title: 'Session cleanup',
        intro: 'Pick archived Sessions, preview everything a permanent deletion would remove, then confirm. Deletion covers Session logs, projection checkpoints, attachments referenced only by these Sessions, and files the Sessions produced in their workspace.',
        dangerNote: 'Permanent deletion cannot be undone. The preview lists every path; check that nothing you still need is included.',
        openNote: 'Sessions marked “Open (restart)” are still loaded by Harness. Restart Harness first (archive state is kept), then clean them up; otherwise they linger under Ungrouped.',
        loading: 'Reading archived Sessions…',
        loadFailed: 'Could not read archived Sessions: {message}',
        retry: 'Retry',
        refresh: 'Refresh',
        empty: 'There are no archived Sessions.',
        selectAll: 'Select all',
        clear: 'Clear',
        selected: '{count} Sessions selected',
        totalSize: '{size} in the list',
        live: 'Live',
        opened: 'Open (restart)',
        missing: 'Log missing',
        untitled: 'Untitled Session',
        messages: '{count} records',
        workspace: 'Workspace',
        noWorkspace: 'No workspace',
        openWorkspace: 'Open folder',
        openWorkspaceFailed: 'Could not open the directory: {message}',
        noWorkspacePath: 'This Session has no openable directory.',
        optionsTitle: 'Cleanup scope',
        optConversationFolder: 'Delete the per-Session conversation folder',
        optConversationFolderHint: 'Removes the conversations/<timestamp_title>/ folder created by session-archive, including work, out, session.json, and the AGENTS.md copy; its index.json entry is removed too. The folder is kept when another Session still uses it or it contains unexpected top-level entries.',
        optFolderUnknown: 'Also delete unexpected files in the conversation folder',
        optFolderUnknownHint: 'Only needed when the folder contains entries other than work/out/session.json/AGENTS.md. Off by default; while off, whole-folder deletion is blocked and the entries are listed in the preview.',
        optAttachments: 'Delete attachments referenced only by these Sessions',
        optAttachmentsHint: 'The remaining Sessions are scanned first; an attachment still referenced elsewhere is kept. Only Session-log references are checked; drafts and external programs are not visible.',
        optFiles: 'Delete files these Sessions produced in the workspace',
        optFilesHint: 'Candidates come from file-tool calls and the Session time window; scanned files start unchecked. Review them or use “Select all files”.',
        optScan: 'Scan for files created during the Session',
        optScanHint: 'Finds intermediate and final files made by shell, Python, and similar commands; scan results start unchecked.',
        optSpills: 'Delete the Session’s spilled tool-output files',
        optSpillsHint: 'Clears the session-hash directories under dsh-spill roots that hold oversized tool results.',
        optImageCache: 'Also clear the attachment request cache',
        optImageCacheHint: 'Removes the global rebuildable thumbnail/request-image cache. Every Session shares it, so this affects other Sessions’ cache hits but never removes durable attachments.',
        preview: 'Preview cleanup',
        previewing: 'Scanning and checking references…',
        previewFailed: 'Preview failed: {message}',
        previewTitle: 'Deletion preview',
        previewStale: 'The selection or options changed. Preview again.',
        sessionsSection: 'Session data',
        attachmentsSection: 'Attachments',
        filesSection: 'Workspace files',
        spillsSection: 'Spilled tool output',
        warnings: 'Notes',
        noAttachments: 'No attachment is referenced by these Sessions.',
        noFiles: 'No workspace file was found to clean up.',
        noSpills: 'No spill directory was found for this Session.',
        logDir: 'Log directory',
        logFiles: 'Files: {names}',
        conversationFolder: 'Conversation folder',
        conversationFolderSelected: 'whole folder will be deleted',
        conversationFolderKept: 'folder kept',
        noConversationFolder: 'No per-conversation folder detected',
        projectionCache: 'Projection checkpoint',
        noProjection: 'No checkpoint',
        readError: 'Log read failed: {message}',
        sharedWith: 'Still referenced by {count} other Session(s)',
        outsideWorkspace: 'Outside the workspace; kept',
        protectedItem: 'Protected; will not be deleted',
        missingFile: 'File no longer exists',
        symlink: 'Symbolic link; will not be deleted',
        symlinkAncestor: 'Path crosses a symlink or junction; will not be deleted',
        referencesUnknown: 'Reference state unknown; kept',
        sharedFolder: 'Containing conversation folder is still in use; kept',
        notDeletable: 'Failed the safety check; will not be deleted',
        folderUnknownEntries: 'Folder has {count} unexpected top-level entries',
        fileOrigin: 'Origin: {origins}',
        createdDuring: 'Created during the Session',
        preExisting: 'Existed before the Session or creation time unknown',
        originWrite: 'write',
        originEdit: 'edit',
        originReplace: 'replace-edit',
        originPresent: 'present',
        originScan: 'scan',
        attachmentImage: 'Image',
        attachmentFile: 'File',
        attachmentUnknown: 'Attachment',
        attachmentReasonShared: 'Still referenced by another Session; kept',
        attachmentReasonUnreadableSelected: 'A selected Session log is unreadable; kept',
        attachmentReasonUnreadableRemaining: 'A remaining Session log is unreadable; kept',
        attachmentReasonUnrecognised: 'The attachment id cannot be located; kept',
        selectAllFiles: 'Select all files',
        clearFiles: 'Clear files',
        selectAllAttachments: 'Select all attachments',
        clearAttachments: 'Clear attachments',
        showAll: 'Show all {count}',
        showLess: 'Show less',
        totals: 'Totals',
        sessionBytes: 'Session logs',
        projectionBytes: 'Checkpoints',
        conversationBytes: 'Conversation folder',
        attachmentBytes: 'Attachments',
        fileBytes: 'Workspace files',
        spillBytes: 'Spilled tool output',
        totalBytes: 'Total',
        deleteTitle: 'Permanent deletion',
        deleteIntro: 'Permanently delete {sessions} Session(s) and the checked content. This cannot be undone.',
        confirmNote: '“Confirm permanent deletion” runs immediately and cannot be undone.',
        confirmButton: 'Confirm permanent deletion',
        cancel: 'Cancel',
        deleteButton: 'Permanently delete the selection',
        deleting: 'Deleting…',
        deleteFailed: 'Deletion failed: {message}',
        resultTitle: 'Cleanup complete',
        resultSummary: 'Processed {sessions} Session(s), removed {logs} log(s), {projections} checkpoint(s), {folders} conversation folder(s), {attachments} attachment(s), {files} workspace file(s), and {spills} spill director(ies), freeing {bytes}.',
        resultSkipped: 'Kept by sharing, workspace-boundary, or safety checks: {attachments} attachment(s), {files} workspace file(s), {spills} spill director(ies).',
        resultConversationSkipped: '{count} conversation folder(s) were kept because another Session still uses them or they contain unexpected files.',
        resultMissing: '{count} Session log(s) were already missing; only archive records were cleaned.',
        resultImageCache: 'The attachment request cache was cleared ({bytes}).',
        resultErrors: 'Items not completed',
        resultWarnings: 'Notes',
        closeResult: 'Back to the list',
        refreshHint: 'If the sidebar still shows a deleted Session, reload the page.',
        requestFailed: 'Request failed: {message}',
        requestTimeout: 'The request timed out or was cancelled. Try again.',
        stalePreview: 'The preview expired and was cleared. Preview again before deleting.',
        dangerBadge: 'Permanent',
        archiveOnly: 'Archive only',
      },
    }

    const STYLE = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '4px 0 40px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.55,
      },
      header: { display: 'flex', flexDirection: 'column', gap: 6 },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      note: {
        margin: 0,
        padding: '9px 11px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '11px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flexWrap: 'wrap',
      },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      cardBody: { padding: '10px 14px 14px' },
      row: {
        display: 'flex',
        gap: 10,
        padding: '9px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        alignItems: 'flex-start',
      },
      rowLast: { borderBottom: 'none' },
      checkbox: { marginTop: 3, accentColor: 'var(--dsw-alias-brand-primary)', flex: 'none' },
      grow: { flex: 1, minWidth: 0 },
      strong: { fontWeight: 550 },
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, overflowWrap: 'anywhere' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        overflowWrap: 'anywhere',
      },
      button: {
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      iconButton: {
        width: 28,
        height: 28,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      iconButtonHover: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: {
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      danger: {
        background: 'var(--dsw-alias-state-error-primary)',
        borderColor: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      dangerGhost: {
        color: 'var(--dsw-alias-state-error-primary)',
        borderColor: 'var(--dsw-alias-state-error-primary)',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
      input: {
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        width: 180,
        boxSizing: 'border-box',
      },
      badge: {
        display: 'inline-block',
        padding: '0 5px',
        marginLeft: 6,
        borderRadius: 5,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10,
        lineHeight: '17px',
        verticalAlign: 'middle',
      },
      badgeWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
      badgeDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', overflowWrap: 'anywhere' },
      list: { maxHeight: 280, overflowY: 'auto' },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8,
      },
      stat: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 9,
        padding: '8px 10px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      statLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      statValue: { fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      spacer: { flex: 1 },
      optionRow: { display: 'flex', gap: 9, padding: '7px 0', alignItems: 'flex-start' },
      inline: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      confirmRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      confirmBox: {
        marginTop: 10,
        padding: '10px 12px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      empty: { color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' },
    }

    async function callApi(op, payload, options = {}) {
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 600000
      const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined
      let signal = options.signal ?? timeoutSignal
      if (options.signal !== undefined && timeoutSignal !== undefined && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([options.signal, timeoutSignal])
      }
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
        },
        signal,
        body: JSON.stringify({ op, ...payload }),
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        const error = new Error(data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`)
        error.code = data && data.error && data.error.code ? data.error.code : 'request-failed'
        throw error
      }
      return data.value
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let amount = value
      let index = 0
      while (amount >= 1024 && index < units.length - 1) {
        amount /= 1024
        index += 1
      }
      return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`
    }

    function formatDate(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    function previewBadge(text, extra) {
      return h('span', { style: { ...STYLE.badge, ...(extra || {}) } }, text)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-cleaner: dictionaries')
      const t = ctx.locale.bind(NS)

      function Check(props) {
        return h('input', {
          type: 'checkbox',
          style: STYLE.checkbox,
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
          'aria-label': props.label,
        })
      }

      function FolderIcon() {
        return h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            d: 'M3.5 7.2A2.2 2.2 0 0 1 5.7 5h4.1l2 2.2h6.5a2.2 2.2 0 0 1 2.2 2.2v7.4a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M3.8 9.6h16.4',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
          }),
        )
      }

      function FolderButton(props) {
        const [hovered, setHovered] = useState(false)
        return h(
          'button',
          {
            type: 'button',
            title: props.title,
            'aria-label': props.title,
            disabled: props.disabled === true,
            onClick: props.onClick,
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            style: {
              ...STYLE.iconButton,
              ...(hovered && props.disabled !== true ? STYLE.iconButtonHover : {}),
              ...(props.disabled === true ? STYLE.disabled : {}),
            },
          },
          props.busy === true ? h('span', { style: { fontSize: 12, lineHeight: 1 } }, '…') : h(FolderIcon),
        )
      }

      function SessionRow(props) {
        const session = props.session
        const meta = []
        if (session.workspace) meta.push(`${t('workspace')} · ${session.workspace.title}`)
        else meta.push(t('noWorkspace'))
        meta.push(formatDate(session.createdAt))
        if (session.sizeBytes) meta.push(formatBytes(session.sizeBytes))
        if (session.eventCount) meta.push(t('messages', { count: session.eventCount }))
        const openPath = session.conversationFolder || session.cwd || (session.workspace && session.workspace.path)
        return h(
          'div',
          { style: { ...STYLE.row, ...(props.last ? STYLE.rowLast : {}) } },
          h(Check, {
            checked: props.checked,
            disabled: session.live === true || session.open === true,
            onChange: () => props.onToggle(session.id),
            label: session.title || session.id,
          }),
          h(
            'div',
            { style: STYLE.grow },
            h(
              'div',
              { style: STYLE.strong },
              session.title || t('untitled'),
              session.live ? previewBadge(t('live'), STYLE.badgeWarn) : null,
              session.open && !session.live ? previewBadge(t('opened'), STYLE.badgeWarn) : null,
              session.missing ? previewBadge(t('missing'), STYLE.badgeDanger) : null,
            ),
            h('div', { style: STYLE.meta }, meta.join(' · ')),
            h('div', { style: STYLE.mono }, session.id),
            props.error ? h('div', { style: { ...STYLE.error, marginTop: 2 } }, props.error) : null,
          ),
          h(FolderButton, {
            disabled: typeof openPath !== 'string' || openPath.length === 0,
            busy: props.opening === true,
            title: openPath
              ? `${t('openWorkspace')}${session.workspace ? ` · ${session.workspace.title}` : ''}`
              : t('noWorkspacePath'),
            onClick: () => props.onOpen(session),
          }),
        )
      }

      function FileRow(props) {
        const file = props.file
        const deletable = file.deletable !== undefined
          ? file.deletable === true
          : file.protected !== true &&
            file.exists === true &&
            file.outsideWorkspace !== true &&
            file.referencesUnknown !== true &&
            !(file.sharedWith && file.sharedWith.length > 0)
        const disabled = !deletable
        const origins = (file.origins || [])
          .map((origin) => t(origin === 'write' ? 'originWrite' : origin === 'edit' ? 'originEdit' : origin === 'str_replace_editor' ? 'originReplace' : origin === 'present' ? 'originPresent' : 'originScan'))
          .join(' / ')
        const reasonText = file.reasonCode === 'missing'
          ? t('missingFile')
          : file.reasonCode === 'symlink'
            ? t('symlink')
            : file.reasonCode === 'symlink-ancestor'
              ? t('symlinkAncestor')
              : file.reasonCode === 'references-unknown'
                ? t('referencesUnknown')
                : file.reasonCode === 'shared-folder'
                  ? t('sharedFolder')
                  : file.reasonCode === 'outside-workspace'
                    ? t('outsideWorkspace')
                    : t('notDeletable')
        return h(
          'div',
          { style: { ...STYLE.row, ...(props.last ? STYLE.rowLast : {}) } },
          h(Check, {
            checked: props.checked && !disabled,
            disabled,
            onChange: () => props.onToggle(file.path),
            label: file.path,
          }),
          h(
            'div',
            { style: STYLE.grow },
            h('div', { style: STYLE.mono }, file.path),
            h(
              'div',
              { style: STYLE.meta },
              [
                formatBytes(file.sizeBytes),
                t('fileOrigin', { origins }),
                file.createdDuring ? t('createdDuring') : t('preExisting'),
              ].join(' · '),
              file.outsideWorkspace ? previewBadge(t('outsideWorkspace'), STYLE.badgeWarn) : null,
              file.sharedWith && file.sharedWith.length > 0
                ? previewBadge(t('sharedWith', { count: file.sharedWith.length }), STYLE.badgeWarn)
                : null,
              disabled && file.reasonCode !== 'outside-workspace' && file.reasonCode !== 'shared'
                ? previewBadge(reasonText, STYLE.badgeDanger)
                : null,
            ),
          ),
        )
      }

      function AttachmentRow(props) {
        const attachment = props.attachment
        const kind = attachment.kind === 'image' ? t('attachmentImage') : attachment.kind === 'file' ? t('attachmentFile') : t('attachmentUnknown')
        const reasonText = attachment.reasonCode === 'shared'
          ? t('attachmentReasonShared')
          : attachment.reasonCode === 'unreadable-selected'
            ? t('attachmentReasonUnreadableSelected')
            : attachment.reasonCode === 'unreadable-remaining'
              ? t('attachmentReasonUnreadableRemaining')
              : attachment.reasonCode === 'unrecognised'
                ? t('attachmentReasonUnrecognised')
                : attachment.reason
        return h(
          'div',
          { style: { ...STYLE.row, ...(props.last ? STYLE.rowLast : {}) } },
          h(Check, {
            checked: props.checked && attachment.deletable === true,
            disabled: attachment.deletable !== true,
            onChange: () => props.onToggle(attachment.id),
            label: attachment.name || attachment.id,
          }),
          h(
            'div',
            { style: STYLE.grow },
            h('div', { style: STYLE.strong }, attachment.name || attachment.id),
            h(
              'div',
              { style: STYLE.meta },
              `${kind} · ${formatBytes(attachment.bytes)}`,
              attachment.sharedWith && attachment.sharedWith.length > 0
                ? previewBadge(t('sharedWith', { count: attachment.sharedWith.length }), STYLE.badgeWarn)
                : null,
              attachment.deletable !== true && reasonText
                ? previewBadge(reasonText, STYLE.badgeWarn)
                : null,
            ),
            h('div', { style: STYLE.mono }, attachment.id),
          ),
        )
      }

      function CleanupPage() {
        const [phase, setPhase] = useState('loading')
        const [sessions, setSessions] = useState([])
        const [selected, setSelected] = useState(() => new Set())
        const [options, setOptions] = useState({
          conversationFolder: true,
          allowUnknownFolderEntries: false,
          attachments: true,
          workspaceFiles: true,
          scanCreated: true,
          spills: true,
          imageCache: false,
        })
        const [preview, setPreview] = useState(null)
        const [previewToken, setPreviewToken] = useState(null)
        const [previewing, setPreviewing] = useState(false)
        const [previewError, setPreviewError] = useState(null)
        const [fileChoice, setFileChoice] = useState(() => new Map())
        const [attachmentChoice, setAttachmentChoice] = useState(() => new Map())
        const [showAllFiles, setShowAllFiles] = useState(false)
        const [confirming, setConfirming] = useState(false)
        const [deleting, setDeleting] = useState(false)
        const [deleteError, setDeleteError] = useState(null)
        const [report, setReport] = useState(null)
        const [openingId, setOpeningId] = useState(null)
        const [openError, setOpenError] = useState(null)
        const requestSeq = useRef(0)
        const loadAbort = useRef(null)
        const previewAbort = useRef(null)

        const messageOf = (error) => {
          if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return t('requestTimeout')
          return error instanceof Error ? error.message : String(error)
        }

        const load = useCallback(async () => {
          const seq = ++requestSeq.current
          previewAbort.current?.abort()
          previewAbort.current = null
          loadAbort.current?.abort()
          const controller = new AbortController()
          loadAbort.current = controller
          setPhase('loading')
          setPreview(null)
          setPreviewToken(null)
          setPreviewing(false)
          setPreviewError(null)
          setFileChoice(new Map())
          setAttachmentChoice(new Map())
          setConfirming(false)
          setDeleteError(null)
          setOpenError(null)
          try {
            const value = await callApi('list', {}, { signal: controller.signal, timeoutMs: 60000 })
            if (seq !== requestSeq.current) return
            const list = Array.isArray(value.sessions) ? value.sessions : []
            setSessions(list)
            setSelected((previous) => {
              const next = new Set()
              for (const id of previous) {
                if (list.some((session) => session.id === id && session.live !== true && session.open !== true)) next.add(id)
              }
              return next
            })
            setPhase('ready')
          } catch (error) {
            if (seq !== requestSeq.current) return
            setPhase('error')
            setPreviewError(error && (error.name === 'AbortError' || error.name === 'TimeoutError')
              ? t('requestTimeout')
              : (error instanceof Error ? error.message : String(error)))
          } finally {
            if (loadAbort.current === controller) loadAbort.current = null
          }
        }, [])

        useEffect(() => {
          load()
          return () => {
            loadAbort.current?.abort()
            previewAbort.current?.abort()
          }
        }, [load])

        const openWorkspace = async (session) => {
          setOpeningId(session.id)
          setOpenError(null)
          const paths = []
          if (typeof session.conversationFolder === 'string' && session.conversationFolder.length > 0) {
            paths.push(session.conversationFolder)
          }
          try {
            const resolved = await callApi('project-path', { sessionId: session.id }, { timeoutMs: 60000 })
            if (resolved && typeof resolved.path === 'string' && resolved.path.length > 0) {
              paths.push(resolved.path)
            }
          } catch {
            /* an older Host or a transient read failure falls back to stored paths */
          }
          if (typeof session.cwd === 'string' && session.cwd.length > 0) paths.push(session.cwd)
          if (session.workspace && typeof session.workspace.path === 'string' && session.workspace.path.length > 0) {
            paths.push(session.workspace.path)
          }
          if (paths.length === 0) {
            setOpeningId(null)
            setOpenError({ id: session.id, message: t('noWorkspacePath') })
            return
          }
          let lastMessage = t('openWorkspaceFailed', { message: 'open failed' })
          try {
            const sessionRemote = ctx.remote && ctx.remote.session
            if (sessionRemote === undefined || typeof sessionRemote.openWorkspacePath !== 'function') {
              lastMessage = t('openWorkspaceFailed', { message: 'the session Remote is unavailable' })
            } else {
              for (const path of [...new Set(paths)]) {
                try {
                  const result = await sessionRemote.openWorkspacePath({ path }, new AbortController().signal)
                  if (result && result.ok === false) {
                    lastMessage = result.error && result.error.message ? result.error.message : lastMessage
                    continue
                  }
                  if ((result && result.ok === true) || (result && result.opened === true)) return
                  lastMessage = t('openWorkspaceFailed', { message: 'open failed' })
                } catch (error) {
                  lastMessage = error instanceof Error ? error.message : String(error)
                }
              }
            }
            setOpenError({ id: session.id, message: lastMessage })
          } finally {
            setOpeningId(null)
          }
        }

        const invalidatePreview = () => {
          requestSeq.current += 1
          previewAbort.current?.abort()
          previewAbort.current = null
          setPreview(null)
          setPreviewToken(null)
          setPreviewing(false)
          setPreviewError(null)
          setConfirming(false)
          setDeleteError(null)
        }

        const toggleSession = (id) => {
          setSelected((previous) => {
            const next = new Set(previous)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
          invalidatePreview()
        }

        const selectAll = () => {
          setSelected(new Set(sessions.filter((session) => session.live !== true && session.open !== true).map((session) => session.id)))
          invalidatePreview()
        }

        const clearSelection = () => {
          setSelected(new Set())
          invalidatePreview()
        }

        const setOption = (key, value) => {
          setOptions((previous) => ({ ...previous, [key]: value }))
          invalidatePreview()
        }

        const previewNow = async () => {
          if (selected.size === 0) return
          const seq = ++requestSeq.current
          previewAbort.current?.abort()
          const controller = new AbortController()
          previewAbort.current = controller
          setPreviewing(true)
          setPreviewError(null)
          setDeleteError(null)
          setReport(null)
          setConfirming(false)
          try {
            const value = await callApi('preview', { ids: [...selected], options }, {
              signal: controller.signal,
              timeoutMs: 600000,
            })
            if (seq !== requestSeq.current) return
            if (typeof value.previewToken !== 'string') {
              setPreview(null)
              setPreviewToken(null)
              setPreviewError(t('stalePreview'))
              return
            }
            setPreview(value)
            setPreviewToken(value.previewToken)
            setFileChoice(new Map((value.files || []).map((file) => [file.path, file.deletable === true && file.selectedByDefault === true])))
            setAttachmentChoice(new Map((value.attachments || []).map((attachment) => [attachment.id, attachment.deletable === true])))
            setShowAllFiles(false)
          } catch (error) {
            if (seq !== requestSeq.current) return
            setPreview(null)
            setPreviewToken(null)
            setPreviewError(messageOf(error))
          } finally {
            if (seq === requestSeq.current) setPreviewing(false)
            if (previewAbort.current === controller) previewAbort.current = null
          }
        }

        const requestDelete = () => {
          if (preview === null || previewToken === null || selected.size === 0 || deleting) return
          setConfirming(true)
          setDeleteError(null)
        }

        const deleteNow = async () => {
          if (preview === null || previewToken === null || confirming !== true || deleting) return
          setDeleting(true)
          setDeleteError(null)
          try {
            const value = await callApi('delete', {
              ids: [...selected],
              options,
              previewToken,
              confirmed: true,
              files: [...fileChoice.entries()].filter(([, checked]) => checked).map(([path]) => path),
              attachments: [...attachmentChoice.entries()].filter(([, checked]) => checked).map(([id]) => id),
            }, { timeoutMs: 900000 })
            setReport(value)
            setPreview(null)
            setPreviewToken(null)
            setSelected(new Set())
            setConfirming(false)
            setDeleteError(null)
            try {
              const clientSessions = ctx.get('sessions')
              if (clientSessions && typeof clientSessions.refresh === 'function') await clientSessions.refresh()
            } catch {
              /* the list below still refreshes from the Host */
            }
            await load()
          } catch (error) {
            const message = messageOf(error)
            if (error && (error.code === 'stale-preview' || error.code === 'preview-required')) {
              setPreview(null)
              setPreviewToken(null)
              setConfirming(false)
              setPreviewError(t('stalePreview'))
            }
            setDeleteError(message)
          } finally {
            setDeleting(false)
          }
        }

        const cancelDelete = () => {
          setConfirming(false)
          setDeleteError(null)
        }

        const totalSelectedBytes = useMemo(
          () => sessions.filter((session) => selected.has(session.id)).reduce((sum, session) => sum + (session.sizeBytes || 0), 0),
          [sessions, selected],
        )
        const displayFiles = preview === null
          ? []
          : showAllFiles
            ? preview.files || []
            : (preview.files || []).slice(0, FILE_PAGE)
        const canDelete = preview !== null && previewToken !== null && selected.size > 0 && !deleting

        return h(
          'div',
          { style: STYLE.root },
          h(
            'div',
            { style: STYLE.header },
            h('h2', { style: STYLE.title }, t('title')),
            h('p', { style: STYLE.intro }, t('intro')),
            h('p', { style: STYLE.note }, t('dangerNote')),
            h('p', { style: STYLE.meta }, t('openNote')),
          ),

          h(
            'section',
            { style: STYLE.card },
            h(
              'div',
              { style: STYLE.cardHead },
              h('h3', { style: STYLE.cardTitle }, `${t('sessionsSection')} · ${sessions.length}`),
              h(
                'div',
                { style: STYLE.inline },
                h('button', { type: 'button', style: STYLE.button, onClick: selectAll, disabled: sessions.length === 0 }, t('selectAll')),
                h('button', { type: 'button', style: STYLE.button, onClick: clearSelection, disabled: selected.size === 0 }, t('clear')),
                h('button', { type: 'button', style: STYLE.button, onClick: load }, t('refresh')),
              ),
            ),
            h(
              'div',
              { style: STYLE.cardBody },
              phase === 'loading'
                ? h('div', { style: STYLE.empty }, t('loading'))
                : phase === 'error'
                  ? h('div', null,
                      h('div', { style: STYLE.error }, t('loadFailed', { message: previewError || '' })),
                      h('button', { type: 'button', style: { ...STYLE.button, marginTop: 8 }, onClick: load }, t('retry')),
                    )
                  : sessions.length === 0
                    ? h('div', { style: STYLE.empty }, t('empty'))
                    : h(
                        'div',
                        { style: STYLE.list },
                        sessions.map((session, index) =>
                          h(SessionRow, {
                            key: session.id,
                            session,
                            checked: selected.has(session.id),
                            onToggle: toggleSession,
                            onOpen: openWorkspace,
                            opening: openingId === session.id,
                            error: openError && openError.id === session.id ? openError.message : null,
                            last: index === sessions.length - 1,
                          }),
                        ),
                      ),
            ),
          ),

          h(
            'section',
            { style: STYLE.card },
            h('div', { style: STYLE.cardHead }, h('h3', { style: STYLE.cardTitle }, t('optionsTitle'))),
            h(
              'div',
              { style: STYLE.cardBody },
              h(OptionRow, {
                checked: options.conversationFolder,
                onChange: (value) => setOption('conversationFolder', value),
                title: t('optConversationFolder'),
                hint: t('optConversationFolderHint'),
              }),
              h(OptionRow, {
                checked: options.allowUnknownFolderEntries,
                disabled: !options.conversationFolder,
                onChange: (value) => setOption('allowUnknownFolderEntries', value),
                title: t('optFolderUnknown'),
                hint: t('optFolderUnknownHint'),
              }),
              h(OptionRow, {
                checked: options.attachments,
                onChange: (value) => setOption('attachments', value),
                title: t('optAttachments'),
                hint: t('optAttachmentsHint'),
              }),
              h(OptionRow, {
                checked: options.workspaceFiles,
                onChange: (value) => setOption('workspaceFiles', value),
                title: t('optFiles'),
                hint: t('optFilesHint'),
              }),
              h(OptionRow, {
                checked: options.scanCreated,
                disabled: !options.workspaceFiles,
                onChange: (value) => setOption('scanCreated', value),
                title: t('optScan'),
                hint: t('optScanHint'),
              }),
              h(OptionRow, {
                checked: options.spills,
                onChange: (value) => setOption('spills', value),
                title: t('optSpills'),
                hint: t('optSpillsHint'),
              }),
              h(OptionRow, {
                checked: options.imageCache,
                onChange: (value) => setOption('imageCache', value),
                title: t('optImageCache'),
                hint: t('optImageCacheHint'),
                last: true,
              }),
            ),
          ),

          h(
            'div',
            { style: STYLE.actions },
            h(
              'button',
              {
                type: 'button',
                style: { ...STYLE.button, ...STYLE.primary, ...(selected.size === 0 || previewing ? STYLE.disabled : {}) },
                disabled: selected.size === 0 || previewing,
                onClick: previewNow,
              },
              previewing ? t('previewing') : t('preview'),
            ),
            h('span', { style: STYLE.meta }, `${t('selected', { count: selected.size })} · ${formatBytes(totalSelectedBytes)}`),
            h('span', { style: STYLE.spacer }),
            h('span', { style: STYLE.meta }, t('totalSize', { size: formatBytes(sessions.reduce((sum, session) => sum + (session.sizeBytes || 0), 0)) })),
          ),

          previewError
            ? h('div', { style: STYLE.error }, t('previewFailed', { message: previewError }))
            : null,

          preview !== null ? h(
            'section',
            { style: STYLE.card },
            h(
              'div',
              { style: STYLE.cardHead },
              h('h3', { style: STYLE.cardTitle }, t('previewTitle')),
            ),
            h(
              'div',
              { style: STYLE.cardBody },
              h(
                'div',
                { style: STYLE.grid },
                stat(t('sessionBytes'), formatBytes(preview.totals.sessionBytes)),
                stat(t('projectionBytes'), formatBytes(preview.totals.projectionBytes)),
                stat(t('conversationBytes'), formatBytes(preview.totals.conversationBytes || 0)),
                stat(t('attachmentBytes'), formatBytes(preview.totals.attachmentBytes)),
                stat(t('fileBytes'), formatBytes(preview.totals.fileBytes)),
                stat(t('spillBytes'), formatBytes(preview.totals.spillBytes || 0)),
                stat(t('totalBytes'), formatBytes(preview.totals.totalBytes)),
              ),

              h('h4', { style: STYLE.cardTitle }, t('sessionsSection')),
              (preview.sessions || []).map((session, index) =>
                h('div', {
                  key: session.id,
                  style: { ...STYLE.row, ...(index === preview.sessions.length - 1 ? STYLE.rowLast : {}) },
                },
                  h('div', { style: STYLE.grow },
                    h('div', { style: STYLE.strong },
                      session.title || t('untitled'),
                      session.live ? previewBadge(t('live'), STYLE.badgeWarn) : null,
                      session.open && !session.live ? previewBadge(t('opened'), STYLE.badgeWarn) : null,
                    ),
                    h('div', { style: STYLE.mono }, session.id),
                    session.logDir
                      ? h('div', { style: STYLE.meta }, `${t('logDir')}: ${session.logDir} · ${formatBytes(session.logBytes)}`)
                      : h('div', { style: STYLE.warn }, t('archiveOnly')),
                    session.projectionCache && session.projectionCache.exists
                      ? h('div', { style: STYLE.meta }, `${t('projectionCache')}: ${session.projectionCache.path} · ${formatBytes(session.projectionCache.bytes)}`)
                      : h('div', { style: STYLE.meta }, t('noProjection')),
                    session.conversationFolder
                      ? h('div', { style: STYLE.meta },
                          `${t('conversationFolder')}: ${session.conversationFolder.path} · ${formatBytes(session.conversationFolder.bytes)} · ${session.conversationFolder.selected ? t('conversationFolderSelected') : t('conversationFolderKept')}`)
                      : h('div', { style: STYLE.meta }, t('noConversationFolder')),
                    session.conversationFolder && (session.conversationFolder.entries || []).length > 0
                      ? h('div', { style: STYLE.mono }, session.conversationFolder.entries.join(' · '))
                      : null,
                    session.conversationFolder && session.conversationFolder.sharedWith && session.conversationFolder.sharedWith.length > 0
                      ? previewBadge(t('sharedWith', { count: session.conversationFolder.sharedWith.length }), STYLE.badgeWarn)
                      : null,
                    session.conversationFolder && session.conversationFolder.referencesUnknown
                      ? previewBadge(t('referencesUnknown'), STYLE.badgeWarn)
                      : null,
                    session.conversationFolder && session.conversationFolder.unknownCount > 0
                      ? previewBadge(t('folderUnknownEntries', { count: session.conversationFolder.unknownCount }), STYLE.badgeWarn)
                      : null,
                    session.conversationFolder && session.conversationFolder.reason
                      ? h('div', { style: STYLE.warn }, session.conversationFolder.reason)
                      : null,
                    session.conversationFolder && (session.conversationFolder.unknownEntries || []).length > 0
                      ? h('div', { style: STYLE.mono }, session.conversationFolder.unknownEntries.join(' · '))
                      : null,
                    session.readError ? h('div', { style: STYLE.warn }, t('readError', { message: session.readError })) : null,
                  ),
                ),
              ),

              h('h4', { style: STYLE.cardTitle }, t('attachmentsSection')),
              (preview.attachments || []).length === 0
                ? h('div', { style: STYLE.empty }, t('noAttachments'))
                : h('div',
                    { style: STYLE.inline },
                    h('button', {
                      type: 'button',
                      style: STYLE.button,
                      onClick: () => setAttachmentChoice(new Map((preview.attachments || []).filter((a) => a.deletable).map((a) => [a.id, true]))),
                    }, t('selectAllAttachments')),
                    h('button', {
                      type: 'button',
                      style: STYLE.button,
                      onClick: () => setAttachmentChoice(new Map((preview.attachments || []).map((a) => [a.id, false]))),
                    }, t('clearAttachments')),
                  ),
              (preview.attachments || []).map((attachment, index) =>
                h(AttachmentRow, {
                  key: attachment.id,
                  attachment,
                  checked: attachmentChoice.get(attachment.id) === true,
                  onToggle: (id) => setAttachmentChoice((previous) => {
                    const next = new Map(previous)
                    next.set(id, !next.get(id))
                    return next
                  }),
                  last: index === preview.attachments.length - 1,
                }),
              ),

              h('h4', { style: STYLE.cardTitle }, t('filesSection')),
              (preview.files || []).length === 0
                ? h('div', { style: STYLE.empty }, t('noFiles'))
                : h('div',
                    { style: STYLE.inline },
                    h('button', {
                      type: 'button',
                      style: STYLE.button,
                      onClick: () => setFileChoice(new Map((preview.files || [])
                        .filter((f) => f.deletable === true && f.createdDuring === true)
                        .map((f) => [f.path, true]))),
                    }, t('selectAllFiles')),
                    h('button', {
                      type: 'button',
                      style: STYLE.button,
                      onClick: () => setFileChoice(new Map((preview.files || []).map((f) => [f.path, false]))),
                    }, t('clearFiles')),
                  ),
              displayFiles.map((file, index) =>
                h(FileRow, {
                  key: file.path,
                  file,
                  checked: fileChoice.get(file.path) === true,
                  onToggle: (path) => setFileChoice((previous) => {
                    const next = new Map(previous)
                    next.set(path, !next.get(path))
                    return next
                  }),
                  last: index === displayFiles.length - 1,
                }),
              ),
              (preview.files || []).length > FILE_PAGE
                ? h('button', {
                    type: 'button',
                    style: { ...STYLE.button, marginTop: 8 },
                    onClick: () => setShowAllFiles((value) => !value),
                  }, showAllFiles ? t('showLess') : t('showAll', { count: preview.files.length }))
                : null,

              h('h4', { style: STYLE.cardTitle }, t('spillsSection')),
              (preview.spills || []).length === 0
                ? h('div', { style: STYLE.empty }, t('noSpills'))
                : (preview.spills || []).map((spill, index) =>
                    h('div', {
                      key: `${spill.root}|${spill.directory}`,
                      style: { ...STYLE.row, ...(index === preview.spills.length - 1 ? STYLE.rowLast : {}) },
                    },
                      h('div', { style: STYLE.grow },
                        h('div', { style: STYLE.mono }, spill.directory),
                        h('div', { style: STYLE.meta }, `${formatBytes(spill.bytes)} · ${spill.root}`),
                      ),
                    ),
                  ),

              (preview.warnings || []).length > 0
                ? h('div', null,
                    h('h4', { style: STYLE.cardTitle }, t('warnings')),
                    preview.warnings.map((warning, index) => h('div', { key: index, style: STYLE.warn }, warning)),
                  )
                : null,
            ),
          ) : null,

          preview !== null
            ? h(
                'section',
                { style: STYLE.card },
                h('div', { style: STYLE.cardHead }, h('h3', { style: STYLE.cardTitle }, t('deleteTitle'))),
                h(
                  'div',
                  { style: STYLE.cardBody },
                  h('p', { style: STYLE.meta }, t('deleteIntro', { sessions: selected.size })),
                  confirming
                    ? h(
                        'div',
                        { style: STYLE.confirmBox },
                        h('div', { style: STYLE.warn }, t('confirmNote')),
                        h(
                          'div',
                          { style: { ...STYLE.confirmRow, marginTop: 10 } },
                          h(
                            'button',
                            {
                              type: 'button',
                              style: { ...STYLE.button, ...STYLE.danger, ...(deleting ? STYLE.disabled : {}) },
                              disabled: deleting,
                              onClick: deleteNow,
                            },
                            deleting ? t('deleting') : t('confirmButton'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              autoFocus: true,
                              style: { ...STYLE.button, ...(deleting ? STYLE.disabled : {}) },
                              disabled: deleting,
                              onClick: cancelDelete,
                            },
                            t('cancel'),
                          ),
                        ),
                      )
                    : h(
                        'div',
                        { style: { ...STYLE.confirmRow, marginTop: 10 } },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: { ...STYLE.button, ...STYLE.dangerGhost, ...(canDelete ? {} : STYLE.disabled) },
                            disabled: !canDelete,
                            onClick: requestDelete,
                          },
                          t('deleteButton'),
                        ),
                      ),
                  deleteError ? h('div', { style: { ...STYLE.error, marginTop: 8 } }, t('deleteFailed', { message: deleteError })) : null,
                ),
              )
            : null,

          report !== null
            ? h(
                'section',
                { style: STYLE.card },
                h('div', { style: STYLE.cardHead }, h('h3', { style: STYLE.cardTitle }, t('resultTitle'))),
                h(
                  'div',
                  { style: STYLE.cardBody },
                  h('p', { style: STYLE.ok }, t('resultSummary', {
                    sessions: report.sessions.removed,
                    logs: report.logs.removed,
                    projections: report.projection.removed,
                    folders: report.conversation ? report.conversation.removed : 0,
                    attachments: report.attachments.removed,
                    files: report.files.removed,
                    spills: report.spills ? report.spills.removed : 0,
                    bytes: formatBytes(report.logs.bytes + report.projection.bytes + (report.conversation ? report.conversation.bytes : 0) + report.attachments.bytes + report.files.bytes + (report.spills ? report.spills.bytes : 0)),
                  })),
                  report.sessions.missing > 0 ? h('p', { style: STYLE.meta }, t('resultMissing', { count: report.sessions.missing })) : null,
                  (() => {
                    const skippedAttachments = report.attachments?.skipped || 0
                    const skippedFiles = report.files?.skipped || 0
                    const skippedSpills = report.spills?.skipped || 0
                    return skippedAttachments + skippedFiles + skippedSpills > 0
                      ? h('p', { style: STYLE.meta }, t('resultSkipped', { attachments: skippedAttachments, files: skippedFiles, spills: skippedSpills }))
                      : null
                  })(),
                  report.conversation && report.conversation.skipped > 0
                    ? h('p', { style: STYLE.meta }, t('resultConversationSkipped', { count: report.conversation.skipped }))
                    : null,
                  report.imageCache && report.imageCache.removed ? h('p', { style: STYLE.meta }, t('resultImageCache', { bytes: formatBytes(report.imageCache.bytes) })) : null,
                  (report.errors || []).length > 0
                    ? h('div', null,
                        h('h4', { style: STYLE.cardTitle }, t('resultErrors')),
                        report.errors.map((error, index) => h('div', { key: index, style: STYLE.error }, `${error.scope}: ${error.id} — ${error.message}`)),
                      )
                    : null,
                  (report.warnings || []).length > 0
                    ? h('div', null,
                        h('h4', { style: STYLE.cardTitle }, t('resultWarnings')),
                        report.warnings.map((warning, index) => h('div', { key: index, style: STYLE.warn }, warning)),
                      )
                    : null,
                  h('p', { style: STYLE.meta }, t('refreshHint')),
                  h('button', { type: 'button', style: { ...STYLE.button, marginTop: 8 }, onClick: () => setReport(null) }, t('closeResult')),
                ),
              )
            : null,
        )
      }

      function OptionRow(props) {
        return h(
          'div',
          { style: { ...STYLE.optionRow, ...(props.last ? { paddingBottom: 0 } : {}) } },
          h(Check, {
            checked: props.checked,
            disabled: props.disabled === true,
            onChange: () => props.onChange(!props.checked),
            label: props.title,
          }),
          h(
            'div',
            { style: STYLE.grow },
            h('div', { style: STYLE.strong }, props.title),
            h('div', { style: STYLE.meta }, props.hint),
          ),
        )
      }

      function stat(label, value) {
        return h(
          'div',
          { style: STYLE.stat },
          h('div', { style: STYLE.statLabel }, label),
          h('div', { style: STYLE.statValue }, value),
        )
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'session-cleaner',
        order: 30,
        label: () => t('navLabel'),
      }, CleanupPage))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'sessions'],
      apply,
    }
  },
})
