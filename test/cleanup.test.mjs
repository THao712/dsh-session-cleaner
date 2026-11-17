import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

let sequence = 0
function nextId() {
  sequence += 1
  return `session-00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

async function makeHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-cleaner-test-'))
  const home = join(root, 'dsh-home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = join(root, 'profile')
  const workspacePath = options.workspacePath ?? join(root, 'workspace')
  const id = options.id ?? nextId()
  const snapshots = options.snapshots ?? [{ header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' }]
  const selected = snapshots.find((snapshot) => snapshot.header.id === id)
  const events = options.events ?? []
  const eventsById = new Map(options.eventsById ?? [[id, events]])
  if (!eventsById.has(id)) eventsById.set(id, events)
  const liveById = new Map(options.live ?? [])
  const openErrorIds = new Set(options.openErrorIds ?? [])
  const sessionIds = options.sessionIds ?? [id]
  const skipSessionDirs = new Set(options.skipSessionDirs ?? [])
  const sessionDirs = new Map()
  for (const sessionId of sessionIds) {
    const directory = join(home, 'sessions', '--test--', sessionId)
    if (!skipSessionDirs.has(sessionId)) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'test')
    }
    sessionDirs.set(sessionId, directory)
  }
  const sessionDir = sessionDirs.get(id)
  if (options.projection === true) {
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
  }

  const workspace = {
    id: 'workspace-1',
    title: 'Workspace',
    path: workspacePath,
    sessionIds: [...sessionIds],
    detached: [],
    attached: [],
    async detachSession(sessionId) {
      if (options.detachError === true) throw new Error('simulated detach failure')
      this.detached.push(sessionId)
    },
    async attachSession(sessionId) { this.attached.push(sessionId) },
  }
  const archived = new Set(options.archivedIds ?? [id])
  if (Array.isArray(options.pendingIds) && options.pendingIds.length > 0) {
    await writeFile(join(home, 'session-cleaner-pending.json'), JSON.stringify(options.pendingIds))
  }
  if (options.journal !== undefined) {
    await writeFile(join(home, 'session-cleaner-journal.json'), JSON.stringify(options.journal))
  }
  if (options.lock !== undefined) {
    await writeFile(join(home, 'session-cleaner.lock'), typeof options.lock === 'string'
      ? options.lock
      : JSON.stringify(options.lock))
  }
  let route
  const ctx = {
    effect(fn) { return fn() },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection() { return undefined } },
    sessionPersistence: {
      root: join(home, 'sessions'),
      async list() { return snapshots },
      async stat(sessionId) { return snapshots.find((snapshot) => snapshot.header.id === sessionId) },
      async open(sessionId) {
        if (openErrorIds.has(sessionId)) throw new Error('simulated unreadable log')
        return {
          async read(offset, length) {
            const list = eventsById.get(sessionId) ?? []
            return { events: list.slice(offset, offset + length), eventState: 'detached' }
          },
          async close() {},
        }
      },
    },
    sessionQuery: {
      async readTitleSnapshots() { return [] },
      async searchSessions() { return { items: [] } },
    },
    workspaceRegistry: {
      archivedSessionIds: [...archived],
      list() { return [workspace] },
      async unpinSession() {},
      async unarchiveSession(sessionId) { archived.delete(sessionId) },
      async archiveSession(sessionId) { archived.add(sessionId) },
    },
    sessions: { get(sessionId) { return liveById.get(sessionId) } },
    agents: {
      get(sessionId) {
        return options.agentStatus === undefined ? undefined : { id: sessionId, status: options.agentStatus }
      },
    },
    storageDomain: {
      get() {
        return options.storageTable === undefined ? undefined : { table() { return options.storageTable } }
      },
    },
  }
  apply(ctx)
  assert.equal(route.path, '/dsh-session-cleaner/api')

  async function call(op, payload) {
    const body = JSON.stringify({ op, ...payload })
    const req = Readable.from([Buffer.from(body)])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    let result
    const res = {
      headersSent: false,
      setHeader() {},
      end(value) { result = value; this.headersSent = true },
    }
    await route.handler(req, res)
    return JSON.parse(result)
  }

  return {
    root,
    home,
    workspacePath,
    workspace,
    id,
    selected,
    snapshots,
    sessionDir,
    sessionDirs,
    archived,
    call,
    async cleanup() { await rm(root, { recursive: true, force: true }) },
  }
}

const TEST_HOOKS = Symbol.for('dsh.session-cleaner.test-hooks')
async function withTestHooks(hooks, task) {
  globalThis[TEST_HOOKS] = hooks
  try {
    return await task()
  } finally {
    delete globalThis[TEST_HOOKS]
  }
}

function fsErrorFor(operation, match, code) {
  return (op, path) => {
    if (op !== operation) return undefined
    if (typeof match === 'function' ? !match(path) : path !== match) return undefined
    const error = new Error(`simulated ${code} for ${path}`)
    error.code = code
    return error
  }
}

test('session cleaner safety regressions', async (t) => {
  await t.test('preview token is required and single-use', async () => {
    const harness = await makeHarness({ events: [] })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.ok, true)
      assert.equal(typeof preview.value.previewToken, 'string')
      const missing = await harness.call('delete', { ids: [harness.id], options, confirmed: true, files: [], attachments: [] })
      assert.equal(missing.ok, false)
      assert.equal(missing.error.code, 'preview-required')
      const deleted = await harness.call('delete', {
        ids: [harness.id],
        options,
        previewToken: preview.value.previewToken,
        confirmed: true,
        files: [],
        attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.sessions.removed, 1)
      await assert.rejects(access(harness.sessionDir), /ENOENT/)
      const reused = await harness.call('delete', {
        ids: [harness.id],
        options,
        previewToken: preview.value.previewToken,
        confirmed: true,
        files: [],
        attachments: [],
      })
      assert.equal(reused.ok, false)
      assert.equal(reused.error.code, 'preview-consumed')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('idle open Sessions delete files and defer bookkeeping', async () => {
    const id = nextId()
    const harness = await makeHarness({
      id,
      agentStatus: 'idle',
      live: [[id, { snapshotEvents() { return [] } }]],
    })
    try {
      const list = await harness.call('list', {})
      assert.equal(list.ok, true)
      assert.equal(list.value.sessions[0].live, false)
      assert.equal(list.value.sessions[0].open, true)
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.ok, true)
      assert.equal(preview.value.sessions[0].open, true)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.pending.includes(id), true)
      assert.equal(harness.archived.has(id), true)
      assert.deepEqual(harness.workspace.detached, [])
      await assert.rejects(access(harness.sessionDir), /ENOENT/)
      const pending = JSON.parse(await readFile(join(harness.home, 'session-cleaner-pending.json'), 'utf8'))
      assert.deepEqual(pending, [id])
      const after = await harness.call('list', {})
      assert.equal(after.value.sessions.some((session) => session.id === id), false)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('pending bookkeeping is cancelled when the log exists again', async () => {
    const id = nextId()
    const harness = await makeHarness({ id, pendingIds: [id] })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(harness.archived.has(id), true)
      assert.deepEqual(harness.workspace.detached, [])
      await access(harness.sessionDir)
      await assert.rejects(access(join(harness.home, 'session-cleaner-pending.json')), /ENOENT/)
      const conflicts = JSON.parse(await readFile(join(harness.home, 'session-cleaner-pending-conflicts.json'), 'utf8'))
      assert.equal(conflicts.some((entry) => entry.id === id), true)
      assert.match(conflicts.find((entry) => entry.id === id).reason, /log exists again/)
      const journal = await harness.call('journal', {})
      assert.equal(journal.value.conflicts.some((entry) => entry.id === id), true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('pending bookkeeping finalizes when the log is gone', async () => {
    const id = nextId()
    const harness = await makeHarness({ id, pendingIds: [id], skipSessionDirs: [id] })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(harness.archived.has(id), false)
      assert.deepEqual(harness.workspace.detached, [id])
      await assert.rejects(access(join(harness.home, 'session-cleaner-pending.json')), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a running Agent still blocks preview and deletion', async () => {
    const id = nextId()
    const harness = await makeHarness({
      id,
      agentStatus: 'running',
      live: [[id, { snapshotEvents() { return [] } }]],
    })
    try {
      const list = await harness.call('list', {})
      assert.equal(list.value.sessions[0].live, true)
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.ok, false)
      assert.equal(preview.error.code, 'session-live')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('outside-workspace files are not deletable', async () => {
    const outside = join(tmpdir(), `dsh-outside-${Date.now()}-${sequence}.txt`)
    await writeFile(outside, 'outside')
    const harness = await makeHarness({
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: outside }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.value.files.length, 1)
      assert.equal(preview.value.files[0].outsideWorkspace, true)
      assert.equal(preview.value.files[0].deletable, false)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [outside], attachments: [],
      })
      assert.equal(deleted.ok, false)
      assert.equal(deleted.error.code, 'stale-preview')
      await access(outside)
    } finally {
      await harness.cleanup()
      await rm(outside, { force: true })
    }
  })

  await t.test('a safe workspace file remains deletable', async () => {
    const workspacePath = join(tmpdir(), `dsh-safe-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'safe.txt')
    await writeFile(file, 'safe')
    const harness = await makeHarness({
      workspacePath,
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.value.files.length, 1)
      assert.equal(preview.value.files[0].deletable, true)
      assert.equal(preview.value.files[0].selectedByDefault, true)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [file], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.files.removed, 1)
      await assert.rejects(access(file), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('unreadable remaining Session blocks shared files', async () => {
    const shared = join(tmpdir(), `dsh-shared-${Date.now()}-${sequence}.txt`)
    await writeFile(shared, 'shared')
    const id = nextId()
    const remainingId = nextId()
    const workspacePath = join(tmpdir(), `dsh-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const event = {
      type: 'tool/call', seq: 0, time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: shared }) },
    }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [event]], [remainingId, [event]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: remainingId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
      openErrorIds: [remainingId],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.files.length, 1)
      assert.equal(preview.value.files[0].deletable, false)
      assert.equal(preview.value.files[0].referencesUnknown, true)
      assert.match(preview.value.warnings.join('\n'), /could not be read/)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [shared], attachments: [],
      })
      assert.equal(deleted.ok, false)
      assert.equal(deleted.error.code, 'stale-preview')
      await access(shared)
    } finally {
      await harness.cleanup()
      await rm(shared, { force: true })
    }
  })

  await t.test('symlink or junction ancestor is rejected', async (t) => {
    const outside = join(tmpdir(), `dsh-link-outside-${Date.now()}-${sequence}`)
    const workspacePath = join(tmpdir(), `dsh-link-ws-${Date.now()}-${sequence}`)
    await mkdir(outside, { recursive: true })
    await mkdir(workspacePath, { recursive: true })
    const link = join(workspacePath, 'link')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('symlink/junction creation is unavailable')
      return
    }
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'outside')
    const harness = await makeHarness({
      workspacePath,
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: join(link, 'secret.txt') }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.value.files[0].deletable, false)
      assert.equal(preview.value.files[0].reasonCode, 'symlink-ancestor')
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [join(link, 'secret.txt')], attachments: [],
      })
      assert.equal(deleted.ok, false)
      await access(secret)
    } finally {
      await harness.cleanup()
      await rm(outside, { recursive: true, force: true })
    }
  })

  await t.test('a safe attachment object is removed', async () => {
    const digest = 'a'.repeat(64)
    const attachmentId = `sha256:${digest}`
    const harness = await makeHarness({
      events: [{
        type: 'user/message', seq: 0, time: Date.now(),
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{
            type: 'image',
            attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'image.png' },
          }],
        },
      }],
    })
    const object = join(harness.home, 'attachments', 'v1', 'objects', 'aa', digest)
    await mkdir(join(harness.home, 'attachments', 'v1', 'objects', 'aa'), { recursive: true })
    await writeFile(object, 'img')
    try {
      const options = { attachments: true, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.value.attachments.length, 1)
      assert.equal(preview.value.attachments[0].deletable, true)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [attachmentId],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.attachments.removed, 1)
      await assert.rejects(access(object), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('projection cache is removed when the domain returns false', async () => {
    const harness = await makeHarness({
      projection: true,
      storageTable: { async delete() { return false } },
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      const projection = join(harness.home, 'storages', 'session_projcache', 'sessions', `${harness.id}.json`)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.projection.removed, 1)
      await assert.rejects(access(projection), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a conversation folder used by another Session is kept', async () => {
    const workspacePath = join(tmpdir(), `dsh-folder-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const remainingId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const cwdEvent = (cwd) => ({ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd } })
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [cwdEvent(folder)]], [remainingId, [cwdEvent(folder)]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: remainingId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, false)
      assert.equal(preview.value.sessions[0].conversationFolder.sharedWith.length, 1)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.conversation.skipped, 1)
      await access(folder)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a child Session keeps the parent conversation folder', async () => {
    const workspacePath = join(tmpdir(), `dsh-child-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const childId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: childId, cwd: workspacePath, createdAt: Date.now() - 900000, parentSession: id, delegationDepth: 1 }, revision: 'r2' },
      ],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, false)
      assert.equal(preview.value.sessions[0].conversationFolder.sharedWith.includes(childId), true)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.conversation.skipped, 1)
      await access(folder)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('unexpected conversation-folder entries block whole-folder deletion', async () => {
    const workspacePath = join(tmpdir(), `dsh-unknown-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'notes.md'), 'user notes')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.unknownCount, 1)
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, false)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.conversation.skipped, 1)
      await access(join(folder, 'notes.md'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('explicit unknown-folder override removes the folder', async () => {
    const workspacePath = join(tmpdir(), `dsh-override-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'notes.md'), 'user notes')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, allowUnknownFolderEntries: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, true)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      await assert.rejects(access(folder), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('conversation index keeps unrelated entries', async () => {
    const workspacePath = join(tmpdir(), `dsh-index-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const index = { [id]: { folder: 'conversation' }, 'session-other': { folder: 'other' } }
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify(index))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      await assert.rejects(access(folder), /ENOENT/)
      const after = JSON.parse(await readFile(join(workspacePath, 'conversations', 'index.json'), 'utf8'))
      assert.equal(after[id], undefined)
      assert.deepEqual(after['session-other'], { folder: 'other' })
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('omitted options keep files and folders untouched', async () => {
    const workspacePath = join(tmpdir(), `dsh-default-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'keep.txt')
    await writeFile(file, 'keep')
    const harness = await makeHarness({
      workspacePath,
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file }) },
      }],
    })
    try {
      const preview = await harness.call('preview', { ids: [harness.id], options: {} })
      assert.equal(preview.value.files.length, 0)
      assert.equal(preview.value.options.workspaceFiles, false)
      assert.equal(preview.value.options.conversationFolder, false)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options: {}, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      await access(file)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a live remaining Session contributes its live references', async () => {
    const workspacePath = join(tmpdir(), `dsh-live-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'live-shared.txt')
    await writeFile(file, 'shared')
    const id = nextId()
    const remainingId = nextId()
    const event = {
      type: 'tool/call', seq: 0, time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file }) },
    }
    const live = { snapshotEvents() { return [event] } }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [event]], [remainingId, []]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: remainingId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
      live: [[remainingId, live]],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.files.length, 1)
      assert.equal(preview.value.files[0].sharedWith.length, 1)
      assert.equal(preview.value.files[0].deletable, false)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a failed workspace detach keeps the Session archived', async () => {
    const harness = await makeHarness({ detachError: true })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.sessions.removed, 1)
      assert.equal(deleted.value.errors.some((error) => error.scope === 'workspace'), true)
      assert.equal(deleted.value.sessions.deferred, 1)
      assert.equal(harness.archived.has(harness.id), true)
      await assert.rejects(access(harness.sessionDir), /ENOENT/)
      const pending = JSON.parse(await readFile(join(harness.home, 'session-cleaner-pending.json'), 'utf8'))
      assert.ok(pending.includes(harness.id))
      const journal = JSON.parse(await readFile(join(harness.home, 'session-cleaner-journal.json'), 'utf8'))
      assert.equal(journal.status, 'partial')
      assert.equal(journal.phase, 'done')
      assert.ok(journal.completedSessions.includes(harness.id))
      assert.ok(journal.pending.includes(harness.id))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a completed cleanup writes a journal record', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      const journal = await harness.call('journal', {})
      assert.equal(journal.ok, true)
      assert.equal(journal.value.journal.status, 'completed')
      assert.equal(journal.value.journal.phase, 'done')
      assert.deepEqual(journal.value.journal.ids, [harness.id])
      assert.deepEqual(journal.value.journal.completedSessions, [harness.id])
      assert.match(journal.value.journal.fingerprintHash, /^[0-9a-f]{64}$/)
      assert.equal(journal.value.journal.summary.removedSessions, 1)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a running journal is marked interrupted at startup', async () => {
    const id = nextId()
    const harness = await makeHarness({
      id,
      journal: {
        version: 1,
        id: 'interrupted-task',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        status: 'running',
        phase: 'bookkeeping',
        ids: [id],
        options: {},
        completedSessions: [id],
        failedSessions: [],
        pending: [id],
        summary: null,
        errors: [],
        warnings: [],
      },
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const journal = await harness.call('journal', {})
      assert.equal(journal.value.journal.status, 'interrupted')
      assert.equal(journal.value.journal.phase, 'bookkeeping')
      assert.equal(typeof journal.value.journal.interruptedAt, 'number')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('interrupted journal recovers bookkeeping for a removed log', async () => {
    const id = nextId()
    const harness = await makeHarness({
      id,
      skipSessionDirs: [id],
      journal: {
        version: 1,
        id: 'recover-task',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        status: 'running',
        phase: 'bookkeeping',
        ids: [id],
        options: {},
        completedSessions: [id],
        failedSessions: [],
        pending: [],
        summary: null,
        errors: [],
        warnings: [],
      },
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(harness.archived.has(id), false)
      assert.ok(harness.workspace.detached.includes(id))
      assert.equal(await access(join(harness.home, 'session-cleaner-pending.json')).then(() => true, () => false), false)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an explicit file reference blocks both folder cleanups', async () => {
    const workspacePath = join(tmpdir(), `dsh-shared-file-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const otherId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'draft.txt'), 'draft')
    const shared = join(folder, 'out', 'shared.txt')
    await writeFile(shared, 'shared')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const cwdEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }
    const presentEvent = {
      type: 'tool/call', seq: 0, time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c1', name: 'present', arguments: JSON.stringify({ files: [{ path: shared }] }) },
    }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [cwdEvent]], [otherId, [presentEvent]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: otherId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      const entry = preview.value.sessions[0].conversationFolder
      assert.equal(entry.deletable, false)
      assert.ok(entry.sharedWith.includes(otherId))
      assert.deepEqual(entry.sharedReasons.find((item) => item.id === otherId).reasons, ['out-file'])
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((item) => item.name === 'conversation')
      assert.ok(row.sharedWith.includes(otherId))
      assert.equal(row.allDeletable, false)
      assert.equal(row.keepOutDeletable, true)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      assert.equal(deleted.value.conversation.skipped, 1)
      await access(shared)
      const after = await harness.call('folders', {})
      const afterRow = after.value.folders.find((item) => item.name === 'conversation')
      const kept = await harness.call('folders-delete', {
        previewToken: after.value.previewToken,
        confirmed: true,
        folders: [{ key: afterRow.key, mode: 'keepOut' }],
      })
      assert.equal(kept.ok, true)
      assert.equal(kept.value.folders.keptOut, 1)
      await assert.rejects(access(join(folder, 'work')), /ENOENT/)
      await access(shared)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a nested cwd blocks both folder cleanups', async () => {
    const workspacePath = join(tmpdir(), `dsh-nested-cwd-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const otherId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const cwdEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }
    const nestedEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: join(folder, 'work') } }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [cwdEvent]], [otherId, [nestedEvent]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: otherId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      const entry = preview.value.sessions[0].conversationFolder
      assert.equal(entry.deletable, false)
      assert.deepEqual(entry.sharedReasons.find((item) => item.id === otherId).reasons, ['nested-cwd'])
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((item) => item.name === 'conversation')
      assert.equal(row.allDeletable, false)
      assert.ok(row.sharedWith.includes(otherId))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a similar sibling directory is not treated as contained', async () => {
    const workspacePath = join(tmpdir(), `dsh-prefix-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const otherId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation-a')
    const sibling = join(workspacePath, 'conversations', 'conversation-ab')
    await mkdir(folder, { recursive: true })
    await mkdir(sibling, { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation-a' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation-a' } }))
    const cwdEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }
    const siblingEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: sibling } }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [cwdEvent]], [otherId, [siblingEvent]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: otherId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, true)
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((item) => item.name === 'conversation-a')
      assert.equal(row.allDeletable, true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a file recreated after the Session is not selected by default', async () => {
    const workspacePath = join(tmpdir(), `dsh-time-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'recreated.txt')
    await writeFile(file, 'new')
    const id = nextId()
    const createdAt = Date.now() - 3600000
    const eventTime = Date.now() - 3000000
    const harness = await makeHarness({
      id,
      workspacePath,
      snapshots: [{ header: { id, cwd: workspacePath, createdAt }, revision: 'r1' }],
      events: [{
        type: 'tool/call', seq: 0, time: eventTime,
        data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: file }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.files[0].timeEvidence, 'after-session')
      assert.equal(preview.value.files[0].createdDuring, false)
      assert.equal(preview.value.files[0].selectedByDefault, false)
      assert.equal(preview.value.files[0].deletable, true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a changed file invalidates the preview', async () => {
    const workspacePath = join(tmpdir(), `dsh-change-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'changing.txt')
    await writeFile(file, 'before')
    const harness = await makeHarness({
      workspacePath,
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      await writeFile(file, 'changed content is longer')
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [file], attachments: [],
      })
      assert.equal(deleted.ok, false)
      assert.equal(deleted.error.code, 'stale-preview')
      await access(file)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a changed Session log invalidates the preview', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      await writeFile(join(harness.sessionDir, 'session.v4.jsonl.zstd.lock'), 'lock')
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, false)
      assert.equal(deleted.error.code, 'stale-preview')
      await access(harness.sessionDir)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a new out file invalidates the folder preview', async () => {
    const workspacePath = join(tmpdir(), `dsh-out-change-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'out', 'before.txt'), 'before')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, true)
      await writeFile(join(folder, 'out', 'after.txt'), 'after')
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, false)
      assert.equal(deleted.error.code, 'stale-preview')
      await access(join(folder, 'out', 'after.txt'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a new work file invalidates the folder-list token', async () => {
    const workspacePath = join(tmpdir(), `dsh-work-change-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'work', 'before.py'), 'before')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      await writeFile(join(folder, 'work', 'after.py'), 'after')
      const result = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'keepOut' }],
      })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'stale-preview')
      await access(join(folder, 'work', 'after.py'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an out-only change still allows keep-out cleanup', async () => {
    const workspacePath = join(tmpdir(), `dsh-out-keep-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'draft.py'), 'draft')
    await writeFile(join(folder, 'out', 'before.txt'), 'before')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      await writeFile(join(folder, 'out', 'after.txt'), 'after')
      const result = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'keepOut' }],
      })
      assert.equal(result.ok, true)
      assert.equal(result.value.folders.keptOut, 1)
      await assert.rejects(access(join(folder, 'work')), /ENOENT/)
      await access(join(folder, 'out', 'after.txt'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an unrelated folder change does not invalidate the selected folder', async () => {
    const workspacePath = join(tmpdir(), `dsh-unrelated-ws-${Date.now()}-${sequence}`)
    const first = join(workspacePath, 'conversations', 'conversation-a')
    const second = join(workspacePath, 'conversations', 'conversation-b')
    await mkdir(join(first, 'work'), { recursive: true })
    await mkdir(join(second, 'work'), { recursive: true })
    await writeFile(join(first, 'work', 'a.py'), 'a')
    await writeFile(join(second, 'work', 'b.py'), 'b')
    const harness = await makeHarness({ workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation-a')
      await writeFile(join(second, 'work', 'new.py'), 'new')
      const result = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'all' }],
      })
      assert.equal(result.ok, true)
      assert.equal(result.value.folders.removed, 1)
      await assert.rejects(access(first), /ENOENT/)
      await access(join(second, 'work', 'new.py'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('concurrent execution of one preview token happens once', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      const payload = {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      }
      const [first, second] = await Promise.all([
        harness.call('delete', payload),
        harness.call('delete', payload),
      ])
      assert.equal([first, second].filter((result) => result.ok).length, 1)
      const failure = [first, second].find((result) => !result.ok)
      assert.ok(['preview-in-use', 'preview-consumed'].includes(failure.error.code))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a live cross-process cleanup lock blocks deletion', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      const lock = join(harness.home, 'session-cleaner.lock')
      await writeFile(lock, JSON.stringify({
        token: 'foreign-lock',
        pid: process.ppid,
        label: 'other-host',
        startedAt: Date.now(),
      }))
      const blocked = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.error.code, 'cleanup-locked')
      await access(harness.sessionDir)
      await rm(lock, { force: true })
      const retried = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(retried.ok, true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('concurrent deletes preserve both pending ids', async () => {
    const firstId = nextId()
    const secondId = nextId()
    const workspacePath = join(tmpdir(), `dsh-pending-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const harness = await makeHarness({
      id: firstId,
      workspacePath,
      snapshots: [
        { header: { id: firstId, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: secondId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
      sessionIds: [firstId, secondId],
      archivedIds: [firstId, secondId],
      agentStatus: 'idle',
      live: [[firstId, { snapshotEvents() { return [] } }], [secondId, { snapshotEvents() { return [] } }]],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const firstPreview = await harness.call('preview', { ids: [firstId], options })
      const secondPreview = await harness.call('preview', { ids: [secondId], options })
      const [first, second] = await Promise.all([
        harness.call('delete', {
          ids: [firstId], options, previewToken: firstPreview.value.previewToken,
          confirmed: true, files: [], attachments: [],
        }),
        harness.call('delete', {
          ids: [secondId], options, previewToken: secondPreview.value.previewToken,
          confirmed: true, files: [], attachments: [],
        }),
      ])
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      const pending = JSON.parse(await readFile(join(harness.home, 'session-cleaner-pending.json'), 'utf8'))
      assert.deepEqual([...pending].sort(), [firstId, secondId].sort())
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('conversation folders can keep out or delete all', async () => {
    const workspacePath = join(tmpdir(), `dsh-folders-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'print(1)')
    await writeFile(join(folder, 'out', 'final.txt'), 'final')
    await writeFile(join(folder, 'AGENTS.md'), 'rules')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      assert.equal(list.ok, true)
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      assert.ok(row)
      assert.equal(row.hasWork, true)
      assert.equal(row.hasOut, true)
      assert.ok(row.workBytes > 0)
      assert.ok(row.outBytes > 0)
      assert.equal(row.allDeletable, true)

      const kept = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'keepOut' }],
      })
      assert.equal(kept.ok, true)
      assert.equal(kept.value.folders.keptOut, 1)
      await assert.rejects(access(join(folder, 'work')), /ENOENT/)
      await assert.rejects(access(join(folder, 'AGENTS.md')), /ENOENT/)
      await access(join(folder, 'out', 'final.txt'))
      await access(join(folder, 'session.json'))
      const indexAfterKeep = JSON.parse(await readFile(join(workspacePath, 'conversations', 'index.json'), 'utf8'))
      assert.ok(indexAfterKeep[id])

      const second = await harness.call('folders', {})
      const secondRow = second.value.folders.find((entry) => entry.name === 'conversation')
      assert.equal(secondRow.workBytes, 0)
      assert.ok(secondRow.outBytes > 0)
      const removed = await harness.call('folders-delete', {
        previewToken: second.value.previewToken,
        confirmed: true,
        folders: [{ key: secondRow.key, mode: 'all' }],
      })
      assert.equal(removed.ok, true)
      assert.equal(removed.value.folders.removed, 1)
      await assert.rejects(access(folder), /ENOENT/)
      const indexAfterAll = JSON.parse(await readFile(join(workspacePath, 'conversations', 'index.json'), 'utf8'))
      assert.equal(indexAfterAll[id], undefined)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an orphan conversation folder can be deleted by name', async () => {
    const workspacePath = join(tmpdir(), `dsh-orphan-ws-${Date.now()}-${sequence}`)
    const folder = join(workspacePath, 'conversations', '2026-01-01_0000_orphan')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'tmp.bin'), 'tmp')
    await writeFile(join(folder, 'out', 'keep.txt'), 'keep')
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({
      'session-orphan': { folder: '2026-01-01_0000_orphan' },
    }))
    const harness = await makeHarness({ workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === '2026-01-01_0000_orphan')
      assert.equal(row.state, 'orphan')
      assert.equal(row.metadataState, 'missing')
      const removed = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'all' }],
      })
      assert.equal(removed.ok, true)
      await assert.rejects(access(folder), /ENOENT/)
      const index = JSON.parse(await readFile(join(workspacePath, 'conversations', 'index.json'), 'utf8'))
      assert.equal(index['session-orphan'], undefined)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a folder shared by another Session is blocked from folder cleanup', async () => {
    const workspacePath = join(tmpdir(), `dsh-folder-shared-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const otherId = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const cwdEvent = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }
    const harness = await makeHarness({
      id,
      workspacePath,
      eventsById: new Map([[id, [cwdEvent]], [otherId, [cwdEvent]]]),
      snapshots: [
        { header: { id, cwd: workspacePath, createdAt: Date.now() - 600000 }, revision: 'r1' },
        { header: { id: otherId, cwd: workspacePath, createdAt: Date.now() - 900000 }, revision: 'r2' },
      ],
    })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      assert.equal(row.sharedWith.includes(otherId), true)
      assert.equal(row.allDeletable, false)
      assert.equal(row.keepOutDeletable, false)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a loaded Session folder can still be cleaned without restarting', async () => {
    const workspacePath = join(tmpdir(), `dsh-folder-open-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'out', 'final.txt'), 'done')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const harness = await makeHarness({
      id,
      workspacePath,
      live: [[id, { snapshotEvents() { return [] } }]],
    })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      assert.equal(row.open, true)
      assert.equal(row.keepOutDeletable, true)
      const result = await harness.call('folders-delete', {
        previewToken: list.value.previewToken,
        confirmed: true,
        folders: [{ key: row.key, mode: 'keepOut' }],
      })
      assert.equal(result.ok, true)
      assert.equal(result.value.folders.keptOut, 1)
      await assert.rejects(access(join(folder, 'work')), /ENOENT/)
      await access(join(folder, 'out', 'final.txt'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('nested baseDir is recognized through facts', async () => {
    const workspacePath = join(tmpdir(), `dsh-nested-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const id = nextId()
    const folder = join(workspacePath, 'archives', 'conversations', 'conversation')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const harness = await makeHarness({
      id,
      workspacePath,
      events: [{ type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: folder } }],
    })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      assert.equal(preview.value.sessions[0].conversationFolder.path, folder)
      assert.equal(preview.value.sessions[0].conversationFolder.deletable, true)
      const deleted = await harness.call('delete', {
        ids: [id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      await assert.rejects(access(folder), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an incomplete lock file blocks deletion instead of being stolen', async () => {
    const harness = await makeHarness()
    const lock = join(harness.home, 'session-cleaner.lock')
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      await writeFile(lock, '')
      const blocked = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.error.code, 'cleanup-locked')
      await access(harness.sessionDir)
      await rm(lock)
      const retried = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(retried.ok, true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a stale incomplete lock is recovered after its grace period', async () => {
    const harness = await makeHarness()
    const lock = join(harness.home, 'session-cleaner.lock')
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      await writeFile(lock, '')
      const old = new Date(Date.now() - 60000)
      await utimes(lock, old, old)
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
      await assert.rejects(access(harness.sessionDir), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a stale same-process lock is taken over', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      await writeFile(join(harness.home, 'session-cleaner.lock'), JSON.stringify({
        token: 'stale-same-process',
        pid: process.pid,
        startedAt: Date.now() - 60000,
      }))
      const deleted = await harness.call('delete', {
        ids: [harness.id], options, previewToken: preview.value.previewToken,
        confirmed: true, files: [], attachments: [],
      })
      assert.equal(deleted.ok, true)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('startup recovery does not mark a live task interrupted', async () => {
    const id = nextId()
    const journal = {
      version: 1,
      id: 'live-task',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
      status: 'running',
      phase: 'logs',
      ids: [id],
      options: {},
      completedSessions: [],
      failedSessions: [],
      pending: [],
      summary: null,
      errors: [],
      warnings: [],
    }
    const harness = await makeHarness({
      id,
      journal,
      lock: { token: 'live-lock', pid: process.ppid, startedAt: Date.now() },
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const latest = await harness.call('journal', {})
      assert.equal(latest.value.journal.status, 'running')
      await access(join(harness.home, 'session-cleaner.lock'))
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('lock release keeps a lock that another owner replaced', async () => {
    const harness = await makeHarness()
    const lock = join(harness.home, 'session-cleaner.lock')
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      let replaced = false
      await withTestHooks({
        beforeLockRelease: async ({ path }) => {
          if (replaced) return
          replaced = true
          await writeFile(path, JSON.stringify({ token: 'foreign-token', pid: process.ppid, startedAt: Date.now() }))
        },
      }, async () => {
        const deleted = await harness.call('delete', {
          ids: [harness.id], options, previewToken: preview.value.previewToken,
          confirmed: true, files: [], attachments: [],
        })
        assert.equal(deleted.ok, true)
      })
      const current = JSON.parse(await readFile(lock, 'utf8'))
      assert.equal(current.token, 'foreign-token')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('folder index commit preserves a concurrent addition and title update', async () => {
    const workspacePath = join(tmpdir(), `dsh-index-merge-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const indexPath = join(workspacePath, 'conversations', 'index.json')
    await writeFile(indexPath, JSON.stringify({
      [id]: { folder: 'conversation' },
      'session-other': { folder: 'other', title: 'old' },
    }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      let injected = false
      await withTestHooks({
        beforeIndexCommit: async ({ indexPath: target }) => {
          if (injected) return
          injected = true
          const current = JSON.parse(await readFile(target, 'utf8'))
          current['session-new'] = { folder: 'new', title: 'new' }
          current['session-other'].title = 'fresh'
          await writeFile(target, JSON.stringify(current))
        },
      }, async () => {
        const removed = await harness.call('folders-delete', {
          previewToken: list.value.previewToken,
          confirmed: true,
          folders: [{ key: row.key, mode: 'all' }],
        })
        assert.equal(removed.ok, true)
      })
      const after = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.equal(after[id], undefined)
      assert.deepEqual(after['session-new'], { folder: 'new', title: 'new' })
      assert.equal(after['session-other'].title, 'fresh')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('session index commit preserves a concurrent addition', async () => {
    const workspacePath = join(tmpdir(), `dsh-index-id-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const indexPath = join(workspacePath, 'conversations', 'index.json')
    await writeFile(indexPath, JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: true, imageCache: false }
      const preview = await harness.call('preview', { ids: [id], options })
      let injected = false
      await withTestHooks({
        beforeIndexCommit: async ({ indexPath: target }) => {
          if (injected) return
          injected = true
          const current = JSON.parse(await readFile(target, 'utf8'))
          current['session-new'] = { folder: 'new' }
          await writeFile(target, JSON.stringify(current))
        },
      }, async () => {
        const deleted = await harness.call('delete', {
          ids: [id], options, previewToken: preview.value.previewToken,
          confirmed: true, files: [], attachments: [],
        })
        assert.equal(deleted.ok, true)
      })
      const after = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.equal(after[id], undefined)
      assert.deepEqual(after['session-new'], { folder: 'new' })
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('index commit preserves an external deletion', async () => {
    const workspacePath = join(tmpdir(), `dsh-index-delete-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    const indexPath = join(workspacePath, 'conversations', 'index.json')
    await writeFile(indexPath, JSON.stringify({ [id]: { folder: 'conversation' }, 'session-other': { folder: 'other' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      let injected = false
      await withTestHooks({
        beforeIndexCommit: async ({ indexPath: target }) => {
          if (injected) return
          injected = true
          const current = JSON.parse(await readFile(target, 'utf8'))
          delete current['session-other']
          await writeFile(target, JSON.stringify(current))
        },
      }, async () => {
        const removed = await harness.call('folders-delete', {
          previewToken: list.value.previewToken,
          confirmed: true,
          folders: [{ key: row.key, mode: 'all' }],
        })
        assert.equal(removed.ok, true)
      })
      const after = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.equal(after[id], undefined)
      assert.equal(after['session-other'], undefined)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('an unreadable log is reported and keeps archive bookkeeping', async () => {
    const harness = await makeHarness()
    try {
      const options = { attachments: false, workspaceFiles: false, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      await withTestHooks({
        fsError: fsErrorFor('listNames', harness.sessionDir, 'EACCES'),
      }, async () => {
        const preview = await harness.call('preview', { ids: [harness.id], options })
        assert.equal(preview.ok, true)
        assert.equal(preview.value.sessions[0].missing, false)
        assert.match(preview.value.sessions[0].logError, /permission denied/)
        const deleted = await harness.call('delete', {
          ids: [harness.id], options, previewToken: preview.value.previewToken,
          confirmed: true, files: [], attachments: [],
        })
        assert.equal(deleted.ok, true)
        assert.equal(deleted.value.sessions.removed, 0)
        assert.equal(deleted.value.sessions.missing, 0)
        assert.equal(deleted.value.errors.some((error) => error.scope === 'session-log'), true)
        assert.equal(harness.archived.has(harness.id), true)
        await access(harness.sessionDir)
        const journal = await harness.call('journal', {})
        assert.equal(journal.value.journal.status, 'partial')
        assert.equal(journal.value.journal.failedSessions.includes(harness.id), true)
      })
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('a failed file deletion is recorded for targeted recovery', async () => {
    const workspacePath = join(tmpdir(), `dsh-recovery-ws-${Date.now()}-${sequence}`)
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'made.txt')
    await writeFile(file, 'made by session')
    const harness = await makeHarness({
      workspacePath,
      events: [{
        type: 'tool/call', seq: 0, time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file }) },
      }],
    })
    try {
      const options = { attachments: false, workspaceFiles: true, scanCreated: false, spills: false, conversationFolder: false, imageCache: false }
      const preview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(preview.value.files[0].selectedByDefault, true)
      await withTestHooks({
        fsError: fsErrorFor('unlink', file, 'EACCES'),
      }, async () => {
        const deleted = await harness.call('delete', {
          ids: [harness.id], options, previewToken: preview.value.previewToken,
          confirmed: true, files: [file], attachments: [],
        })
        assert.equal(deleted.ok, true)
        assert.equal(deleted.value.files.removed, 0)
        assert.equal(deleted.value.errors.some((error) => error.scope === 'file'), true)
        assert.equal(deleted.value.resources.some((resource) => resource.type === 'file' && resource.status === 'failed'), true)
        await access(file)
        await assert.rejects(access(harness.sessionDir), /ENOENT/)
        const task = await harness.call('journal', { taskId: deleted.value.taskId })
        assert.equal(task.value.journal.status, 'partial')
        assert.equal(task.value.journal.resumeIds.includes(harness.id), true)
      })
      harness.snapshots.splice(0, harness.snapshots.length)
      harness.workspace.sessionIds.length = 0
      const secondPreview = await harness.call('preview', { ids: [harness.id], options })
      assert.equal(secondPreview.ok, true)
      const recovered = secondPreview.value.files.find((entry) => entry.path === file)
      assert.ok(recovered)
      assert.equal(recovered.recoveredTaskId !== undefined, true)
      assert.equal(recovered.selectedByDefault, false)
      const secondDelete = await harness.call('delete', {
        ids: [harness.id], options, previewToken: secondPreview.value.previewToken,
        confirmed: true, files: [file], attachments: [],
      })
      assert.equal(secondDelete.ok, true)
      assert.equal(secondDelete.value.files.removed, 1)
      await assert.rejects(access(file), /ENOENT/)
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('folder cleanup writes a queryable task record', async () => {
    const workspacePath = join(tmpdir(), `dsh-folder-journal-ws-${Date.now()}-${sequence}`)
    const id = nextId()
    const folder = join(workspacePath, 'conversations', 'conversation')
    await mkdir(join(folder, 'work'), { recursive: true })
    await mkdir(join(folder, 'out'), { recursive: true })
    await writeFile(join(folder, 'work', 'a.py'), 'x')
    await writeFile(join(folder, 'out', 'final.txt'), 'done')
    await writeFile(join(folder, 'session.json'), JSON.stringify({ sessionId: id, workspace: workspacePath, folder: 'conversation' }))
    await writeFile(join(workspacePath, 'conversations', 'index.json'), JSON.stringify({ [id]: { folder: 'conversation' } }))
    const harness = await makeHarness({ id, workspacePath })
    try {
      const list = await harness.call('folders', {})
      const row = list.value.folders.find((entry) => entry.name === 'conversation')
      const requestId = `test-${Date.now()}`
      await withTestHooks({
        fsError: fsErrorFor('rm', folder, 'EACCES'),
      }, async () => {
        const partial = await harness.call('folders-delete', {
          previewToken: list.value.previewToken,
          confirmed: true,
          requestId,
          folders: [{ key: row.key, mode: 'all' }],
        })
        assert.equal(partial.ok, true)
        assert.equal(partial.value.folders.removed, 0)
        const task = await harness.call('journal', { taskId: partial.value.taskId })
        assert.equal(task.value.journal.kind, 'folders')
        assert.equal(task.value.journal.status, 'partial')
        assert.equal(task.value.journal.folders[0].status, 'failed')
        const byRequest = await harness.call('journal', { requestId })
        assert.equal(byRequest.value.journal.id, partial.value.taskId)
      })
      await access(folder)
      const second = await harness.call('folders', {})
      const secondRow = second.value.folders.find((entry) => entry.name === 'conversation')
      const completed = await harness.call('folders-delete', {
        previewToken: second.value.previewToken,
        confirmed: true,
        folders: [{ key: secondRow.key, mode: 'all' }],
      })
      assert.equal(completed.ok, true)
      assert.equal(completed.value.folders.removed, 1)
      await assert.rejects(access(folder), /ENOENT/)
      const latest = await harness.call('journal', {})
      assert.equal(latest.value.journal.kind, 'folders')
      assert.equal(latest.value.journal.status, 'completed')
      assert.equal(latest.value.tasks.some((task) => task.id === completed.value.taskId), true)
    } finally {
      await harness.cleanup()
    }
  })
})
