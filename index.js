/**
 * Session Cleanup — Host half.
 *
 * Finds archived Sessions, shows exactly what a permanent deletion would remove
 * (Session logs, projection checkpoints, unreferenced attachments, and files the
 * Session produced in its workspace), and performs that deletion on explicit
 * user confirmation. The browser half never supplies an authoritative path: it
 * may only choose among candidates this half re-derives at deletion time.
 */
import { createHash, randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import {
  lstat,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'

/** Cordis function-plugin name. */
export const name = 'session-cleaner'

/** Every service the cleanup engine needs; the UI is useless without them. */
export const inject = [
  'webServer',
  'connection',
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
  'sessions',
  'agents',
  'storageDomain',
]

const ROUTE_PATH = '/dsh-session-cleaner/api'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_SESSIONS_PER_REQUEST = 200
const MAX_SCAN_ENTRIES = 20000
const MAX_SCAN_DEPTH = 4
const MAX_FILE_CANDIDATES = 500
const MAX_REFERENCE_SESSIONS = 400
const FACT_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_FACT_CACHE = 200
const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000
const MAX_PREVIEW_TOKENS = 50
const PAGE_EVENTS = 500
const MAX_EVENTS_PER_SESSION = 100000
const CONVERSATION_BASE = 'conversations'
const CONVERSATION_METADATA = 'session.json'
const CONVERSATION_INDEX = 'index.json'
const KNOWN_FOLDER_ENTRIES = new Set(['work', 'out', CONVERSATION_METADATA, 'AGENTS.md'])

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'conversations',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.idea',
  '.vscode',
])

const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/* ------------------------------------------------------------------------- *
 * Small filesystem helpers
 * ------------------------------------------------------------------------- */

async function lstatSafe(path) {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

async function isRealDirectory(path) {
  const info = await lstatSafe(path)
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink()
}

async function sizeOfFile(path) {
  const info = await lstatSafe(path)
  return info !== undefined && info.isFile() ? info.size : 0
}

async function sizeOfDirectory(path, budget = 200000) {
  let total = 0
  let seen = 0
  const stack = [path]
  while (stack.length > 0 && seen < budget) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > budget) break
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size
        } catch {
          /* a concurrent removal is not a reason to fail a preview */
        }
      }
    }
  }
  return total
}

async function listNames(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function pathKey(path) {
  const normal = resolve(path)
  return process.platform === 'win32' ? normal.toLowerCase() : normal
}

/**
 * A Session object in `ctx.sessions` only means the Session is loaded in this
 * Host process. Archiving can leave an idle Agent (and its Session) published;
 * only the Agent's `status` distinguishes that idle state from actual work.
 */
function agentStatusFor(ctx, id) {
  try {
    return ctx.agents.get(id)?.status
  } catch {
    return undefined
  }
}

function isAgentRunning(ctx, id) {
  return agentStatusFor(ctx, id) === 'running'
}

function isSessionOpen(ctx, id) {
  return ctx.sessions.get(id) !== undefined
}

/**
 * Reject paths that reach their target through a symlink or Windows junction.
 * Checking only the final component is insufficient: deleting
 * `workspace/link/secret.txt` follows `link` even when the file itself is not a
 * symlink. The boundary itself is trusted; it comes from the workspace registry
 * or from a validated persistence root.
 */
async function hasSymlinkAncestor(path, boundary) {
  if (typeof path !== 'string' || typeof boundary !== 'string') return false
  const stop = resolve(boundary)
  let current = resolve(path)
  if (!isInside(current, stop)) return false
  while (isInside(current, stop)) {
    const parent = dirname(current)
    if (samePath(parent, stop)) break
    const info = await lstatSafe(parent)
    if (info !== undefined && info.isSymbolicLink()) return true
    current = parent
  }
  return false
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function readConversationMetadata(folder) {
  const value = await readJsonFile(join(folder, CONVERSATION_METADATA), undefined)
  return value !== null && typeof value === 'object' ? value : undefined
}

function isConversationFolderFor(folder, metadata, id, workspaceRoot) {
  if (metadata === undefined || metadata === null) return false
  if (metadata.sessionId !== id) return false
  if (typeof metadata.workspace !== 'string' || !samePath(metadata.workspace, workspaceRoot)) return false
  const resolvedFolder = resolve(folder)
  const resolvedRoot = resolve(workspaceRoot)
  if (samePath(resolvedFolder, resolvedRoot) || !isInside(resolvedFolder, resolvedRoot)) return false
  const recorded = metadata.folder
  const matchesName = safeConversationName(recorded) && basename(resolvedFolder) === recorded
  const matchesAbsolute = typeof recorded === 'string' && recorded.length > 0 && samePath(recorded, resolvedFolder)
  if (!matchesName && !matchesAbsolute) return false
  return true
}

function safeConversationName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    basename(name) === name &&
    !name.includes('/') &&
    !name.includes('\\')
}

async function conversationFromIndex(workspaceRoot, id) {
  const base = join(workspaceRoot, CONVERSATION_BASE)
  const indexPath = join(base, CONVERSATION_INDEX)
  const index = await readJsonFile(indexPath, undefined)
  if (index === null || typeof index !== 'object' || Array.isArray(index)) return undefined
  const entry = index[id]
  const name = entry !== null && typeof entry === 'object' ? entry.folder : undefined
  if (!safeConversationName(name)) return undefined
  const folder = join(base, name)
  if (!(await isRealDirectory(folder))) return undefined
  const metadata = await readConversationMetadata(folder)
  if (!isConversationFolderFor(folder, metadata, id, workspaceRoot)) return undefined
  return {
    workspace: resolve(workspaceRoot),
    base: resolve(base),
    folder: resolve(folder),
    indexPath,
    metadata,
  }
}

async function conversationFromFacts(workspaceRoot, id, facts) {
  if (workspaceRoot === undefined || facts === undefined) return undefined
  const candidates = []
  if (typeof facts.finalCwd === 'string') candidates.push(facts.finalCwd)
  for (const cwd of facts.cwdHistory) candidates.push(cwd)
  const seen = new Set()
  for (const candidate of candidates) {
    const folder = resolve(candidate)
    const key = pathKey(folder)
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await isRealDirectory(folder))) continue
    const metadata = await readConversationMetadata(folder)
    if (!isConversationFolderFor(folder, metadata, id, workspaceRoot)) continue
    return {
      workspace: resolve(workspaceRoot),
      base: dirname(folder),
      folder,
      indexPath: join(dirname(folder), CONVERSATION_INDEX),
      metadata,
    }
  }
  return undefined
}

async function findConversationFolder(workspaceRoot, id, facts) {
  if (workspaceRoot === undefined) return undefined
  const fromIndex = await conversationFromIndex(workspaceRoot, id)
  if (fromIndex !== undefined) return fromIndex
  return await conversationFromFacts(workspaceRoot, id, facts)
}

async function indexConversationFolders(workspaceRoots, ids) {
  const wanted = new Set(ids)
  const found = new Map()
  for (const workspaceRoot of workspaceRoots) {
    const base = join(workspaceRoot, CONVERSATION_BASE)
    const index = await readJsonFile(join(base, CONVERSATION_INDEX), undefined)
    if (index === null || typeof index !== 'object' || Array.isArray(index)) continue
    for (const id of wanted) {
      if (found.has(id)) continue
      const entry = index[id]
      const name = entry !== null && typeof entry === 'object' ? entry.folder : undefined
      if (!safeConversationName(name)) continue
      const folder = join(base, name)
      if (!(await isRealDirectory(folder))) continue
      const metadata = await readConversationMetadata(folder)
      if (!isConversationFolderFor(folder, metadata, id, workspaceRoot)) continue
      found.set(id, {
        workspace: resolve(workspaceRoot),
        base: resolve(base),
        folder: resolve(folder),
        indexPath: join(base, CONVERSATION_INDEX),
        metadata,
      })
    }
  }
  return found
}

/**
 * Session ids become filesystem keys in the projection cache. The persistence
 * backend escapes them for log directories, but the storage-domain JSON backend
 * uses the raw key; reject separators and traversal before constructing a path.
 */
function isSafeSessionId(id) {
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    id !== '.' &&
    id !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(id)
}

/* ------------------------------------------------------------------------- *
 * Session-persistence path derivation
 *
 * Copied from the JSONL backend's deterministic layout so this plugin can find
 * the one directory a Session owns. Every deletion re-checks that the derived
 * directory sits directly below the configured root and carries the exact
 * escaped Session id.
 * ------------------------------------------------------------------------- */

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function homeDirectory() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && isAbsolute(fromEnv)) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function persistenceRoot(ctx) {
  const service = ctx.sessionPersistence
  if (service !== undefined && typeof service.root === 'string' && isAbsolute(service.root)) {
    return resolve(service.root)
  }
  return join(homeDirectory(), 'sessions')
}

function projectionCachePath(id) {
  if (!isSafeSessionId(id)) throw new Error('unsafe Session id for the projection cache path')
  return join(homeDirectory(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

async function hasSessionLog(directory) {
  const names = await listNames(directory)
  return names.some((name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
}

async function existingSessionDirectory(project, encoded) {
  if (!(await isRealDirectory(project))) return undefined
  const candidate = join(project, encoded)
  if (!(await isRealDirectory(candidate))) return undefined
  if (!(await hasSessionLog(candidate))) return undefined
  return candidate
}

async function resolveSessionDirectory(root, header, id) {
  const encoded = encodeSegment(id)
  if (typeof header.cwd === 'string' && header.cwd.length > 0) {
    const found = await existingSessionDirectory(join(root, projectKey(header.cwd)), encoded)
    if (found !== undefined) return found
  }
  const noCwd = await existingSessionDirectory(join(root, '_no-cwd'), encoded)
  if (noCwd !== undefined) return noCwd
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const found = await existingSessionDirectory(join(root, entry.name), encoded)
    if (found !== undefined) return found
  }
  return undefined
}

function assertOwnedSessionDirectory(root, directory, id) {
  const resolvedRoot = resolve(root)
  const resolvedDirectory = resolve(directory)
  if (basename(resolvedDirectory) !== encodeSegment(id)) {
    throw new Error('refusing to delete a directory that is not named after this Session')
  }
  const parent = dirname(resolvedDirectory)
  const parentIsProject = samePath(parent, resolvedRoot) ||
    (samePath(dirname(parent), resolvedRoot) && isInside(parent, resolvedRoot))
  if (!parentIsProject) {
    throw new Error('refusing to delete a Session directory outside the persistence root')
  }
  if (samePath(resolvedDirectory, resolvedRoot)) {
    throw new Error('refusing to delete the persistence root')
  }
}

/* ------------------------------------------------------------------------- *
 * Protected paths
 * ------------------------------------------------------------------------- */

function protectedPrefixes() {
  const home = homeDirectory()
  const list = [
    home,
    join(home, 'sessions'),
    join(home, 'storages'),
    join(home, 'attachments'),
    join(home, 'cache'),
    join(home, 'profiles'),
    join(home, 'skills'),
    join(home, 'backups'),
    join(home, 'dsh-runtimes'),
    join(home, 'llm-deepseek'),
  ]
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && isAbsolute(process.env.DSH_PROFILE_DIR)) {
    list.push(resolve(process.env.DSH_PROFILE_DIR))
  }
  const userHome = homedir()
  for (const name of ['.ssh', '.aws', '.gnupg', '.kube', '.config']) {
    list.push(join(userHome, name))
  }
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    list.push(dirname(process.execPath))
  }
  for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[key]
    if (typeof value === 'string' && isAbsolute(value)) list.push(resolve(value))
  }
  return list
}

function isProtectedPath(path) {
  const resolved = resolve(path)
  if (/(^|[\\/])\.(git|hg|svn)([\\/]|$)/i.test(resolved)) return true
  if (/(^|[\\/])session\.[^\\/]*\.jsonl(\.zstd)?$/i.test(resolved)) return true
  if (/(^|[\\/])session\.json$/i.test(resolved)) return true
  if (/(^|[\\/])conversations[\\/]index\.json$/i.test(resolved)) return true
  if (/(^|[\\/])(workspace\.json|settings\.yaml|\.credentials[^\\/]*)$/i.test(resolved)) return true
  for (const prefix of protectedPrefixes()) {
    if (samePath(resolved, prefix) || isInside(resolved, prefix)) return true
  }
  return false
}

/* ------------------------------------------------------------------------- *
 * Event reading and fact extraction
 * ------------------------------------------------------------------------- */

async function readEvents(ctx, id) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const events = []
    let offset = 0
    while (events.length < MAX_EVENTS_PER_SESSION) {
      const page = await handle.read(offset, PAGE_EVENTS)
      if (page.events.length === 0) break
      for (const event of page.events) events.push(event)
      offset += page.events.length
      if (page.events.length < PAGE_EVENTS) break
    }
    return {
      events,
      truncated: events.length >= MAX_EVENTS_PER_SESSION,
    }
  } finally {
    try {
      await handle.close()
    } catch {
      /* a read handle that already closed is harmless here */
    }
  }
}

function attachmentRecords(value, found) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) attachmentRecords(item, found)
    return
  }
  const attachment = value.attachment
  if (attachment !== null && typeof attachment === 'object' && typeof attachment.attachmentId === 'string') {
    const kind = value.type === 'file' ? 'file' : value.type === 'image' ? 'image' : 'unknown'
    const previous = found.get(attachment.attachmentId)
    if (previous === undefined) {
      found.set(attachment.attachmentId, {
        id: attachment.attachmentId,
        kind,
        name: typeof attachment.name === 'string' ? attachment.name : undefined,
        bytes: typeof attachment.bytes === 'number' ? attachment.bytes : 0,
        mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined,
      })
    } else if (previous.kind === 'unknown' && kind !== 'unknown') {
      previous.kind = kind
    }
  }
  for (const key of Object.keys(value)) {
    if (key === 'attachment') continue
    attachmentRecords(value[key], found)
  }
}

function resolveToolPath(base, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  if (isAbsolute(trimmed)) return resolve(trimmed)
  if (typeof base === 'string' && base.length > 0) return resolve(base, trimmed)
  return undefined
}

function extractFacts(events, headerCwd) {
  const attachments = new Map()
  const files = new Map()
  const cwdHistory = new Set()
  let currentCwd = typeof headerCwd === 'string' ? resolve(headerCwd) : undefined
  if (currentCwd !== undefined) cwdHistory.add(currentCwd)
  let lastEventTime = 0

  const addFile = (path, origin) => {
    if (path === undefined) return
    const key = pathKey(path)
    const previous = files.get(key)
    if (previous === undefined) files.set(key, { path, origins: new Set([origin]) })
    else previous.origins.add(origin)
  }

  for (const event of events) {
    if (typeof event.time === 'number' && event.time > lastEventTime) lastEventTime = event.time
    attachmentRecords(event.data, attachments)
    if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string' && event.data.cwd.length > 0) {
      const next = resolve(event.data.cwd)
      currentCwd = next
      cwdHistory.add(next)
      continue
    }
    if (event.type !== 'tool/call') continue
    const data = event.data
    let args
    try {
      args = JSON.parse(data.arguments)
    } catch {
      continue
    }
    if (args === null || typeof args !== 'object') continue
    if (data.name === 'working_directory' && typeof args.cd === 'string') {
      const next = resolveToolPath(currentCwd, args.cd)
      if (next !== undefined) {
        currentCwd = next
        cwdHistory.add(next)
      }
      continue
    }
    if (FILE_TOOLS.has(data.name)) {
      addFile(resolveToolPath(currentCwd, args.file_path ?? args.path), data.name)
      continue
    }
    if (data.name === 'present' && Array.isArray(args.files)) {
      for (const file of args.files) {
        if (file !== null && typeof file === 'object') addFile(resolveToolPath(currentCwd, file.path), 'present')
      }
    }
  }

  return {
    attachments,
    files,
    cwdHistory: [...cwdHistory],
    finalCwd: currentCwd,
    lastEventTime,
  }
}

/* ------------------------------------------------------------------------- *
 * Session-scoped spilled tool output
 *
 * dsh-spill-local keeps oversized results at <root>/session-<sha256(id)[0..12]>.
 * The default root is a per-process `dsh-spill-XXXXXX` directory under the OS
 * temp directory, so prior roots are discovered too. Only the exact hashed
 * directory for a selected Session is ever touched.
 * ------------------------------------------------------------------------- */

const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9]{6}$/

function spillSessionName(id) {
  return `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

async function spillRoots(ctx) {
  const roots = new Set()
  try {
    const spill = typeof ctx.get === 'function' ? ctx.get('spillStore') : undefined
    if (spill !== undefined && typeof spill.root === 'string' && isAbsolute(spill.root)) {
      roots.add(resolve(spill.root))
    }
  } catch {
    /* an unavailable spill service simply contributes no configured root */
  }
  try {
    const base = tmpdir()
    const entries = await readdir(base, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !SPILL_ROOT_RE.test(entry.name)) continue
      roots.add(join(base, entry.name))
    }
  } catch {
    /* a missing temp directory is not a cleanup failure */
  }
  return [...roots]
}

async function findSpillDirectories(ctx, ids) {
  const roots = await spillRoots(ctx)
  const found = []
  for (const id of ids) {
    const name = spillSessionName(id)
    for (const root of roots) {
      const directory = join(root, name)
      if (!(await isRealDirectory(directory))) continue
      found.push({
        id,
        root,
        directory,
        bytes: await sizeOfDirectory(directory),
      })
    }
  }
  return found
}

async function removeSpillDirectory(ctx, entry) {
  if (!(await isRealDirectory(entry.directory))) return { removed: false, bytes: 0, reason: 'missing' }
  const roots = await spillRoots(ctx)
  if (!roots.some((root) => samePath(root, entry.root))) {
    throw new Error('refusing to delete a spill directory under an unknown root')
  }
  if (basename(entry.directory) !== spillSessionName(entry.id)) {
    throw new Error('refusing to delete a spill directory that is not named for this Session')
  }
  if (!samePath(dirname(entry.directory), entry.root)) {
    throw new Error('refusing to delete a spill directory outside its root')
  }
  if (await hasSymlinkAncestor(entry.directory, entry.root)) {
    throw new Error('refusing to delete a spill directory reached through a symlink or junction')
  }
  const bytes = await sizeOfDirectory(entry.directory)
  await rm(entry.directory, { recursive: true, force: false, maxRetries: 3 })
  return { removed: true, bytes }
}

/* ------------------------------------------------------------------------- *
 * Preview
 * ------------------------------------------------------------------------- */

const factCache = new Map()

function cacheKey(id) {
  return id
}

function cachedFacts(id, revision) {
  const key = cacheKey(id)
  const entry = factCache.get(key)
  if (entry === undefined) return undefined
  if (entry.revision !== revision) return undefined
  if (Date.now() - entry.time > FACT_CACHE_TTL_MS) {
    factCache.delete(key)
    return undefined
  }
  factCache.delete(key)
  factCache.set(key, entry)
  return entry
}

function rememberFacts(id, revision, facts) {
  if (typeof revision !== 'string' && typeof revision !== 'number') return
  const key = cacheKey(id)
  factCache.delete(key)
  while (factCache.size >= MAX_FACT_CACHE) {
    const oldest = factCache.keys().next().value
    if (oldest === undefined) break
    factCache.delete(oldest)
  }
  factCache.set(key, { revision, facts, time: Date.now() })
}

async function factsFor(ctx, id, revision, headerCwd) {
  const cached = cachedFacts(id, revision)
  if (cached !== undefined) return cached.facts
  const read = await readEvents(ctx, id)
  const facts = extractFacts(read.events, headerCwd)
  facts.truncated = read.truncated
  rememberFacts(id, revision, facts)
  return facts
}

async function buildPreview(ctx, ids, options) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new HttpError(400, 'no-sessions', 'Select at least one archived Session.')
  }
  if (ids.length > MAX_SESSIONS_PER_REQUEST) {
    throw new HttpError(400, 'too-many-sessions', `Select at most ${MAX_SESSIONS_PER_REQUEST} Sessions at once.`)
  }
  const unique = [...new Set(ids)]
  const registry = ctx.workspaceRegistry
  const archived = new Set(registry.archivedSessionIds)
  for (const id of unique) {
    if (!isSafeSessionId(id)) {
      throw new HttpError(400, 'unsafe-session-id', `Session ${id} has an id that cannot be used as a filesystem key.`)
    }
    if (!archived.has(id)) {
      throw new HttpError(409, 'not-archived', `Session ${id} is not archived; refresh the list and try again.`)
    }
    if (isAgentRunning(ctx, id)) {
      throw new HttpError(409, 'session-live', `Session ${id} is still running; stop it before deleting.`)
    }
    if (isSessionOpen(ctx, id)) {
      throw new HttpError(409, 'session-open', `Session ${id} is still loaded in this Host process. Close its conversation or restart Harness, then delete. Archiving stops work but does not unload the Agent.`)
    }
  }

  const snapshots = await ctx.sessionPersistence.list()
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
  const workspaces = registry.list()
  const workspaceBySession = new Map()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }

  let titles = new Map()
  try {
    const results = await ctx.sessionQuery.readTitleSnapshots(unique)
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) {
        titles.set(result.sessionId, result.value.title.title)
      }
    }
  } catch {
    titles = new Map()
  }

  const root = persistenceRoot(ctx)
  const sessions = []
  const attachments = new Map()
  const fileMap = new Map()
  const warnings = []
  if (options.imageCache === true) {
    warnings.push('The attachment request-image cache is shared by every Session; clearing it affects all Sessions. It is rebuildable and does not remove durable attachments.')
  }
  const unreadable = new Set()
  let sessionBytes = 0
  let projectionBytes = 0
  let conversationBytes = 0

  for (const id of unique) {
    const snapshot = snapshotById.get(id)
    const workspace = workspaceBySession.get(id)
    const sessionOpen = ctx.sessions.get(id) !== undefined
    const running = isAgentRunning(ctx, id)
    const base = {
      id,
      title: titles.get(id) ?? undefined,
      cwd: snapshot?.header.cwd,
      createdAt: snapshot?.header.createdAt ?? 0,
      live: running,
      open: sessionOpen,
      missing: snapshot === undefined,
      workspace: workspace === undefined ? null : { title: workspace.title, path: workspace.path },
      conversationFolder: null,
      logDir: undefined,
      logFiles: [],
      logBytes: 0,
      projectionCache: { path: projectionCachePath(id), exists: false, bytes: 0 },
      readError: undefined,
      lastEventTime: snapshot?.header.createdAt ?? 0,
    }
    if (snapshot === undefined) {
      sessions.push(base)
      continue
    }

    const cachePath = projectionCachePath(id)
    const cacheSize = await sizeOfFile(cachePath)
    base.projectionCache = { path: cachePath, exists: cacheSize > 0, bytes: cacheSize }
    projectionBytes += cacheSize

    const directory = await resolveSessionDirectory(root, snapshot.header, id)
    if (directory !== undefined) {
      base.logDir = directory
      base.logFiles = await listNames(directory)
      base.logBytes = await sizeOfDirectory(directory)
      sessionBytes += base.logBytes
    } else {
      warnings.push(`Session ${id}: its stored log directory was not found. Only the archive entry and checkpoint can be removed.`)
    }

    let facts
    try {
      facts = await factsFor(ctx, id, snapshot.revision, snapshot.header.cwd)
      base.lastEventTime = facts.lastEventTime || base.createdAt
      if (facts.truncated === true) {
        unreadable.add(id)
        base.readError = `event log exceeds ${MAX_EVENTS_PER_SESSION} events`
        warnings.push(`Session ${id}: ${base.readError}; attachment and file cleanup is disabled for this Session so a partial scan cannot delete a shared object.`)
      } else {
        for (const attachment of facts.attachments.values()) {
          if (!attachments.has(attachment.id)) attachments.set(attachment.id, attachment)
        }
        for (const file of facts.files.values()) {
          addFileCandidate(fileMap, file, base, options, false)
        }
        if (options.scanCreated === true) {
          for (const cwd of facts.cwdHistory) {
            await scanCreatedFiles(cwd, base, fileMap, options, warnings)
          }
        }
      }
    } catch (error) {
      unreadable.add(id)
      base.readError = formatError(error)
      warnings.push(`Session ${id}: its event log could not be read (${base.readError}). Attachment and file cleanup is disabled for this run.`)
    }

    const conversationRoot = workspace?.path ?? snapshot.header.cwd
    const conversation = await findConversationFolder(conversationRoot, id, facts)
    if (conversation !== undefined) {
      const bytes = await sizeOfDirectory(conversation.folder)
      const entries = await readdir(conversation.folder, { withFileTypes: true }).catch(() => [])
      const names = entries.map((entry) => entry.name)
      const splitLayout = names.includes('work') || names.includes('out')
      const unknownEntries = splitLayout
        ? names.filter((name) => !KNOWN_FOLDER_ENTRIES.has(name))
        : []
      base.conversationFolder = {
        path: conversation.folder,
        workspace: conversation.workspace,
        base: conversation.base,
        indexPath: conversation.indexPath,
        bytes,
        entries: names.slice(0, 50),
        entryCount: names.length,
        unknownEntries: unknownEntries.slice(0, 50),
        unknownCount: unknownEntries.length,
        layout: splitLayout ? 'split' : 'flat',
        allowUnknown: options.allowUnknownFolderEntries === true,
        sharedWith: [],
        referencesUnknown: false,
        deletable: false,
        selected: false,
        reason: undefined,
        reasonCode: undefined,
      }
    }
    sessions.push(base)
  }

  const sessionInfo = new Map(sessions.map((session) => [session.id, session]))
  const spills = options.spills === true ? await findSpillDirectories(ctx, unique) : []
  const spillBytes = spills.reduce((sum, spill) => sum + spill.bytes, 0)
  if (fileMap.size >= MAX_FILE_CANDIDATES) {
    warnings.push(`The workspace file list stopped at ${MAX_FILE_CANDIDATES} candidates. Narrow the selection or inspect the workspace manually.`)
  }

  /* References from every Session that stays behind. Folder users are checked
     too: subagents and forks can share a parent conversation folder. */
  let remainingUnreadable = false
  let attachmentIndex = new Map()
  let folderIndex = new Map()
  let childrenByParent = new Map()
  const pathIndex = new Map()
  const hasConversationFolders = sessions.some((session) => session.conversationFolder !== null)
  const needsReferenceScan = (options.attachments === true && attachments.size > 0) ||
    (options.workspaceFiles === true && fileMap.size > 0) ||
    (options.conversationFolder === true && hasConversationFolders)
  if (needsReferenceScan) {
    if (snapshots.length - unique.length > MAX_REFERENCE_SESSIONS) {
      warnings.push(`There are more than ${MAX_REFERENCE_SESSIONS} remaining Sessions; attachment, workspace-file, and conversation-folder sharing was not checked. Unsafe items will be kept.`)
      remainingUnreadable = true
    } else {
      const remaining = snapshots.filter((snapshot) => !unique.includes(snapshot.header.id))
      const indexed = await indexRemainingSessions(ctx, remaining, warnings)
      remainingUnreadable = indexed.unreadable
      attachmentIndex = indexed.attachments
      folderIndex = indexed.folders
      childrenByParent = indexed.children
      for (const [path, sessionIds] of indexed.paths) pathIndex.set(path, sessionIds)
    }
  }

  /* Decide whether each conversation folder is safe to remove as a whole. */
  for (const session of sessions) {
    const folder = session.conversationFolder
    if (folder === null) continue
    const users = new Set(folderIndex.get(pathKey(folder.path)) ?? [])
    for (const childId of childrenByParent.get(session.id) ?? []) users.add(childId)
    folder.sharedWith = [...users].filter((id) => !unique.includes(id))
    folder.referencesUnknown = remainingUnreadable
    const unknownBlocked = folder.unknownCount > 0 && folder.allowUnknown !== true
    folder.deletable = folder.sharedWith.length === 0 && !folder.referencesUnknown && !unknownBlocked
    if (folder.sharedWith.length > 0) {
      folder.reasonCode = 'shared'
      folder.reason = `Still used by ${folder.sharedWith.length} other Session(s).`
    } else if (folder.referencesUnknown) {
      folder.reasonCode = 'references-unknown'
      folder.reason = 'A remaining Session log could not be read, so folder sharing is unknown.'
    } else if (unknownBlocked) {
      folder.reasonCode = 'unknown-entries'
      folder.reason = `The folder contains ${folder.unknownCount} unexpected top-level entr${folder.unknownCount === 1 ? 'y' : 'ies'}.`
    }
    folder.selected = options.conversationFolder === true && folder.deletable
    if (folder.selected) conversationBytes += folder.bytes
  }

  /* Files inside a folder that will be removed are not listed twice. Files in a
     shared folder whose references are unknown must not be deleted one by one. */
  for (const session of sessions) {
    const folder = session.conversationFolder
    if (folder === null) continue
    for (const [key, candidate] of fileMap) {
      if (!isInside(candidate.path, folder.path)) continue
      if (folder.selected) {
        fileMap.delete(key)
      } else if (folder.reasonCode === 'shared' || folder.reasonCode === 'references-unknown') {
        candidate.referencesUnknown = true
        candidate.reasonCode = 'shared-folder'
        candidate.reason = 'The containing conversation folder is still used by another Session.'
        candidate.selectedByDefault = false
      }
    }
  }

  await enrichFileCandidates(fileMap, sessionInfo)

  const attachmentList = []
  if (options.attachments === true) {
    for (const attachment of attachments.values()) {
      const users = attachmentIndex.get(attachment.id)
      const sharedWith = users === undefined ? [] : [...users].filter((id) => !unique.includes(id))
      const recognised = /^sha256:[0-9a-f]{64}$/i.test(attachment.id)
      const deletable = recognised && !remainingUnreadable && sharedWith.length === 0 && !unreadable.size
      let reason
      let reasonCode
      if (!recognised) {
        reason = 'The attachment id is not a content-addressed digest this plugin can locate.'
        reasonCode = 'unrecognised'
      } else if (unreadable.size > 0) {
        reason = 'A selected Session log could not be read, so attachment references are unknown.'
        reasonCode = 'unreadable-selected'
      } else if (remainingUnreadable) {
        reason = 'A remaining Session log could not be read, so attachment references are unknown.'
        reasonCode = 'unreadable-remaining'
      } else if (sharedWith.length > 0) {
        reason = 'Still referenced by another Session.'
        reasonCode = 'shared'
      }
      attachmentList.push({
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        deletable,
        reason,
        reasonCode,
        sharedWith,
      })
    }
  }

  for (const [path, candidate] of fileMap) {
    const users = pathIndex.get(path)
    candidate.sharedWith = users === undefined ? [] : [...users].filter((id) => !unique.includes(id))
    if (remainingUnreadable) candidate.referencesUnknown = true
    if (candidate.protected === true) {
      candidate.reasonCode ??= 'protected'
      candidate.reason ??= 'Protected; will not be deleted.'
    } else if (candidate.outsideWorkspace === true) {
      candidate.reasonCode = 'outside-workspace'
      candidate.reason = 'Outside the Session workspace; will not be deleted.'
    } else if (candidate.referencesUnknown === true) {
      candidate.reasonCode ??= 'references-unknown'
      candidate.reason ??= 'A remaining Session log could not be read, so sharing is unknown.'
    } else if (candidate.sharedWith.length > 0) {
      candidate.reasonCode = 'shared'
      candidate.reason = 'Still referenced by another Session.'
    }
    candidate.deletable = candidate.exists === true &&
      candidate.protected !== true &&
      candidate.outsideWorkspace !== true &&
      candidate.referencesUnknown !== true &&
      candidate.sharedWith.length === 0
    candidate.selectedByDefault = candidate.deletable &&
      candidate.createdDuring === true &&
      candidate.origins.some((origin) => origin !== 'scan')
    if (candidate.deletable !== true) candidate.selectedByDefault = false
  }

  const files = [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path))
  const attachmentBytes = attachmentList
    .filter((attachment) => attachment.deletable)
    .reduce((sum, attachment) => sum + attachment.bytes, 0)
  const fileBytes = files
    .filter((file) => file.selectedByDefault === true)
    .reduce((sum, file) => sum + file.sizeBytes, 0)

  return {
    sessions,
    attachments: attachmentList,
    files,
    spills,
    warnings,
    totals: {
      sessionBytes,
      projectionBytes,
      conversationBytes,
      attachmentBytes,
      fileBytes,
      spillBytes,
      totalBytes: sessionBytes + projectionBytes + conversationBytes + attachmentBytes + fileBytes + spillBytes,
    },
    options,
    root,
  }
}

function addFileCandidate(fileMap, file, session, options, scanned) {
  if (options.workspaceFiles !== true) return
  if (fileMap.size >= MAX_FILE_CANDIDATES) return
  const key = pathKey(file.path)
  const existing = fileMap.get(key)
  const origins = [...file.origins]
  if (existing !== undefined) {
    existing.sessionIds.add(session.id)
    for (const origin of origins) existing.origins.add(origin)
    return
  }
  fileMap.set(key, {
    path: file.path,
    sessionIds: new Set([session.id]),
    origins: new Set(origins),
    sizeBytes: 0,
    createdDuring: false,
    selectedByDefault: false,
    deletable: false,
    outsideWorkspace: false,
    referencesUnknown: false,
    sharedWith: [],
    protected: false,
    exists: false,
    scanned: scanned === true,
    reason: undefined,
    reasonCode: undefined,
  })
}

async function scanCreatedFiles(root, session, fileMap, options, warnings) {
  if (options.workspaceFiles !== true || options.scanCreated !== true) return
  if (typeof root !== 'string' || root.length === 0) return
  if (isProtectedPath(root)) return
  const info = await lstatSafe(root)
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) return
  const home = homeDirectory()
  if (samePath(root, home) || samePath(root, homedir())) return
  if (samePath(root, dirname(root))) return

  const start = Math.max(0, session.createdAt - 120000)
  const end = Math.max(session.lastEventTime, session.createdAt) + 300000
  const stack = [{ directory: root, depth: 0 }]
  let seen = 0
  while (stack.length > 0 && seen < MAX_SCAN_ENTRIES) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (seen >= MAX_SCAN_ENTRIES) break
      seen += 1
      const child = join(current.directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (current.depth + 1 <= MAX_SCAN_DEPTH && !SKIP_DIRS.has(entry.name.toLowerCase())) {
          stack.push({ directory: child, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      let fileInfo
      try {
        fileInfo = await lstat(child)
      } catch {
        continue
      }
      const born = fileInfo.birthtimeMs
      if (!Number.isFinite(born) || born <= 0) continue
      if (born < start || born > end) continue
      addFileCandidate(fileMap, { path: child, origins: new Set(['scan']) }, session, options, true)
    }
  }
  if (seen >= MAX_SCAN_ENTRIES) {
    warnings.push(`Workspace scan under ${root} stopped after ${MAX_SCAN_ENTRIES} entries.`)
  }
}

async function indexRemainingSessions(ctx, snapshots, warnings) {
  const attachments = new Map()
  const paths = new Map()
  const folders = new Map()
  const children = new Map()
  let unreadable = false
  let index = 0
  const workers = Array.from({ length: Math.min(4, snapshots.length) }, async () => {
    while (index < snapshots.length) {
      const current = snapshots[index]
      index += 1
      if (typeof current.header.parentSession === 'string') {
        const list = children.get(current.header.parentSession) ?? []
        list.push(current.header.id)
        children.set(current.header.parentSession, list)
      }
      let facts
      try {
        const live = ctx.sessions.get(current.header.id)
        if (live !== undefined) {
          const events = live.snapshotEvents()
          if (events.length >= MAX_EVENTS_PER_SESSION) {
            throw new Error(`live event log reaches the ${MAX_EVENTS_PER_SESSION}-event scan limit`)
          }
          facts = extractFacts(events, current.header.cwd)
          facts.truncated = false
        } else {
          facts = await factsFor(ctx, current.header.id, current.revision, current.header.cwd)
        }
      } catch (error) {
        unreadable = true
        warnings.push(`Session ${current.header.id}: its event log could not be read (${formatError(error)}); shared attachments, files, and folders cannot be proven safe to delete.`)
        continue
      }
      if (facts.truncated === true) {
        unreadable = true
        warnings.push(`Session ${current.header.id}: its event log exceeds ${MAX_EVENTS_PER_SESSION} events; shared attachments, files, and folders cannot be proven safe to delete.`)
        continue
      }
      for (const attachment of facts.attachments.values()) {
        const users = attachments.get(attachment.id)
        if (users === undefined) attachments.set(attachment.id, new Set([current.header.id]))
        else users.add(current.header.id)
      }
      for (const file of facts.files.values()) {
        const key = pathKey(file.path)
        const users = paths.get(key)
        if (users === undefined) paths.set(key, new Set([current.header.id]))
        else users.add(current.header.id)
      }
      for (const cwd of facts.cwdHistory) {
        const key = pathKey(cwd)
        const users = folders.get(key)
        if (users === undefined) folders.set(key, new Set([current.header.id]))
        else users.add(current.header.id)
      }
    }
  })
  await Promise.all(workers)
  return { attachments, paths, folders, children, unreadable }
}

function isWithin(path, root) {
  return samePath(path, root) || isInside(path, root)
}

async function enrichFileCandidates(fileMap, sessionInfo) {
  for (const candidate of fileMap.values()) {
    const info = await lstatSafe(candidate.path)
    if (info === undefined) {
      candidate.exists = false
      candidate.sizeBytes = 0
      candidate.protected = true
      candidate.reason = 'missing'
      candidate.reasonCode = 'missing'
      candidate.deletable = false
      candidate.selectedByDefault = false
      candidate.sessionIds = [...candidate.sessionIds]
      candidate.origins = [...candidate.origins]
      continue
    }
    candidate.exists = true
    candidate.sizeBytes = info.size
    if (info.isSymbolicLink()) {
      candidate.protected = true
      candidate.reason = 'symlink'
      candidate.reasonCode = 'symlink'
      candidate.deletable = false
      candidate.selectedByDefault = false
      candidate.sessionIds = [...candidate.sessionIds]
      candidate.origins = [...candidate.origins]
      continue
    }
    if (!info.isFile()) {
      candidate.protected = true
      candidate.reason = 'not-a-regular-file'
      candidate.reasonCode = 'not-a-regular-file'
      candidate.deletable = false
      candidate.selectedByDefault = false
      candidate.sessionIds = [...candidate.sessionIds]
      candidate.origins = [...candidate.origins]
      continue
    }
    if (isProtectedPath(candidate.path)) {
      candidate.protected = true
      candidate.reason = 'protected'
      candidate.reasonCode = 'protected'
      candidate.deletable = false
      candidate.selectedByDefault = false
      candidate.sessionIds = [...candidate.sessionIds]
      candidate.origins = [...candidate.origins]
      continue
    }

    const sessionIds = [...candidate.sessionIds]
    const starts = sessionIds
      .map((id) => sessionInfo.get(id)?.createdAt ?? 0)
      .filter((value) => value > 0)
    const earliestStart = starts.length > 0 ? Math.min(...starts) : 0
    const born = info.birthtimeMs
    candidate.createdDuring = Number.isFinite(born) && born > 0 &&
      earliestStart > 0 && born >= earliestStart - 120000

    const boundaries = []
    for (const id of sessionIds) {
      const session = sessionInfo.get(id)
      if (session === undefined) continue
      if (session.workspace !== null && typeof session.workspace?.path === 'string') {
        boundaries.push(session.workspace.path)
      }
      if (typeof session.cwd === 'string' && session.cwd.length > 0) boundaries.push(session.cwd)
    }
    const containing = boundaries
      .filter((root) => isInside(candidate.path, root))
      .sort((left, right) => right.length - left.length)
    candidate.workspaceRoot = containing[0]
    candidate.outsideWorkspace = containing.length === 0

    if (candidate.workspaceRoot !== undefined) {
      const boundaryInfo = await lstatSafe(candidate.workspaceRoot)
      if ((boundaryInfo !== undefined && boundaryInfo.isSymbolicLink()) ||
          await hasSymlinkAncestor(candidate.path, candidate.workspaceRoot)) {
        candidate.protected = true
        candidate.reason = 'symlink-ancestor'
        candidate.reasonCode = 'symlink-ancestor'
        candidate.deletable = false
        candidate.selectedByDefault = false
      }
    }

    candidate.sessionIds = sessionIds
    candidate.origins = [...candidate.origins]
  }
  return [...fileMap.values()]
}

/* ------------------------------------------------------------------------- *
 * Deletion
 * ------------------------------------------------------------------------- */

async function removeProjectionCache(ctx, id, warnings) {
  const path = projectionCachePath(id)
  if (await hasSymlinkAncestor(path, join(homeDirectory(), 'storages'))) {
    warnings.push(`Projection checkpoint ${id}: path crosses a symlink or junction; kept.`)
    return { removed: false, bytes: 0, path }
  }
  const bytes = await sizeOfFile(path)
  let removed = false
  try {
    const domain = typeof ctx.storageDomain.get === 'function' ? ctx.storageDomain.get('session_projcache') : undefined
    const table = domain !== undefined && typeof domain.table === 'function' ? domain.table('sessions') : undefined
    if (table !== undefined && typeof table.delete === 'function') {
      removed = (await table.delete(id)) === true
    }
  } catch (error) {
    warnings.push(`Projection checkpoint ${id}: domain deletion failed (${formatError(error)}); removing the file directly.`)
  }
  /* A false return means the domain had no record. The file may still exist
     (for example after an invalid-record backup was skipped), so always fall
     back to the direct path instead of trusting the boolean alone. */
  try {
    await unlink(path)
    removed = true
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) {
      removed = false
      warnings.push(`Projection checkpoint ${id}: ${formatError(error)}`)
    }
  }
  let backupBytes = 0
  try {
    const directory = dirname(path)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${id}.json.bak.`)) continue
      const backup = join(directory, entry.name)
      const size = await sizeOfFile(backup)
      try {
        await unlink(backup)
        backupBytes += size
      } catch {
        /* a concurrently removed backup is already clean */
      }
    }
  } catch {
    /* no checkpoint directory means there is nothing to clean */
  }
  return { removed: removed || backupBytes > 0, bytes: bytes + backupBytes, path }
}

async function removeSessionDirectory(root, directory, id) {
  if (directory === undefined) return { removed: false, reason: 'missing' }
  assertOwnedSessionDirectory(root, directory, id)
  const info = await lstatSafe(directory)
  if (info === undefined) return { removed: false, reason: 'missing' }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('refusing to delete a Session directory that is not a real directory')
  }
  if (await hasSymlinkAncestor(directory, root)) {
    throw new Error('refusing to delete a Session directory reached through a symlink or junction')
  }
  const bytes = await sizeOfDirectory(directory)
  const project = dirname(directory)
  try {
    await rm(directory, { recursive: true, force: false, maxRetries: 3 })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { removed: false, reason: 'missing' }
    throw error
  }
  if (!samePath(project, resolve(root))) {
    try {
      await rmdir(project)
    } catch {
      /* another Session still uses this project directory */
    }
  }
  return { removed: true, bytes }
}

async function attachmentPaths(ctx, attachment) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(attachment.id)
  if (match === null) return undefined
  const digest = match[1].toLowerCase()
  const home = homeDirectory()
  const prefix = digest.slice(0, 2)
  const imageObject = join(home, 'attachments', 'v1', 'objects', prefix, digest)
  const fileObject = join(home, 'attachments', 'v1', 'file-objects', prefix, digest)
  const fileReference = join(home, 'attachments', 'v1', 'files', prefix, digest)
  return { digest, imageObject, fileObject, fileReference }
}

async function removeAttachment(ctx, attachment) {
  const paths = await attachmentPaths(ctx, attachment)
  if (paths === undefined) {
    return { removed: false, bytes: 0, reason: 'unrecognised attachment id' }
  }
  const attachmentRoot = join(homeDirectory(), 'attachments', 'v1')
  for (const path of [paths.imageObject, paths.fileObject, paths.fileReference]) {
    if (await hasSymlinkAncestor(path, attachmentRoot)) {
      throw new Error('refusing to delete an attachment reached through a symlink or junction')
    }
  }
  let bytes = 0
  let removed = false
  const removeFile = async (path) => {
    const info = await lstatSafe(path)
    if (info === undefined || !info.isFile()) return
    if (info.isSymbolicLink()) return
    await unlink(path)
    bytes += info.size
    removed = true
  }
  /* A digest may have been admitted as an image and later as a generic file;
     the reference check already proved that no remaining Session names it. */
  await removeFile(paths.imageObject)
  const referenceInfo = await lstatSafe(paths.fileReference)
  if (referenceInfo !== undefined && referenceInfo.isSymbolicLink()) {
    throw new Error('refusing to delete a file-reference directory that is a symlink')
  }
  const referenceBytes = await sizeOfDirectory(paths.fileReference)
  try {
    await rm(paths.fileReference, { recursive: true, force: true })
    if (referenceInfo !== undefined) {
      bytes += referenceInfo.isFile() ? referenceInfo.size : referenceBytes
      removed = true
    }
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error
  }
  await removeFile(paths.fileObject)
  for (const directory of new Set([
    dirname(paths.imageObject),
    dirname(paths.fileObject),
    dirname(paths.fileReference),
  ])) {
    try {
      await rmdir(directory)
    } catch {
      /* the prefix directory still holds another object */
    }
  }
  return { removed, bytes }
}

async function pruneEmptyParents(file, boundary) {
  if (typeof boundary !== 'string' || boundary.length === 0) return
  let directory = dirname(file)
  while (isInside(directory, boundary) && !samePath(directory, boundary)) {
    try {
      await rmdir(directory)
    } catch {
      break
    }
    directory = dirname(directory)
  }
}

async function removeFileCandidate(candidate, warnings) {
  if (candidate.deletable !== true) {
    return { removed: false, bytes: 0, reason: candidate.reasonCode ?? 'not-deletable' }
  }
  if (candidate.outsideWorkspace === true ||
      candidate.referencesUnknown === true ||
      (candidate.sharedWith !== undefined && candidate.sharedWith.length > 0)) {
    return { removed: false, bytes: 0, reason: candidate.reasonCode ?? 'unsafe' }
  }
  let info
  try {
    info = await lstat(candidate.path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { removed: false, bytes: 0, reason: 'missing' }
    throw error
  }
  if (info.isSymbolicLink()) return { removed: false, bytes: 0, reason: 'symlink' }
  if (!info.isFile()) return { removed: false, bytes: 0, reason: 'not-a-regular-file' }
  if (isProtectedPath(candidate.path)) return { removed: false, bytes: 0, reason: 'protected' }
  if (candidate.workspaceRoot !== undefined) {
    const boundaryInfo = await lstatSafe(candidate.workspaceRoot)
    if ((boundaryInfo !== undefined && boundaryInfo.isSymbolicLink()) ||
        await hasSymlinkAncestor(candidate.path, candidate.workspaceRoot)) {
      return { removed: false, bytes: 0, reason: 'symlink-ancestor' }
    }
  }
  const bytes = info.size
  await unlink(candidate.path)
  const boundary = candidate.workspaceRoot
  if (typeof boundary === 'string') {
    await pruneEmptyParents(candidate.path, boundary)
  }
  return { removed: true, bytes }
}

async function clearImageCache() {
  const directory = join(homeDirectory(), 'cache', 'attachments', 'request-images')
  const info = await lstatSafe(directory)
  if (info === undefined) return { removed: false, bytes: 0 }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('refusing to clear an image cache that is not a real directory')
  }
  if (await hasSymlinkAncestor(directory, join(homeDirectory(), 'cache'))) {
    throw new Error('refusing to clear an image cache reached through a symlink or junction')
  }
  const bytes = await sizeOfDirectory(directory)
  try {
    await rm(directory, { recursive: true, force: true })
    return { removed: true, bytes }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { removed: false, bytes: 0 }
    throw error
  }
}

/* ------------------------------------------------------------------------- *
 * HTTP API
 * ------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const previewTokens = new Map()

function previewFingerprint(preview) {
  const sessions = (preview.sessions || [])
    .map((session) => [
      session.id,
      session.conversationFolder?.path ?? null,
      session.conversationFolder?.deletable === true,
      session.conversationFolder?.sharedWith?.length ?? 0,
      session.conversationFolder?.unknownCount ?? 0,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const files = (preview.files || [])
    .map((file) => [file.path, file.deletable === true, file.exists === true, file.selectedByDefault === true])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const attachments = (preview.attachments || [])
    .map((attachment) => [attachment.id, attachment.deletable === true])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const spills = (preview.spills || [])
    .map((spill) => spill.directory)
    .sort()
  return JSON.stringify({ sessions, files, attachments, spills, options: preview.options })
}

function prunePreviewTokens() {
  const now = Date.now()
  for (const [token, record] of previewTokens) {
    if (record.expiresAt <= now) previewTokens.delete(token)
  }
  while (previewTokens.size > MAX_PREVIEW_TOKENS) {
    const oldest = previewTokens.keys().next().value
    if (oldest === undefined) break
    previewTokens.delete(oldest)
  }
}

function rememberPreview(ids, options, preview) {
  prunePreviewTokens()
  const token = randomBytes(24).toString('base64url')
  previewTokens.set(token, {
    ids: [...new Set(ids)].sort(),
    options,
    fingerprint: previewFingerprint(preview),
    expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS,
  })
  prunePreviewTokens()
  return token
}

function getPreviewToken(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const record = previewTokens.get(token)
  if (record === undefined) return undefined
  if (record.expiresAt <= Date.now()) {
    previewTokens.delete(token)
    return undefined
  }
  return record
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large', 'Request body is too large.')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body is not valid JSON.')
  }
}

function normaliseOptions(input) {
  const options = input !== null && typeof input === 'object' ? input : {}
  return {
    attachments: options.attachments === true,
    workspaceFiles: options.workspaceFiles === true,
    scanCreated: options.scanCreated === true,
    spills: options.spills === true,
    conversationFolder: options.conversationFolder === true,
    allowUnknownFolderEntries: options.allowUnknownFolderEntries === true,
    imageCache: options.imageCache === true,
  }
}

function commonAncestor(directories) {
  if (directories.length === 0) return undefined
  let common = resolve(directories[0])
  for (const directory of directories.slice(1)) {
    const target = resolve(directory)
    while (!isWithin(target, common)) {
      const parent = dirname(common)
      if (samePath(parent, common)) return undefined
      common = parent
    }
  }
  return common
}

/**
 * Resolve the directory a Session actually worked in. The stored header cwd is
 * often the workspace root; file-tool paths and the last working_directory call
 * are closer to "the project folder" the user expects to inspect.
 */
async function usableProjectDirectory(directory, boundary) {
  const resolved = resolve(directory)
  if (!(await isRealDirectory(resolved))) return false
  if (SKIP_DIRS.has(basename(resolved).toLowerCase())) return false
  if (samePath(resolved, dirname(resolved))) return false
  if (samePath(resolved, homedir())) return false
  if (isWithin(homedir(), resolved)) return false
  const temp = resolve(tmpdir())
  if (isWithin(resolved, temp)) return false
  if (isProtectedPath(resolved)) return false
  if (boundary !== undefined && isWithin(boundary, resolved)) return false
  return true
}

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'requirements.txt',
  'setup.py',
  'Makefile',
]

async function hasProjectMarker(directory) {
  for (const marker of PROJECT_MARKERS) {
    if ((await lstatSafe(join(directory, marker))) !== undefined) return true
  }
  return false
}

/**
 * Walk up from the common file directory to the nearest project marker, without
 * climbing above the session workspace (or above a drive/home boundary for an
 * external project). This turns `proj/src` into `proj` when `proj` is a real
 * project, while leaving a marker-less `src` directory alone.
 */
async function refineProjectRoot(directory, boundary) {
  let current = resolve(directory)
  const original = current
  for (let depth = 0; depth < 4; depth += 1) {
    if (boundary !== undefined && samePath(current, boundary)) break
    if (await hasProjectMarker(current)) return current
    const parent = dirname(current)
    if (samePath(parent, current)) break
    if (isProtectedPath(parent)) break
    if (boundary !== undefined && isWithin(parent, boundary) === false && isWithin(current, boundary) === false) {
      /* external project: keep climbing only while the path stays outside the workspace */
      if (samePath(parent, homedir()) || isWithin(homedir(), parent)) break
    }
    current = parent
  }
  return original
}

async function resolveProjectPath(ctx, id) {
  if (!isSafeSessionId(id)) {
    throw new HttpError(400, 'unsafe-session-id', 'The Session id cannot be used as a path key.')
  }
  const registry = ctx.workspaceRegistry
  if (!new Set(registry.archivedSessionIds).has(id)) {
    throw new HttpError(409, 'not-archived', 'The Session is no longer archived.')
  }
  const workspace = registry.list().find((entry) => entry.sessionIds.includes(id))
  const workspacePath = workspace === undefined ? undefined : workspace.path
  const snapshot = await ctx.sessionPersistence.stat(id)
  const headerCwd = snapshot === undefined ? undefined : snapshot.header.cwd
  const fallback = typeof headerCwd === 'string' && headerCwd.length > 0
    ? resolve(headerCwd)
    : (typeof workspacePath === 'string' && workspacePath.length > 0 ? resolve(workspacePath) : undefined)
  if (snapshot === undefined) return { path: fallback, source: 'workspace' }

  let facts
  try {
    facts = await factsFor(ctx, id, snapshot.revision, snapshot.header.cwd)
  } catch {
    return { path: fallback, source: 'header' }
  }
  const conversationRoot = typeof workspacePath === 'string' && workspacePath.length > 0 ? workspacePath : headerCwd
  const conversation = await findConversationFolder(conversationRoot, id, facts)
  if (conversation !== undefined) return { path: conversation.folder, source: 'conversation' }
  if (facts.truncated === true) return { path: fallback, source: 'header' }

  const boundary = fallback
  const temp = resolve(tmpdir())
  const fileDirectories = []
  for (const file of facts.files.values()) {
    const directory = dirname(file.path)
    if (isWithin(directory, temp) || isProtectedPath(directory)) continue
    fileDirectories.push(directory)
  }
  const resolvedCommon = commonAncestor(fileDirectories)
  const refinedCommon = resolvedCommon === undefined ? undefined : await refineProjectRoot(resolvedCommon, boundary)
  const refinedFinal = typeof facts.finalCwd === 'string' ? await refineProjectRoot(facts.finalCwd, boundary) : undefined
  const ordered = []
  if (refinedCommon !== undefined && await usableProjectDirectory(refinedCommon, boundary)) {
    ordered.push({ path: refinedCommon, source: 'files' })
  }
  if (refinedFinal !== undefined && await usableProjectDirectory(refinedFinal, boundary)) {
    ordered.push({ path: refinedFinal, source: 'working-directory' })
  }
  if (typeof headerCwd === 'string' && headerCwd.length > 0 && await isRealDirectory(headerCwd)) {
    ordered.push({ path: resolve(headerCwd), source: 'header' })
  }
  if (typeof workspacePath === 'string' && workspacePath.length > 0 && await isRealDirectory(workspacePath)) {
    ordered.push({ path: resolve(workspacePath), source: 'workspace' })
  }
  const chosen = ordered[0]
  return chosen === undefined ? { path: fallback, source: 'header' } : chosen
}

async function listArchived(ctx) {
  const registry = ctx.workspaceRegistry
  const archivedIds = [...registry.archivedSessionIds].filter(isSafeSessionId)
  const snapshots = await ctx.sessionPersistence.list()
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
  const workspaceBySession = new Map()
  const workspaceRoots = new Set()
  for (const workspace of registry.list()) {
    workspaceRoots.add(workspace.path)
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }
  for (const snapshot of snapshots) {
    if (typeof snapshot.header.cwd === 'string' && snapshot.header.cwd.length > 0) workspaceRoots.add(snapshot.header.cwd)
  }
  const conversationFolders = await indexConversationFolders([...workspaceRoots], archivedIds)
  let titles = new Map()
  try {
    const results = await ctx.sessionQuery.readTitleSnapshots(archivedIds)
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) {
        titles.set(result.sessionId, result.value.title.title)
      }
    }
  } catch {
    titles = new Map()
  }
  const sessions = archivedIds.map((id) => {
    const snapshot = snapshotById.get(id)
    const workspace = workspaceBySession.get(id)
    return {
      id,
      title: titles.get(id) ?? undefined,
      cwd: snapshot?.header.cwd,
      createdAt: snapshot?.header.createdAt ?? 0,
      sizeBytes: snapshot?.sizeBytes ?? 0,
      eventCount: snapshot?.eventCount ?? 0,
      live: isAgentRunning(ctx, id),
      open: isSessionOpen(ctx, id),
      missing: snapshot === undefined,
      workspace: workspace === undefined ? null : { title: workspace.title, path: workspace.path },
      conversationFolder: conversationFolders.get(id)?.folder ?? null,
    }
  })
  sessions.sort((left, right) => {
    if (left.missing !== right.missing) return left.missing ? 1 : -1
    return right.createdAt - left.createdAt
  })
  return {
    sessions,
    totalBytes: sessions.reduce((sum, session) => sum + (session.sizeBytes || 0), 0),
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    return true
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      /* no temporary file to clean */
    }
    throw error
  }
}

async function removeConversationIndexEntry(indexPath, id, warnings) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const index = await readJsonFile(indexPath, undefined)
    if (index === null || typeof index !== 'object' || Array.isArray(index)) {
      if (attempt === 0) {
        warnings.push(`Conversation index ${indexPath}: it is missing or malformed; the folder was removed but its index entry could not be updated.`)
      }
      return false
    }
    if (!Object.prototype.hasOwnProperty.call(index, id)) return false
    const next = { ...index }
    delete next[id]
    try {
      await writeJsonAtomic(indexPath, next)
    } catch (error) {
      warnings.push(`Conversation index ${indexPath}: could not remove ${id} (${formatError(error)}).`)
      return false
    }
    const after = await readJsonFile(indexPath, undefined)
    if (after === null || typeof after !== 'object' || Array.isArray(after)) continue
    if (!Object.prototype.hasOwnProperty.call(after, id)) {
      const lost = Object.keys(index).filter((key) => key !== id && !Object.prototype.hasOwnProperty.call(after, key))
      if (lost.length === 0) return true
      const merged = { ...after }
      for (const key of lost) merged[key] = index[key]
      try {
        await writeJsonAtomic(indexPath, merged)
        return true
      } catch (error) {
        warnings.push(`Conversation index ${indexPath}: could not restore ${lost.length} concurrent entry/entries (${formatError(error)}).`)
        return false
      }
    }
  }
  warnings.push(`Conversation index ${indexPath}: the entry for ${id} changed concurrently; refresh and retry.`)
  return false
}

async function removeConversationFolder(entry, id, warnings) {
  if (entry.deletable !== true) {
    throw new Error(`refusing to delete a conversation folder that is not safe: ${entry.reason ?? 'unknown reason'}`)
  }
  if (entry.sharedWith !== undefined && entry.sharedWith.length > 0) {
    throw new Error('refusing to delete a conversation folder still used by another Session')
  }
  const folder = resolve(entry.path ?? entry.folder)
  if (!(await isRealDirectory(folder))) {
    throw new Error('refusing to delete a conversation folder that is not a real directory')
  }
  const metadata = await readConversationMetadata(folder)
  if (!isConversationFolderFor(folder, metadata, id, entry.workspace)) {
    throw new Error('refusing to delete a folder whose session.json does not identify this Session')
  }
  if (await hasSymlinkAncestor(folder, entry.workspace)) {
    throw new Error('refusing to delete a conversation folder reached through a symlink or junction')
  }
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const names = entries.map((item) => item.name)
  const splitLayout = names.includes('work') || names.includes('out')
  if (splitLayout && entry.allowUnknown !== true) {
    const unknown = names.filter((name) => !KNOWN_FOLDER_ENTRIES.has(name))
    if (unknown.length > 0) {
      throw new Error(`refusing to delete a conversation folder with unexpected entries: ${unknown.slice(0, 5).join(', ')}`)
    }
  }
  const bytes = await sizeOfDirectory(folder)
  try {
    await rm(folder, { recursive: true, force: false, maxRetries: 3 })
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error
  }
  await removeConversationIndexEntry(entry.indexPath, id, warnings)
  return { removed: true, bytes }
}

async function executeDeletion(ctx, body, tokenRecord) {
  if (tokenRecord === undefined) {
    throw new HttpError(409, 'preview-required', 'Preview the cleanup again before deleting.')
  }
  if (body.confirmed !== true) {
    throw new HttpError(400, 'confirmation-required', 'Confirm the permanent deletion in the preview first.')
  }
  const options = normaliseOptions(body.options)
  const requestedIds = Array.isArray(body.ids) ? [...new Set(body.ids)].sort() : []
  if (JSON.stringify(requestedIds) !== JSON.stringify(tokenRecord.ids) ||
      JSON.stringify(options) !== JSON.stringify(tokenRecord.options)) {
    throw new HttpError(409, 'stale-preview', 'The Session selection or cleanup options changed. Preview again before deleting.')
  }
  const preview = await buildPreview(ctx, body.ids, options)
  if (previewFingerprint(preview) !== tokenRecord.fingerprint) {
    throw new HttpError(409, 'stale-preview', 'The deletion candidates changed. Preview again before deleting.')
  }
  for (const session of preview.sessions) {
    if (isAgentRunning(ctx, session.id)) {
      throw new HttpError(409, 'session-live', `Session ${session.id} is still running; stop it before deleting.`)
    }
    if (isSessionOpen(ctx, session.id)) {
      throw new HttpError(409, 'session-open', `Session ${session.id} is still loaded in this Host process. Close its conversation or restart Harness, then delete.`)
    }
  }
  const selectedIds = new Set(preview.sessions.map((session) => session.id))

  const requestedFiles = Array.isArray(body.files) ? body.files.filter((path) => typeof path === 'string') : []
  const requestedAttachments = Array.isArray(body.attachments) ? body.attachments.filter((id) => typeof id === 'string') : []

  const allowedFiles = new Map()
  for (const file of preview.files) {
    if (file.deletable !== true) continue
    allowedFiles.set(pathKey(file.path), file)
  }
  for (const path of requestedFiles) {
    if (!allowedFiles.has(pathKey(path))) {
      throw new HttpError(409, 'stale-preview', `The preview no longer lists ${path}. Refresh the preview and try again.`)
    }
  }
  const allowedAttachments = new Map()
  for (const attachment of preview.attachments) {
    if (attachment.deletable === true) allowedAttachments.set(attachment.id, attachment)
  }
  for (const id of requestedAttachments) {
    if (!allowedAttachments.has(id)) {
      throw new HttpError(409, 'stale-preview', `Attachment ${id} can no longer be deleted safely. Refresh the preview and try again.`)
    }
  }

  const report = {
    sessions: { requested: selectedIds.size, removed: 0, missing: 0 },
    logs: { removed: 0, bytes: 0 },
    projection: { removed: 0, bytes: 0 },
    conversation: { removed: 0, bytes: 0, skipped: 0 },
    attachments: { removed: 0, bytes: 0, skipped: 0 },
    files: { removed: 0, bytes: 0, skipped: 0 },
    spills: { removed: 0, bytes: 0, skipped: 0 },
    imageCache: { removed: false, bytes: 0 },
    errors: [],
    warnings: [...preview.warnings],
  }

  const workspaces = ctx.workspaceRegistry.list()
  const workspaceBySession = new Map()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }
  const failedSessions = new Set()

  for (const session of preview.sessions) {
    const id = session.id
    const workspace = workspaceBySession.get(id)

    if (isAgentRunning(ctx, id)) {
      failedSessions.add(id)
      report.errors.push({ scope: 'session-live', id, message: 'The Session started running; its files and log were kept.' })
      continue
    }
    if (isSessionOpen(ctx, id)) {
      failedSessions.add(id)
      report.errors.push({ scope: 'session-open', id, message: 'The Session is still loaded; close it or restart Harness, then delete.' })
      continue
    }

    if (options.conversationFolder === true && session.conversationFolder !== null) {
      if (session.conversationFolder.deletable !== true) {
        report.conversation.skipped += 1
        report.warnings.push(`Session ${id}: conversation folder kept because ${session.conversationFolder.reason ?? 'it is not safe to delete'}.`)
      } else {
        try {
          const removal = await removeConversationFolder(session.conversationFolder, id, report.warnings)
          report.conversation.removed += 1
          report.conversation.bytes += removal.bytes
        } catch (error) {
          failedSessions.add(id)
          report.errors.push({ scope: 'conversation-folder', id, message: formatError(error) })
          continue
        }
      }
    }

    const projection = await removeProjectionCache(ctx, id, report.warnings)
    if (projection.removed) {
      report.projection.removed += 1
      report.projection.bytes += projection.bytes
    }

    let logRemoved = false
    if (session.missing === true) {
      report.sessions.missing += 1
      logRemoved = true
    } else {
      if (isAgentRunning(ctx, id)) {
        failedSessions.add(id)
        report.errors.push({ scope: 'session-live', id, message: 'The Session started running before its log deletion; its log was kept.' })
        continue
      }
      if (isSessionOpen(ctx, id)) {
        failedSessions.add(id)
        report.errors.push({ scope: 'session-open', id, message: 'The Session is still loaded before its log deletion; close it or restart Harness.' })
        continue
      }
      try {
        const directory = await resolveSessionDirectory(persistenceRoot(ctx), {
          cwd: session.cwd,
        }, id)
        if (directory === undefined) {
          report.sessions.missing += 1
          logRemoved = true
        } else {
          const removal = await removeSessionDirectory(persistenceRoot(ctx), directory, id)
          if (removal.removed) {
            report.logs.removed += 1
            report.logs.bytes += removal.bytes
            logRemoved = true
          } else {
            report.sessions.missing += 1
            logRemoved = true
          }
        }
      } catch (error) {
        failedSessions.add(id)
        report.errors.push({ scope: 'session-log', id, message: formatError(error) })
        continue
      }
    }

    if (!logRemoved) continue
    report.sessions.removed += 1

    /* Registry state is changed only after the filesystem work succeeds. This
       keeps a failed deletion archived at its original workspace position and
       avoids exposing the Session to the UI while its log is being removed. */
    let detached = workspace === undefined
    if (workspace !== undefined) {
      try {
        await workspace.detachSession(id)
        detached = true
      } catch (error) {
        report.errors.push({ scope: 'workspace', id, message: formatError(error) })
      }
    }
    if (!detached) {
      report.warnings.push(`Session ${id}: its files were removed, but it remains archived because detaching from its workspace failed.`)
      continue
    }
    try {
      await ctx.workspaceRegistry.unarchiveSession(id)
    } catch (error) {
      report.errors.push({ scope: 'unarchive', id, message: formatError(error) })
      continue
    }
    try {
      await ctx.workspaceRegistry.unpinSession(id)
    } catch (error) {
      report.errors.push({ scope: 'unpin', id, message: formatError(error) })
    }
    factCache.delete(id)
  }

  let protectedAttachments = null
  let protectedFiles = null
  let protectedSpills = null
  if (failedSessions.size > 0) {
    protectedAttachments = new Set()
    protectedFiles = new Set()
    protectedSpills = new Set(failedSessions)
    for (const file of preview.files) {
      if (Array.isArray(file.sessionIds) && file.sessionIds.some((id) => failedSessions.has(id))) {
        protectedFiles.add(pathKey(file.path))
      }
    }
    try {
      const snapshots = await ctx.sessionPersistence.list()
      const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
      for (const id of failedSessions) {
        const snapshot = snapshotById.get(id)
        if (snapshot === undefined) continue
        const facts = await factsFor(ctx, id, snapshot.revision, snapshot.header.cwd)
        if (facts.truncated === true) throw new Error('surviving Session log exceeds the event limit')
        for (const attachmentId of facts.attachments.keys()) protectedAttachments.add(attachmentId)
        for (const file of facts.files.values()) protectedFiles.add(pathKey(file.path))
      }
    } catch (error) {
      protectedAttachments = 'all'
      protectedFiles = 'all'
      protectedSpills = 'all'
      report.warnings.push(`A surviving Session could not be inspected after its log deletion failed (${formatError(error)}); every attachment, spill directory, and workspace file was kept.`)
    }
    report.warnings.push(
      `${failedSessions.size} Session log(s) could not be deleted. Artifacts still referenced by those Sessions were kept; artifacts belonging only to the removed Sessions were cleaned.`,
    )
  }

  const blocks = (set, key) => set === 'all' || (set !== null && set.has(key))

  for (const spill of preview.spills || []) {
    if (blocks(protectedSpills, spill.id)) {
      report.spills.skipped += 1
      continue
    }
    try {
      const removal = await removeSpillDirectory(ctx, spill)
      if (removal.removed) {
        report.spills.removed += 1
        report.spills.bytes += removal.bytes
      } else {
        report.spills.skipped += 1
      }
    } catch (error) {
      report.errors.push({ scope: 'spill', id: spill.directory, message: formatError(error) })
    }
  }

  for (const attachmentId of requestedAttachments) {
    if (blocks(protectedAttachments, attachmentId)) {
      report.attachments.skipped += 1
      continue
    }
    const attachment = allowedAttachments.get(attachmentId)
    if (attachment === undefined) continue
    try {
      const removal = await removeAttachment(ctx, attachment)
      if (removal.removed) {
        report.attachments.removed += 1
        report.attachments.bytes += removal.bytes
      } else {
        report.attachments.skipped += 1
      }
    } catch (error) {
      report.errors.push({ scope: 'attachment', id: attachmentId, message: formatError(error) })
    }
  }

  for (const path of requestedFiles) {
    if (blocks(protectedFiles, pathKey(path))) {
      report.files.skipped += 1
      continue
    }
    const candidate = allowedFiles.get(pathKey(path))
    if (candidate === undefined) continue
    try {
      const removal = await removeFileCandidate(candidate, report.warnings)
      if (removal.removed) {
        report.files.removed += 1
        report.files.bytes += removal.bytes
      } else {
        report.files.skipped += 1
      }
    } catch (error) {
      report.errors.push({ scope: 'file', id: path, message: formatError(error) })
    }
  }

  if (options.imageCache === true) {
    try {
      const cleared = await clearImageCache()
      report.imageCache = cleared
    } catch (error) {
      report.errors.push({ scope: 'image-cache', id: 'request-images', message: formatError(error) })
    }
  }

  /* The full-text search index is derived from Session logs. Trigger one
     reconciliation in the background; a deployment without search simply
     rejects it, and a slow reindex never delays the deletion response. */
  if (report.sessions.removed > 0 && typeof ctx.sessionQuery.searchSessions === 'function') {
    Promise.resolve()
      .then(() => ctx.sessionQuery.searchSessions({ query: 'session-cleaner', limit: 1 }))
      .catch(() => {})
  }

  previewTokens.delete(body.previewToken)
  return report
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

export function apply(ctx) {
  const handler = async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST.' } })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: 'Send application/json.' } })
      return
    }
    try {
      const body = await readJsonBody(req)
      if (body === null || typeof body !== 'object') {
        throw new HttpError(400, 'invalid-body', 'Request body must be a JSON object.')
      }
      const op = typeof body.op === 'string' ? body.op : ''
      if (op === 'list') {
        sendJson(res, 200, { ok: true, value: await listArchived(ctx) })
        return
      }
      if (op === 'project-path') {
        sendJson(res, 200, { ok: true, value: await resolveProjectPath(ctx, body.sessionId) })
        return
      }
      if (op === 'preview') {
        const options = normaliseOptions(body.options)
        const preview = await buildPreview(ctx, body.ids, options)
        const previewToken = rememberPreview(body.ids, options, preview)
        sendJson(res, 200, {
          ok: true,
          value: { ...preview, previewToken },
        })
        return
      }
      if (op === 'delete') {
        const tokenRecord = getPreviewToken(body.previewToken)
        sendJson(res, 200, { ok: true, value: await executeDeletion(ctx, body, tokenRecord) })
        return
      }
      sendJson(res, 400, { ok: false, error: { code: 'unknown-op', message: 'Unknown operation.' } })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'internal-error'
      sendJson(res, status, {
        ok: false,
        error: { code, message: formatError(error) },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler,
  }), `session-cleaner: POST ${ROUTE_PATH}`)
}

