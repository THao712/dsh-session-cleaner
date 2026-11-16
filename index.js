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
const MAX_FOLDER_SCAN_ENTRIES = 200000
const FILE_END_TOLERANCE_MS = 300000
const CONVERSATION_BASE = 'conversations'
const CONVERSATION_METADATA = 'session.json'
const CONVERSATION_INDEX = 'index.json'
const CONVERSATION_RULES = 'AGENTS.md'
const PENDING_FILE = 'session-cleaner-pending.json'
const JOURNAL_FILE = 'session-cleaner-journal.json'
const JOURNAL_VERSION = 1
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

async function lstatResult(path) {
  try {
    return { info: await lstat(path) }
  } catch (error) {
    return { error }
  }
}

function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
}

function describeFsError(error) {
  const code = errorCode(error)
  if (code === 'ENOENT') return 'not found'
  if (code === 'EACCES' || code === 'EPERM') return `permission denied (${code})`
  return `${formatError(error)} (${code})`
}

async function isRealDirectory(path) {
  const info = await lstatSafe(path)
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink()
}

async function sizeOfFile(path) {
  const info = await lstatSafe(path)
  return info !== undefined && info.isFile() ? info.size : 0
}

async function scanDirectorySize(path, budget = 200000) {
  let total = 0
  let seen = 0
  let complete = true
  let truncated = false
  const errors = []
  const stack = [path]
  while (stack.length > 0 && seen < budget) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      complete = false
      errors.push(`${current}: ${describeFsError(error)}`)
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > budget) {
        complete = false
        truncated = true
        break
      }
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size
        } catch (error) {
          complete = false
          errors.push(`${child}: ${describeFsError(error)}`)
        }
      }
    }
  }
  if (stack.length > 0 && seen >= budget) {
    complete = false
    truncated = true
  }
  return { bytes: total, entries: seen, complete, truncated, errors }
}

async function sizeOfDirectory(path, budget = 200000) {
  return (await scanDirectorySize(path, budget)).bytes
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

async function readJsonFileDetailed(path) {
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { missing: true }
    return { error }
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
  if (typeof entry.bytes === 'number' && bytes !== entry.bytes) {
    return { removed: false, bytes: 0, reason: 'changed' }
  }
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
      revision: snapshot?.revision,
      parentSession: snapshot?.header.parentSession,
      cwdHistory: typeof snapshot?.header.cwd === 'string' ? [resolve(snapshot.header.cwd)] : [],
      filePaths: [],
      live: running,
      open: sessionOpen,
      missing: snapshot === undefined,
      workspace: workspace === undefined ? null : { title: workspace.title, path: workspace.path },
      conversationFolder: null,
      logDir: undefined,
      logFiles: [],
      logBytes: 0,
      logSizeComplete: false,
      logManifestHash: null,
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
      const logStats = await scanFolder(directory)
      base.logBytes = logStats.totalBytes
      base.logSizeComplete = logStats.complete
      base.logManifestHash = logStats.manifestHash
      sessionBytes += base.logBytes
      if (logStats.complete !== true) {
        warnings.push(`Session ${id}: the log size is a lower bound because ${logStats.errors[0] ?? 'the directory scan was incomplete'}.`)
      }
    } else {
      warnings.push(`Session ${id}: its stored log directory was not found. Only the archive entry and checkpoint can be removed.`)
    }

    let facts
    try {
      facts = await factsFor(ctx, id, snapshot.revision, snapshot.header.cwd)
      base.lastEventTime = facts.lastEventTime || base.createdAt
      base.cwdHistory = facts.cwdHistory
      base.filePaths = [...facts.files.values()].map((file) => file.path)
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
      const stats = await scanFolder(conversation.folder)
      const splitLayout = stats.hasWork || stats.hasOut
      const unknownEntries = splitLayout ? stats.unknownEntries : []
      base.conversationFolder = {
        path: conversation.folder,
        workspace: conversation.workspace,
        base: conversation.base,
        indexPath: conversation.indexPath,
        bytes: stats.totalBytes,
        entries: stats.names.slice(0, 50),
        entryCount: stats.names.length,
        unknownEntries: unknownEntries.slice(0, 50),
        unknownCount: unknownEntries.length,
        layout: splitLayout ? 'split' : 'flat',
        allowUnknown: options.allowUnknownFolderEntries === true,
        sharedWith: [],
        sharedReasons: [],
        users: [],
        referencesUnknown: false,
        deletable: false,
        selected: false,
        reason: undefined,
        reasonCode: undefined,
        manifestHash: stats.manifestHash,
        manifestEntries: stats.manifestEntries,
        scanComplete: stats.complete,
        scanErrors: stats.errors,
        workManifestHash: stats.workManifestHash,
        outManifestHash: stats.outManifestHash,
        agentsSignature: stats.agentsSignature,
      }
    }
    sessions.push(base)
  }

  if (sessions.some((session) => session.open === true && session.live !== true)) {
    warnings.push('Some selected Sessions are still loaded by Harness. Their files are deleted now; their workspace and archive records are finalized on the next Harness start, without creating “未分组” ghosts.')
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
  const selectedIdSet = new Set(unique)
  for (const session of sessions) {
    const folder = session.conversationFolder
    if (folder === null) continue
    const users = collectFolderUsers(folder.path, session.id, {
      folders: folderIndex,
      paths: pathIndex,
      children: childrenByParent,
    })
    addSelectedSessionFolderUsers(users, folder.path, session, sessions)
    const summary = summariseFolderUsers(users, selectedIdSet)
    const keepOutSummary = summariseKeepOutUsers(users, selectedIdSet)
    folder.users = [...users.keys()].sort()
    folder.sharedWith = summary.sharedWith
    folder.sharedReasons = summary.sharedReasons
    folder.keepOutSharedWith = keepOutSummary.sharedWith
    folder.keepOutSharedReasons = keepOutSummary.sharedReasons
    folder.referencesUnknown = remainingUnreadable || unreadable.size > 0
    const unknownBlocked = folder.unknownCount > 0 && folder.allowUnknown !== true
    folder.deletable = folder.scanComplete === true &&
      folder.sharedWith.length === 0 &&
      !folder.referencesUnknown &&
      !unknownBlocked
    folder.keepOutDeletable = folder.scanComplete === true &&
      folder.keepOutSharedWith.length === 0 &&
      !folder.referencesUnknown
    if (folder.scanComplete !== true) {
      folder.reasonCode = 'scan-incomplete'
      folder.reason = `The folder could not be fully scanned${folder.scanErrors.length > 0 ? `: ${folder.scanErrors[0]}` : ''}; whole-folder deletion is blocked.`
    } else if (folder.sharedWith.length > 0) {
      folder.reasonCode = 'shared'
      folder.reason = `Still used by ${folder.sharedWith.length} other Session(s).${folderUsageText(folder.sharedReasons)}`
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
      candidate.origins.some((origin) => origin === 'write' || origin === 'str_replace_editor')
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
    timeEvidence: 'unknown',
    identity: null,
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

  const start = Math.max(0, session.createdAt)
  const end = Math.max(session.lastEventTime, session.createdAt) + FILE_END_TOLERANCE_MS
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
        const existing = folders.get(key)
        if (existing === undefined) folders.set(key, { path: cwd, users: new Set([current.header.id]) })
        else existing.users.add(current.header.id)
      }
    }
  })
  await Promise.all(workers)
  return { attachments, paths, folders, children, unreadable }
}

function isWithin(path, root) {
  return samePath(path, root) || isInside(path, root)
}

function addFolderUser(users, id, reason) {
  const reasons = users.get(id)
  if (reasons === undefined) users.set(id, new Set([reason]))
  else reasons.add(reason)
}

/**
 * Every remaining Session that still depends on `folder`, whether through its
 * cwd (the folder itself or a descendant), an explicit file path inside it, or
 * a parent/child Session relationship. Both cleanup entries call this helper so
 * their safety conclusion cannot drift apart.
 */
function collectFolderUsers(folder, ownerId, indexed) {
  const users = new Map()
  for (const entry of indexed.folders.values()) {
    if (!isWithin(entry.path, folder)) continue
    const reason = samePath(entry.path, folder) ? 'cwd' : 'nested-cwd'
    for (const id of entry.users) addFolderUser(users, id, reason)
  }
  for (const [filePath, sessionIds] of indexed.paths) {
    if (!isInside(filePath, folder)) continue
    const reason = isInside(filePath, join(folder, 'work'))
      ? 'work-file'
      : isInside(filePath, join(folder, 'out'))
        ? 'out-file'
        : 'file'
    for (const id of sessionIds) addFolderUser(users, id, reason)
  }
  for (const childId of indexed.children.get(ownerId) ?? []) {
    addFolderUser(users, childId, 'child')
  }
  users.delete(ownerId)
  return users
}

function addSelectedSessionFolderUsers(users, folder, owner, sessions) {
  for (const session of sessions) {
    if (session.id === owner.id) continue
    for (const cwd of session.cwdHistory ?? []) {
      if (isWithin(cwd, folder)) addFolderUser(users, session.id, samePath(cwd, folder) ? 'cwd' : 'nested-cwd')
    }
    for (const filePath of session.filePaths ?? []) {
      if (isInside(filePath, folder)) addFolderUser(users, session.id, 'file')
    }
    if (session.parentSession === owner.id) addFolderUser(users, session.id, 'child')
  }
}

function summariseFolderUsers(users, excludedIds) {
  const sharedWith = []
  const sharedReasons = []
  for (const id of [...users.keys()].sort()) {
    if (excludedIds.has(id)) continue
    sharedWith.push(id)
    sharedReasons.push({ id, reasons: [...users.get(id)].sort() })
  }
  return { sharedWith, sharedReasons }
}

/**
 * `keepOut` leaves out/ intact, so a Session that only references an out/
 * deliverable must not block deleting work/ and AGENTS.md.
 */
function summariseKeepOutUsers(users, excludedIds) {
  const filtered = new Map()
  for (const [id, reasons] of users) {
    if (excludedIds.has(id)) continue
    if ([...reasons].every((reason) => reason === 'out-file')) continue
    filtered.set(id, reasons)
  }
  return summariseFolderUsers(filtered, new Set())
}

function folderUsageText(sharedReasons) {
  if (sharedReasons.length === 0) return ''
  const detail = sharedReasons.map((entry) => `${entry.id} (${entry.reasons.join(', ')})`).join('; ')
  return ` Still used by: ${detail}.`
}

async function enrichFileCandidates(fileMap, sessionInfo) {
  for (const candidate of fileMap.values()) {
    const result = await lstatResult(candidate.path)
    const info = result.info
    if (info === undefined) {
      const missing = errorCode(result.error) === 'ENOENT'
      candidate.exists = false
      candidate.sizeBytes = 0
      candidate.protected = true
      candidate.reason = missing ? 'missing' : `cannot inspect: ${describeFsError(result.error)}`
      candidate.reasonCode = missing ? 'missing' : 'stat-failed'
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
    const windows = sessionIds
      .map((id) => sessionInfo.get(id))
      .filter((session) => session !== undefined && session.createdAt > 0)
      .map((session) => ({
        start: session.createdAt,
        end: Math.max(session.lastEventTime ?? 0, session.createdAt) + FILE_END_TOLERANCE_MS,
      }))
    const born = info.birthtimeMs
    let timeEvidence = 'unknown'
    let createdDuring = false
    if (Number.isFinite(born) && born > 0 && windows.length > 0) {
      if (windows.some((window) => born >= window.start && born <= window.end)) {
        timeEvidence = 'created-during'
        createdDuring = true
      } else if (born < Math.min(...windows.map((window) => window.start))) {
        timeEvidence = 'before-session'
      } else if (born > Math.max(...windows.map((window) => window.end))) {
        timeEvidence = 'after-session'
      } else {
        timeEvidence = 'outside-session'
      }
    }
    candidate.createdDuring = createdDuring
    candidate.timeEvidence = timeEvidence
    candidate.identity = {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      birthtimeMs: info.birthtimeMs,
    }

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

async function removeProjectionCache(ctx, id, warnings, expectedBytes) {
  const path = projectionCachePath(id)
  if (await hasSymlinkAncestor(path, join(homeDirectory(), 'storages'))) {
    warnings.push(`Projection checkpoint ${id}: path crosses a symlink or junction; kept.`)
    return { removed: false, bytes: 0, path }
  }
  const bytes = await sizeOfFile(path)
  if (typeof expectedBytes === 'number' && bytes !== expectedBytes) {
    return { removed: false, bytes: 0, path, reason: 'changed' }
  }
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

async function removeSessionDirectory(root, directory, id, expectedManifestHash) {
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
  const stats = await scanFolder(directory)
  if (stats.complete !== true) {
    throw new Error(`refusing to delete a Session directory that changed or could not be fully scanned: ${stats.errors[0] ?? 'unknown scan error'}`)
  }
  if (typeof expectedManifestHash === 'string' && stats.manifestHash !== expectedManifestHash) {
    throw new Error('the Session log changed after preview; preview again before deleting')
  }
  const bytes = stats.totalBytes
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

function sameFileIdentity(info, expected) {
  if (expected === null || typeof expected !== 'object') return true
  const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs']
  return fields.every((field) => {
    const actual = info[field]
    const wanted = expected[field]
    if (typeof wanted !== 'number') return true
    return typeof actual === 'number' && Math.abs(actual - wanted) < 0.5
  })
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
  if (!sameFileIdentity(info, candidate.identity)) {
    return { removed: false, bytes: 0, reason: 'changed' }
  }
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
      session.revision ?? null,
      session.logManifestHash ?? null,
      session.logBytes ?? 0,
      session.projectionCache?.exists === true,
      session.projectionCache?.bytes ?? 0,
      session.conversationFolder?.path ?? null,
      session.conversationFolder?.deletable === true,
      session.conversationFolder?.sharedWith?.length ?? 0,
      (session.conversationFolder?.sharedReasons || [])
        .map((entry) => [entry.id, [...entry.reasons].sort()]),
      session.conversationFolder?.unknownCount ?? 0,
      session.conversationFolder?.manifestHash ?? null,
      session.conversationFolder?.scanComplete === true,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const files = (preview.files || [])
    .map((file) => [
      file.path,
      file.deletable === true,
      file.exists === true,
      file.selectedByDefault === true,
      file.sizeBytes ?? 0,
      file.timeEvidence ?? null,
      file.identity?.dev ?? null,
      file.identity?.ino ?? null,
      file.identity?.mtimeMs ?? null,
      file.identity?.ctimeMs ?? null,
      file.identity?.birthtimeMs ?? null,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const attachments = (preview.attachments || [])
    .map((attachment) => [attachment.id, attachment.deletable === true, attachment.bytes ?? 0])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const spills = (preview.spills || [])
    .map((spill) => [spill.directory, spill.bytes ?? 0])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
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
    state: 'ready',
    started: false,
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

function claimRecord(record, kind) {
  if (record === undefined) return undefined
  if (record.state === 'running') {
    throw new HttpError(409, `${kind}-in-use`, 'This preview is already being executed.')
  }
  if (record.state === 'completed') {
    throw new HttpError(409, `${kind}-consumed`, 'This preview was already executed. Preview again before deleting.')
  }
  record.state = 'running'
  record.started = false
  return record
}

function releaseRecord(record) {
  if (record !== undefined && record.started !== true) record.state = 'ready'
}

function completeRecord(record) {
  if (record === undefined) return
  record.state = 'completed'
  record.completedAt = Date.now()
}

function claimPreviewToken(token) {
  return claimRecord(getPreviewToken(token), 'preview')
}

function claimFolderPreviewToken(token) {
  return claimRecord(getFolderPreviewToken(token), 'folder-preview')
}

let deletionQueue = Promise.resolve()

function withDeletionLock(task) {
  const run = deletionQueue.then(() => task(), () => task())
  deletionQueue = run.then(() => undefined, () => undefined)
  return run
}

const folderPreviewTokens = new Map()

function folderRowFingerprint(folder) {
  return JSON.stringify([
    folder.key,
    folder.totalBytes,
    folder.workBytes,
    folder.outBytes,
    folder.modifiedAt,
    folder.sessionId ?? null,
    folder.open === true,
    folder.running === true,
    folder.state,
    folder.archived === true,
    folder.logExists === true,
    folder.metadataState,
    folder.unknownCount,
    folder.manifestHash ?? null,
    folder.workManifestHash ?? null,
    folder.outManifestHash ?? null,
    folder.manifestEntries ?? 0,
    folder.agentsSignature ?? null,
    folder.scanComplete === true,
    (folder.sharedWith || []).slice().sort(),
    (folder.sharedReasons || [])
      .map((entry) => [entry.id, [...entry.reasons].sort()])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
}

function folderRowKeepOutFingerprint(folder) {
  return JSON.stringify([
    folder.key,
    folder.hasWork === true,
    folder.workBytes,
    folder.sessionId ?? null,
    folder.open === true,
    folder.running === true,
    folder.state,
    folder.archived === true,
    folder.logExists === true,
    folder.metadataState,
    folder.unknownCount,
    folder.workManifestHash ?? null,
    folder.agentsSignature ?? null,
    folder.scanComplete === true,
    (folder.keepOutSharedWith || []).slice().sort(),
    (folder.keepOutSharedReasons || [])
      .map((entry) => [entry.id, [...entry.reasons].sort()])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
}

function folderPreviewFingerprint(folders) {
  return new Map((folders || []).map((folder) => [folder.key, {
    all: folderRowFingerprint(folder),
    keepOut: folderRowKeepOutFingerprint(folder),
  }]))
}

function pruneFolderPreviewTokens() {
  const now = Date.now()
  for (const [token, record] of folderPreviewTokens) {
    if (record.expiresAt <= now) folderPreviewTokens.delete(token)
  }
  while (folderPreviewTokens.size > MAX_PREVIEW_TOKENS) {
    const oldest = folderPreviewTokens.keys().next().value
    if (oldest === undefined) break
    folderPreviewTokens.delete(oldest)
  }
}

function rememberFolderPreview(folders) {
  pruneFolderPreviewTokens()
  const token = randomBytes(24).toString('base64url')
  folderPreviewTokens.set(token, {
    fingerprints: folderPreviewFingerprint(folders),
    expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS,
    state: 'ready',
    started: false,
  })
  pruneFolderPreviewTokens()
  return token
}

function getFolderPreviewToken(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const record = folderPreviewTokens.get(token)
  if (record === undefined) return undefined
  if (record.expiresAt <= Date.now()) {
    folderPreviewTokens.delete(token)
    return undefined
  }
  return record
}

function pendingPath() {
  return join(homeDirectory(), PENDING_FILE)
}

async function readPendingIds() {
  const result = await readJsonFileDetailed(pendingPath())
  if (result.missing === true) return []
  if (result.error !== undefined) {
    throw new Error(`cannot read ${pendingPath()}: ${describeFsError(result.error)}`)
  }
  const value = result.value
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id) => typeof id === 'string' && isSafeSessionId(id)))]
}

async function writePendingIds(ids) {
  const path = pendingPath()
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && isSafeSessionId(id)))]
  if (unique.length === 0) {
    try {
      await unlink(path)
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
    }
    return
  }
  await writeJsonAtomic(path, unique)
}

async function addPendingId(id) {
  return withPendingLock(async () => {
    const pending = await readPendingIds()
    if (!pending.includes(id)) pending.push(id)
    await writePendingIds(pending)
  })
}

let pendingQueue = Promise.resolve()

function withPendingLock(task) {
  const run = pendingQueue.then(() => task(), () => task())
  pendingQueue = run.then(() => undefined, () => undefined)
  return run
}

function journalPath() {
  return join(homeDirectory(), JOURNAL_FILE)
}

async function readJournalRecord() {
  const result = await readJsonFileDetailed(journalPath())
  if (result.missing === true) return undefined
  if (result.error !== undefined) {
    throw new Error(`cannot read ${journalPath()}: ${describeFsError(result.error)}`)
  }
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: JOURNAL_VERSION, status: 'invalid', phase: 'unknown', updatedAt: 0 }
  }
  return value
}

let journalQueue = Promise.resolve()

function withJournalLock(task) {
  const run = journalQueue.then(() => task(), () => task())
  journalQueue = run.then(() => undefined, () => undefined)
  return run
}

async function persistJournal(record) {
  record.updatedAt = Date.now()
  return withJournalLock(() => writeJsonAtomic(journalPath(), record))
}

async function markInterruptedJournal(ctx) {
  return withJournalLock(async () => {
    const record = await readJournalRecord()
    if (record === undefined || record.status !== 'running') return
    record.status = 'interrupted'
    record.interruptedAt = Date.now()
    record.updatedAt = record.interruptedAt
    await writeJsonAtomic(journalPath(), record)
    ctx.logger?.warn?.(`session-cleaner: previous cleanup task ${record.id ?? 'unknown'} was interrupted; its journal is available for inspection.`)
  })
}

/**
 * If a process died after a log was removed but before its workspace/archive
 * bookkeeping was written, the journal can still name that Session. Recover
 * only the bookkeeping; it never deletes files or artifacts from a journal.
 * A log that exists again is treated as a new/restored Session and is skipped.
 */
async function recoverJournalBookkeeping(ctx) {
  let record
  try {
    record = await readJournalRecord()
  } catch (error) {
    ctx.logger?.warn?.(`session-cleaner: cannot inspect interrupted journal: ${formatError(error)}`)
    return
  }
  if (record === undefined || record.status !== 'interrupted' || !Array.isArray(record.completedSessions)) return
  let snapshots
  try {
    snapshots = await ctx.sessionPersistence.list()
  } catch (error) {
    ctx.logger?.warn?.(`session-cleaner: cannot recover journal bookkeeping because Session logs are unreadable: ${formatError(error)}`)
    return
  }
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
  const registry = ctx.workspaceRegistry
  const archived = new Set(registry.archivedSessionIds)
  let pending
  try {
    pending = new Set(await readPendingIds())
  } catch (error) {
    ctx.logger?.warn?.(`session-cleaner: cannot recover journal bookkeeping because pending state is unreadable: ${formatError(error)}`)
    return
  }
  const root = persistenceRoot(ctx)
  for (const id of record.completedSessions) {
    if (!isSafeSessionId(id) || !archived.has(id) || pending.has(id)) continue
    if (isSessionOpen(ctx, id) || isAgentRunning(ctx, id)) {
      try {
        await addPendingId(id)
        pending.add(id)
      } catch (error) {
        ctx.logger?.warn?.(`session-cleaner: cannot queue recovered Session ${id}: ${formatError(error)}`)
      }
      continue
    }
    const snapshot = snapshotById.get(id)
    if (snapshot !== undefined) {
      try {
        const directory = await resolveSessionDirectory(root, snapshot.header, id)
        if (directory !== undefined) continue
      } catch {
        continue
      }
    }
    try {
      const workspace = registry.list().find((item) => item.sessionIds.includes(id))
      if (workspace !== undefined) await workspace.detachSession(id)
      await registry.unarchiveSession(id)
      await registry.unpinSession(id)
      ctx.logger?.warn?.(`session-cleaner: recovered deferred bookkeeping for Session ${id}.`)
    } catch (error) {
      ctx.logger?.warn?.(`session-cleaner: could not recover bookkeeping for Session ${id}: ${formatError(error)}`)
      try {
        await addPendingId(id)
      } catch {
        /* the next startup will retry the journal record */
      }
    }
  }
}

/**
 * An archived Session that is still resident in `ctx.sessions` cannot have its
 * workspace slot and archive marker dropped immediately: the sidebar lists the
 * live Session and would show it under "未分组". Its files can be deleted right
 * away; the bookkeeping waits for a Host process that no longer owns the
 * Session. A plugin reload while the old process is still alive therefore
 * leaves the entry pending.
 */
async function finalizePending(ctx) {
  return withPendingLock(() => finalizePendingUnlocked(ctx))
}

async function finalizePendingUnlocked(ctx) {
  const pending = await readPendingIds()
  if (pending.length === 0) return
  const registry = ctx.workspaceRegistry
  const workspaces = registry.list()
  const remaining = []
  for (const id of pending) {
    if (isSessionOpen(ctx, id) || isAgentRunning(ctx, id)) {
      remaining.push(id)
      continue
    }
    try {
      const workspace = workspaces.find((item) => item.sessionIds.includes(id))
      if (workspace !== undefined) await workspace.detachSession(id)
      await registry.unarchiveSession(id)
      await registry.unpinSession(id)
    } catch (error) {
      remaining.push(id)
      ctx.logger?.warn?.(`session-cleaner: could not finalize pending Session ${id}: ${formatError(error)}`)
    }
  }
  if (remaining.length !== pending.length) await writePendingIds(remaining)
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
  const pending = new Set(await readPendingIds())
  const archivedIds = [...registry.archivedSessionIds]
    .filter(isSafeSessionId)
    .filter((id) => !pending.has(id))
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

/**
 * Walk one conversation folder once and produce both its accounting and a
 * manifest digest. The digest covers relative name, entry type, size, mtime and
 * ctime, so a preview cannot silently bless files added or replaced later.
 * A budget exhaustion is reported instead of presenting a partial total as
 * exact.
 */
async function scanFolder(folder) {
  const root = resolve(folder)
  const hashes = {
    all: createHash('sha256'),
    work: createHash('sha256'),
    out: createHash('sha256'),
  }
  let totalBytes = 0
  let workBytes = 0
  let outBytes = 0
  let entriesScanned = 0
  let modifiedAt = 0
  let complete = true
  let truncated = false
  const errors = []
  let topEntries
  try {
    topEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return {
      names: [],
      hasWork: false,
      hasOut: false,
      workBytes: 0,
      outBytes: 0,
      totalBytes: 0,
      unknownEntries: [],
      modifiedAt: 0,
      manifestHash: null,
      workManifestHash: null,
      outManifestHash: null,
      manifestEntries: 0,
      complete: false,
      truncated: false,
      errors: [`folder: ${describeFsError(error)}`],
      agentsSignature: null,
    }
  }
  topEntries.sort((left, right) => left.name.localeCompare(right.name))
  const names = topEntries.map((entry) => entry.name)
  const hasWork = topEntries.some((entry) => entry.name === 'work' && entry.isDirectory() && !entry.isSymbolicLink())
  const hasOut = topEntries.some((entry) => entry.name === 'out' && entry.isDirectory() && !entry.isSymbolicLink())
  let agentsSignature = null

  const visit = async (directory, relativeBase, bucket) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      complete = false
      errors.push(`${relativeBase || '.'}: ${describeFsError(error)}`)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entriesScanned >= MAX_FOLDER_SCAN_ENTRIES) {
        complete = false
        truncated = true
        return
      }
      const child = join(directory, entry.name)
      const relativeName = relativeBase.length > 0 ? `${relativeBase}/${entry.name}` : entry.name
      const result = await lstatResult(child)
      if (result.info === undefined) {
        complete = false
        errors.push(`${relativeName}: ${describeFsError(result.error)}`)
        continue
      }
      const info = result.info
      entriesScanned += 1
      const kind = info.isSymbolicLink()
        ? 'link'
        : info.isDirectory()
          ? 'dir'
          : info.isFile()
            ? 'file'
            : 'other'
      const line = `${relativeName}\0${kind}\0${info.size}\0${Math.round(info.mtimeMs)}\0${Math.round(info.ctimeMs)}\n`
      const hashedBucket = bucket ?? (relativeName === 'work' ? 'work' : relativeName === 'out' ? 'out' : null)
      hashes.all.update(line)
      if (hashedBucket === 'work') hashes.work.update(line)
      if (hashedBucket === 'out') hashes.out.update(line)
      if (Number.isFinite(info.mtimeMs) && info.mtimeMs > modifiedAt) modifiedAt = info.mtimeMs
      if (relativeName === CONVERSATION_RULES && info.isFile()) {
        agentsSignature = `${info.size}:${Math.round(info.mtimeMs)}:${Math.round(info.ctimeMs)}`
      }
      if (kind === 'dir') {
        await visit(child, relativeName, hashedBucket)
      } else if (kind === 'file') {
        totalBytes += info.size
        if (bucket === 'work') workBytes += info.size
        if (bucket === 'out') outBytes += info.size
      }
    }
  }

  await visit(root, '', null)
  const unknownEntries = names.filter((name) => !KNOWN_FOLDER_ENTRIES.has(name))
  return {
    names,
    hasWork,
    hasOut,
    workBytes,
    outBytes,
    totalBytes,
    unknownEntries,
    modifiedAt,
    manifestHash: complete ? hashes.all.digest('hex') : null,
    workManifestHash: complete ? hashes.work.digest('hex') : null,
    outManifestHash: complete ? hashes.out.digest('hex') : null,
    manifestEntries: entriesScanned,
    complete,
    truncated,
    errors,
    agentsSignature,
  }
}

/**
 * List every conversation folder under each registered workspace. This is a
 * separate surface from the archive list: a folder can outlive its Session log
 * (orphan), or belong to a Session that is not archived. It is read-only; the
 * browser only sends the Host-derived key back for deletion.
 */
async function listConversationFolders(ctx) {
  const registry = ctx.workspaceRegistry
  const archived = new Set(registry.archivedSessionIds)
  const snapshots = await ctx.sessionPersistence.list()
  const logIds = new Set(snapshots.map((snapshot) => snapshot.header.id))
  const scanWarnings = []
  const indexed = await indexRemainingSessions(ctx, snapshots, scanWarnings)
  const rows = []
  for (const workspace of registry.list()) {
    const base = join(workspace.path, CONVERSATION_BASE)
    if (!(await isRealDirectory(base))) continue
    const indexPath = join(base, CONVERSATION_INDEX)
    const index = await readJsonFile(indexPath, undefined)
    const indexEntries = index !== null && typeof index === 'object' && !Array.isArray(index) ? index : {}
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '_unfiled' || entry.name.startsWith('.')) continue
      if (!safeConversationName(entry.name)) continue
      const folder = join(base, entry.name)
      if (!(await isRealDirectory(folder))) continue
      const metadata = await readConversationMetadata(folder)
      const owner = Object.entries(indexEntries).find(([, value]) => {
        if (value === null || typeof value !== 'object') return false
        if (typeof value.folder !== 'string') return false
        return value.folder === entry.name || samePath(isAbsolute(value.folder) ? value.folder : join(base, value.folder), folder)
      })
      const sessionId = typeof metadata?.sessionId === 'string'
        ? metadata.sessionId
        : (owner === undefined ? undefined : owner[0])
      const metadataState = metadata === undefined
        ? 'missing'
        : (isConversationFolderFor(folder, metadata, sessionId, workspace.path) ? 'valid' : 'invalid')
      const open = sessionId === undefined ? false : isSessionOpen(ctx, sessionId)
      const running = sessionId === undefined ? false : isAgentRunning(ctx, sessionId)
      const stats = await scanFolder(folder)
      const symlink = await hasSymlinkAncestor(folder, workspace.path)
      const users = collectFolderUsers(folder, sessionId, indexed)
      const summary = summariseFolderUsers(users, new Set())
      const keepOutSummary = summariseKeepOutUsers(users, new Set())
      const sharedWith = summary.sharedWith
      const referencesUnknown = indexed.unreadable
      const allDeletable = !running && !symlink && metadataState !== 'invalid' &&
        stats.complete === true && sharedWith.length === 0 && !referencesUnknown
      const keepOutDeletable = !running && !symlink &&
        stats.complete === true && keepOutSummary.sharedWith.length === 0 && !referencesUnknown
      let state = 'unarchived'
      if (running) state = 'running'
      else if (open) state = 'open'
      else if (metadataState === 'missing' || sessionId === undefined) state = 'orphan'
      else if (!logIds.has(sessionId)) state = 'log-missing'
      else if (archived.has(sessionId)) state = 'archived'
      let reason
      if (running) reason = 'The Session is running; stop it first.'
      else if (symlink) reason = 'The folder is reached through a symlink or junction.'
      else if (referencesUnknown) reason = 'A Session log could not be read, so folder sharing cannot be proven safe.'
      else if (stats.complete !== true) {
        reason = `The folder could not be fully scanned${stats.errors.length > 0 ? `: ${stats.errors[0]}` : ''}; cleanup is blocked.`
      } else if (sharedWith.length > 0) {
        reason = `Still used by ${sharedWith.length} other Session(s).${folderUsageText(summary.sharedReasons)}`
      } else if (metadataState === 'invalid') reason = 'The folder metadata does not match this workspace and Session; whole-folder deletion is blocked.'
      let keepOutReason
      if (running) keepOutReason = reason
      else if (symlink) keepOutReason = reason
      else if (referencesUnknown) keepOutReason = reason
      else if (stats.complete !== true) keepOutReason = reason
      else if (keepOutSummary.sharedWith.length > 0) {
        keepOutReason = `Still used by ${keepOutSummary.sharedWith.length} other Session(s).${folderUsageText(keepOutSummary.sharedReasons)}`
      }
      rows.push({
        key: `${pathKey(workspace.path)}|${entry.name}`,
        workspace: resolve(workspace.path),
        workspaceTitle: workspace.title,
        name: entry.name,
        path: folder,
        title: typeof metadata?.title === 'string' && metadata.title.length > 0
          ? metadata.title
          : (typeof owner?.[1]?.title === 'string' && owner[1].title.length > 0 ? owner[1].title : entry.name),
        sessionId,
        metadataState,
        state,
        archived: sessionId === undefined ? false : archived.has(sessionId),
        logExists: sessionId === undefined ? false : logIds.has(sessionId),
        open,
        running,
        symlink,
        sharedWith,
        sharedReasons: summary.sharedReasons,
        keepOutSharedWith: keepOutSummary.sharedWith,
        keepOutSharedReasons: keepOutSummary.sharedReasons,
        referencesUnknown,
        allDeletable,
        keepOutDeletable,
        hasWork: stats.hasWork,
        hasOut: stats.hasOut,
        totalBytes: stats.totalBytes,
        workBytes: stats.workBytes,
        outBytes: stats.outBytes,
        unknownEntries: stats.unknownEntries.slice(0, 50),
        unknownCount: stats.unknownEntries.length,
        modifiedAt: stats.modifiedAt,
        manifestHash: stats.manifestHash,
        workManifestHash: stats.workManifestHash,
        outManifestHash: stats.outManifestHash,
        manifestEntries: stats.manifestEntries,
        agentsSignature: stats.agentsSignature,
        scanComplete: stats.complete,
        scanErrors: stats.errors,
        reason,
        keepOutReason,
      })
    }
  }
  rows.sort((left, right) => right.name.localeCompare(left.name))
  return rows
}

const indexQueues = new Map()

function withIndexLock(indexPath, task) {
  const key = pathKey(indexPath)
  const previous = indexQueues.get(key) ?? Promise.resolve()
  const run = previous.then(() => task(), () => task())
  const settled = run.then(() => undefined, () => undefined)
  indexQueues.set(key, settled)
  void settled.finally(() => {
    if (indexQueues.get(key) === settled) indexQueues.delete(key)
  })
  return run
}

async function removeConversationIndexEntriesByFolder(indexPath, base, name, warnings) {
  return withIndexLock(indexPath, () => removeConversationIndexEntriesByFolderUnlocked(indexPath, base, name, warnings))
}

async function removeConversationIndexEntriesByFolderUnlocked(indexPath, base, name, warnings) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const index = await readJsonFile(indexPath, undefined)
    if (index === null || typeof index !== 'object' || Array.isArray(index)) return false
    const ids = Object.keys(index).filter((id) => {
      const value = index[id]
      if (value === null || typeof value !== 'object' || typeof value.folder !== 'string') return false
      return value.folder === name ||
        samePath(isAbsolute(value.folder) ? value.folder : join(base, value.folder), join(base, name))
    })
    if (ids.length === 0) return false
    const next = { ...index }
    for (const id of ids) delete next[id]
    try {
      await writeJsonAtomic(indexPath, next)
    } catch (error) {
      warnings.push(`Conversation index ${indexPath}: could not remove ${name} (${formatError(error)}).`)
      return false
    }
    const after = await readJsonFile(indexPath, undefined)
    if (after !== null && typeof after === 'object' && !Array.isArray(after) &&
        ids.every((id) => !Object.prototype.hasOwnProperty.call(after, id))) {
      const lost = Object.keys(index).filter((key) => !ids.includes(key) &&
        !Object.prototype.hasOwnProperty.call(after, key))
      if (lost.length === 0) return true
      const merged = { ...after }
      for (const key of lost) merged[key] = index[key]
      try {
        await writeJsonAtomic(indexPath, merged)
        const verified = await readJsonFile(indexPath, undefined)
        if (verified !== null && typeof verified === 'object' && !Array.isArray(verified) &&
            ids.every((id) => !Object.prototype.hasOwnProperty.call(verified, id)) &&
            Object.keys(index).filter((key) => !ids.includes(key)).every((key) => Object.prototype.hasOwnProperty.call(verified, key))) {
          return true
        }
      } catch (error) {
        warnings.push(`Conversation index ${indexPath}: could not restore ${lost.length} concurrent entry/entries (${formatError(error)}).`)
        return false
      }
    }
  }
  warnings.push(`Conversation index ${indexPath}: entries for ${name} changed concurrently; refresh and retry.`)
  return false
}

async function removeFolderTree(ctx, row, warnings) {
  const workspace = ctx.workspaceRegistry.list().find((item) => samePath(item.path, row.workspace))
  if (workspace === undefined) throw new Error('workspace is no longer registered')
  const base = join(workspace.path, CONVERSATION_BASE)
  const folder = join(base, row.name)
  if (!(await isRealDirectory(folder))) return { removed: false, bytes: 0, reason: 'missing' }
  if (await hasSymlinkAncestor(folder, workspace.path)) {
    throw new Error('refusing to delete a conversation folder reached through a symlink or junction')
  }
  const metadata = await readConversationMetadata(folder)
  if (metadata !== undefined) {
    const id = typeof metadata.sessionId === 'string' ? metadata.sessionId : row.sessionId
    if (!isConversationFolderFor(folder, metadata, id, workspace.path)) {
      throw new Error('refusing to delete a folder whose session.json does not match this workspace')
    }
  }
  const stats = await scanFolder(folder)
  if (stats.complete !== true) {
    throw new Error(`refusing to delete a folder that changed or could not be fully scanned: ${stats.errors[0] ?? 'unknown scan error'}`)
  }
  if (typeof row.manifestHash !== 'string' || stats.manifestHash !== row.manifestHash) {
    throw new Error('the conversation folder changed after preview; refresh and preview again')
  }
  const bytes = stats.totalBytes
  await rm(folder, { recursive: true, force: false, maxRetries: 3 })
  await removeConversationIndexEntriesByFolder(join(base, CONVERSATION_INDEX), base, row.name, warnings)
  return { removed: true, bytes }
}

async function keepFolderOut(ctx, row, warnings) {
  const workspace = ctx.workspaceRegistry.list().find((item) => samePath(item.path, row.workspace))
  if (workspace === undefined) throw new Error('workspace is no longer registered')
  const base = join(workspace.path, CONVERSATION_BASE)
  const folder = join(base, row.name)
  if (!(await isRealDirectory(folder))) return { removed: false, workBytes: 0, agentsBytes: 0, outBytes: 0, reason: 'missing' }
  if (await hasSymlinkAncestor(folder, workspace.path)) {
    throw new Error('refusing to clean a conversation folder reached through a symlink or junction')
  }
  const stats = await scanFolder(folder)
  if (stats.complete !== true) {
    throw new Error(`refusing to clean a folder that changed or could not be fully scanned: ${stats.errors[0] ?? 'unknown scan error'}`)
  }
  if (typeof row.workManifestHash === 'string' && stats.workManifestHash !== row.workManifestHash) {
    throw new Error('the work directory changed after preview; refresh and preview again')
  }
  if (row.agentsSignature !== undefined && stats.agentsSignature !== row.agentsSignature) {
    throw new Error('AGENTS.md changed after preview; refresh and preview again')
  }
  let workBytes = 0
  let agentsBytes = 0
  const work = join(folder, 'work')
  const workInfo = await lstatSafe(work)
  if (workInfo !== undefined) {
    if (workInfo.isSymbolicLink()) throw new Error('refusing to delete a work directory that is a symlink')
    if (!workInfo.isDirectory()) throw new Error('refusing to delete a work entry that is not a directory')
    workBytes = stats.workBytes
    await rm(work, { recursive: true, force: false, maxRetries: 3 })
  }
  const rules = join(folder, CONVERSATION_RULES)
  const rulesInfo = await lstatSafe(rules)
  if (rulesInfo !== undefined) {
    if (rulesInfo.isSymbolicLink()) {
      warnings.push(`Conversation folder ${row.name}: ${CONVERSATION_RULES} is a symlink and was kept.`)
    } else if (rulesInfo.isFile()) {
      agentsBytes = rulesInfo.size
      await unlink(rules)
    }
  }
  return {
    removed: workBytes > 0 || agentsBytes > 0,
    workBytes,
    agentsBytes,
    outBytes: stats.outBytes,
  }
}

async function executeFolderDeletion(ctx, body, tokenRecord) {
  if (tokenRecord === undefined) {
    throw new HttpError(409, 'folder-preview-required', 'Refresh the conversation folder list before deleting.')
  }
  if (body.confirmed !== true) {
    throw new HttpError(400, 'confirmation-required', 'Confirm the folder cleanup first.')
  }
  const requested = Array.isArray(body.folders)
    ? body.folders.filter((item) => item !== null && typeof item === 'object' && typeof item.key === 'string')
    : []
  if (requested.length === 0) throw new HttpError(400, 'no-folders', 'Select at least one conversation folder.')
  const preview = await listConversationFolders(ctx)
  const currentFingerprints = folderPreviewFingerprint(preview)
  for (const item of requested) {
    const mode = item.mode === 'all' ? 'all' : 'keepOut'
    const expected = tokenRecord.fingerprints?.get(item.key)
    const actual = currentFingerprints.get(item.key)
    if (expected === undefined || actual === undefined || actual[mode] !== expected[mode]) {
      throw new HttpError(409, 'stale-preview', 'A selected conversation folder changed. Refresh and preview again.')
    }
  }
  const byKey = new Map(preview.map((folder) => [folder.key, folder]))
  const report = {
    folders: { requested: requested.length, removed: 0, keptOut: 0, skipped: 0 },
    bytes: { removed: 0, workRemoved: 0, outKept: 0 },
    errors: [],
    warnings: [],
  }
  const seen = new Set()
  tokenRecord.started = true
  for (const item of requested) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    const row = byKey.get(item.key)
    if (row === undefined) {
      throw new HttpError(409, 'stale-preview', 'A conversation folder is no longer listed. Refresh and preview again.')
    }
    const mode = item.mode === 'all' ? 'all' : 'keepOut'
    if (row.running) {
      report.folders.skipped += 1
      report.errors.push({ scope: 'folder', id: row.name, message: row.reason ?? 'The Session is running.' })
      continue
    }
    if (mode === 'all' && row.allDeletable !== true) {
      report.folders.skipped += 1
      report.errors.push({ scope: 'folder', id: row.name, message: row.reason ?? 'Whole-folder deletion is not allowed.' })
      continue
    }
    if (mode === 'keepOut' && row.keepOutDeletable !== true) {
      report.folders.skipped += 1
      report.errors.push({ scope: 'folder', id: row.name, message: row.reason ?? 'This folder cannot be cleaned.' })
      continue
    }
    try {
      if (mode === 'all') {
        const removal = await removeFolderTree(ctx, row, report.warnings)
        if (removal.removed) {
          report.folders.removed += 1
          report.bytes.removed += removal.bytes
          report.bytes.workRemoved += row.workBytes
        } else {
          report.folders.skipped += 1
        }
      } else {
        const removal = await keepFolderOut(ctx, row, report.warnings)
        report.folders.keptOut += 1
        report.bytes.removed += removal.workBytes + removal.agentsBytes
        report.bytes.workRemoved += removal.workBytes
        report.bytes.outKept += removal.outBytes
      }
    } catch (error) {
      report.folders.skipped += 1
      report.errors.push({ scope: 'folder', id: row.name, message: formatError(error) })
    }
  }
  completeRecord(tokenRecord)
  return report
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
  return withIndexLock(indexPath, () => removeConversationIndexEntryUnlocked(indexPath, id, warnings))
}

async function removeConversationIndexEntryUnlocked(indexPath, id, warnings) {
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
        const verified = await readJsonFile(indexPath, undefined)
        if (verified !== null && typeof verified === 'object' && !Array.isArray(verified) &&
            !Object.prototype.hasOwnProperty.call(verified, id) &&
            lost.every((key) => Object.prototype.hasOwnProperty.call(verified, key))) {
          return true
        }
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
  const stats = await scanFolder(folder)
  const splitLayout = stats.hasWork || stats.hasOut
  if (splitLayout && entry.allowUnknown !== true && stats.unknownEntries.length > 0) {
    throw new Error(`refusing to delete a conversation folder with unexpected entries: ${stats.unknownEntries.slice(0, 5).join(', ')}`)
  }
  if (stats.complete !== true) {
    throw new Error(`refusing to delete a folder that changed or could not be fully scanned: ${stats.errors[0] ?? 'unknown scan error'}`)
  }
  if (typeof entry.manifestHash !== 'string' || stats.manifestHash !== entry.manifestHash) {
    throw new Error('the conversation folder changed after preview; refresh and preview again')
  }
  const bytes = stats.totalBytes
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
    sessions: { requested: selectedIds.size, removed: 0, missing: 0, deferred: 0 },
    logs: { removed: 0, bytes: 0 },
    projection: { removed: 0, bytes: 0 },
    conversation: { removed: 0, bytes: 0, skipped: 0 },
    attachments: { removed: 0, bytes: 0, skipped: 0 },
    files: { removed: 0, bytes: 0, skipped: 0 },
    spills: { removed: 0, bytes: 0, skipped: 0 },
    imageCache: { removed: false, bytes: 0 },
    pending: [],
    errors: [],
    warnings: [...preview.warnings],
  }

  const workspaces = ctx.workspaceRegistry.list()
  const workspaceBySession = new Map()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }
  const failedSessions = new Set()
  const removedSessions = []
  const journal = {
    version: JOURNAL_VERSION,
    id: randomBytes(8).toString('hex'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    phase: 'logs',
    ids: preview.sessions.map((session) => session.id),
    options,
    fingerprintHash: createHash('sha256').update(tokenRecord.fingerprint).digest('hex'),
    completedSessions: [],
    failedSessions: [],
    pending: [],
    summary: null,
    errors: [],
    warnings: [],
  }
  try {
    await persistJournal(journal)
  } catch (error) {
    throw new HttpError(500, 'journal-write-failed', `Cannot write the cleanup journal before deletion: ${formatError(error)}`)
  }
  const saveProgress = async () => {
    try {
      await persistJournal(journal)
    } catch (error) {
      report.warnings.push(`Cleanup journal progress could not be saved (${formatError(error)}); the cleanup itself continues.`)
    }
  }
  tokenRecord.started = true

  /* Remove irreversible Session data first. Conversation folders are handled
     after every log result is known, so a Session whose deletion fails can
     still protect a folder that another selected Session would otherwise
     remove. */
  for (const session of preview.sessions) {
    const id = session.id
    const workspace = workspaceBySession.get(id)

    if (isAgentRunning(ctx, id)) {
      failedSessions.add(id)
      journal.failedSessions.push(id)
      report.errors.push({ scope: 'session-live', id, message: 'The Session started running; its files and log were kept.' })
      await saveProgress()
      continue
    }
    const wasOpen = isSessionOpen(ctx, id)

    const projection = await removeProjectionCache(ctx, id, report.warnings, session.projectionCache?.bytes)
    if (projection.removed) {
      report.projection.removed += 1
      report.projection.bytes += projection.bytes
    } else if (projection.reason === 'changed') {
      report.errors.push({ scope: 'projection', id, message: 'The checkpoint changed after preview and was kept; preview again.' })
    }

    let logRemoved = false
    if (session.missing === true) {
      report.sessions.missing += 1
      logRemoved = true
    } else {
      if (isAgentRunning(ctx, id)) {
        failedSessions.add(id)
        journal.failedSessions.push(id)
        report.errors.push({ scope: 'session-live', id, message: 'The Session started running before its log deletion; its log was kept.' })
        await saveProgress()
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
          const removal = await removeSessionDirectory(persistenceRoot(ctx), directory, id, session.logManifestHash)
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
        journal.failedSessions.push(id)
        report.errors.push({ scope: 'session-log', id, message: formatError(error) })
        await saveProgress()
        continue
      }
    }

    if (!logRemoved) continue
    report.sessions.removed += 1
    journal.completedSessions.push(id)
    removedSessions.push({ session, wasOpen, workspace })
    await saveProgress()
  }

  const pendingReported = new Set()
  const deferPending = async (id, warning) => {
    try {
      await addPendingId(id)
      if (!pendingReported.has(id)) {
        pendingReported.add(id)
        report.pending.push(id)
        report.sessions.deferred += 1
        if (!journal.pending.includes(id)) journal.pending.push(id)
      }
      report.warnings.push(warning)
      return true
    } catch (error) {
      report.errors.push({ scope: 'pending', id, message: formatError(error) })
      report.warnings.push(`Session ${id}: its files were removed, but the deferred bookkeeping record could not be written; it remains archived.`)
      return false
    }
  }

  journal.phase = 'bookkeeping'
  await saveProgress()
  for (const { session, wasOpen, workspace } of removedSessions) {
    const id = session.id
    const folder = session.conversationFolder

    if (options.conversationFolder === true && folder !== null) {
      const failedUser = (folder.users ?? []).find((userId) => failedSessions.has(userId))
      if (failedUser !== undefined) {
        report.conversation.skipped += 1
        report.warnings.push(`Session ${id}: conversation folder kept because Session ${failedUser} could not be cleaned and may still use it.`)
      } else if (folder.deletable !== true) {
        report.conversation.skipped += 1
        report.warnings.push(`Session ${id}: conversation folder kept because ${folder.reason ?? 'it is not safe to delete'}.`)
      } else {
        try {
          const removal = await removeConversationFolder(folder, id, report.warnings)
          report.conversation.removed += 1
          report.conversation.bytes += removal.bytes
        } catch (error) {
          report.conversation.skipped += 1
          report.errors.push({ scope: 'conversation-folder', id, message: formatError(error) })
        }
      }
    }

    /* A loaded Session cannot lose its workspace/archive bookkeeping yet: the
       sidebar would list it with no workspace and show “未分组”. Its files are
       gone, so keep the archive marker and defer only the bookkeeping. */
    if (wasOpen || isSessionOpen(ctx, id)) {
      await deferPending(id, `Session ${id}: files were removed now; its workspace and archive records will be finalized on the next Harness start.`)
      factCache.delete(id)
      await saveProgress()
      continue
    }

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
      await deferPending(id, `Session ${id}: its files were removed, but detaching from its workspace failed; bookkeeping will be retried on the next Harness start.`)
      factCache.delete(id)
      await saveProgress()
      continue
    }
    try {
      await ctx.workspaceRegistry.unarchiveSession(id)
    } catch (error) {
      report.errors.push({ scope: 'unarchive', id, message: formatError(error) })
      await deferPending(id, `Session ${id}: its files were removed, but unarchiving failed; bookkeeping will be retried on the next Harness start.`)
      factCache.delete(id)
      await saveProgress()
      continue
    }
    try {
      await ctx.workspaceRegistry.unpinSession(id)
    } catch (error) {
      report.errors.push({ scope: 'unpin', id, message: formatError(error) })
      await deferPending(id, `Session ${id}: its files were removed, but unpinning failed; bookkeeping will be retried on the next Harness start.`)
    }
    factCache.delete(id)
    await saveProgress()
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

  journal.phase = 'artifacts'
  await saveProgress()

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
        if (removal.reason === 'changed') {
          report.errors.push({ scope: 'spill', id: spill.directory, message: 'The spill directory changed after preview and was kept; preview again.' })
        }
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
        if (removal.reason === 'changed') {
          report.errors.push({ scope: 'file', id: path, message: 'The file changed after preview and was kept; preview again.' })
        } else if (removal.reason === 'missing') {
          report.warnings.push(`File ${path}: it no longer exists; nothing was removed.`)
        }
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

  report.summary = {
    removedSessions: report.sessions.removed,
    missingSessions: report.sessions.missing,
    deferredSessions: report.sessions.deferred,
    errors: report.errors.length,
    warnings: report.warnings.length,
  }
  journal.phase = 'done'
  journal.status = report.errors.length > 0 || report.sessions.removed < selectedIds.size ? 'partial' : 'completed'
  journal.summary = report.summary
  journal.errors = report.errors.slice(0, 50)
  journal.warnings = report.warnings.slice(0, 50)
  await saveProgress()
  completeRecord(tokenRecord)
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
      if (op === 'journal') {
        sendJson(res, 200, { ok: true, value: { journal: await readJournalRecord() ?? null } })
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
        const tokenRecord = claimPreviewToken(body.previewToken)
        try {
          const value = await withDeletionLock(() => executeDeletion(ctx, body, tokenRecord))
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          releaseRecord(tokenRecord)
          throw error
        }
        return
      }
      if (op === 'folders') {
        const folders = await listConversationFolders(ctx)
        const previewToken = rememberFolderPreview(folders)
        sendJson(res, 200, { ok: true, value: { folders, previewToken } })
        return
      }
      if (op === 'folders-delete') {
        const tokenRecord = claimFolderPreviewToken(body.previewToken)
        try {
          const value = await withDeletionLock(() => executeFolderDeletion(ctx, body, tokenRecord))
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          releaseRecord(tokenRecord)
          throw error
        }
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

  void (async () => {
    await markInterruptedJournal(ctx)
    await finalizePending(ctx)
    await recoverJournalBookkeeping(ctx)
  })().catch((error) => {
    ctx.logger?.warn?.(`session-cleaner: startup recovery failed: ${formatError(error)}`)
  })
}

