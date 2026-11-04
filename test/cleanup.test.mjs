import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises'
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
  const sessionDir = join(home, 'sessions', '--test--', id)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'test')
  if (options.projection === true) {
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
  }

  const workspace = {
    id: 'workspace-1',
    title: 'Workspace',
    path: workspacePath,
    sessionIds: [id],
    detached: [],
    attached: [],
    async detachSession(sessionId) {
      if (options.detachError === true) throw new Error('simulated detach failure')
      this.detached.push(sessionId)
    },
    async attachSession(sessionId) { this.attached.push(sessionId) },
  }
  const archived = new Set([id])
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
    archived,
    call,
    async cleanup() { await rm(root, { recursive: true, force: true }) },
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
      assert.equal(reused.error.code, 'preview-required')
    } finally {
      await harness.cleanup()
    }
  })

  await t.test('idle open Sessions are not reported as running', async () => {
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
      assert.equal(preview.value.sessions[0].live, false)
      assert.match(preview.value.warnings.join('\n'), /open in this Host but idle/)
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
      assert.equal(harness.archived.has(harness.id), true)
      await assert.rejects(access(harness.sessionDir), /ENOENT/)
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
})
