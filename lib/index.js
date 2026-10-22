/**
 * dsh-multi-workspace — Host half.
 *
 * Owns three things for the Web GUI:
 *
 * 1. the durable member-folder records (`<DSH_HOME>/multi-workspace/state.json`,
 *    atomic write, one record per DSH workspace id);
 * 2. the exact browser Fetch route `/api/multi-workspace/state` the client half
 *    reads and writes through `ctx.connection.fetch.register()`;
 * 3. a system-prompt section that tells the model which extra folders belong to
 *    the Session's workspace, so absolute-path reads/searches are not mistaken
 *    for files outside the project.
 *
 * Loaded as a profile plugin, therefore this module imports `node:` builtins
 * only. `@deepseek-ai/*` packages are not resolvable from the plugin profile and
 * must never be imported here.
 *
 * The Host half does not change sandbox behaviour: the DSH sandbox keeps its
 * single writable root (the Session `header.cwd`), and writes into member
 * folders go through the normal `sandbox_permissions` escalation the user
 * approves per call.
 *
 * @module dsh-multi-workspace
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Stable Cordis plugin name (matches `package.json.name`). */
export const name = 'dsh-multi-workspace'

/** Services required before the Host half can register anything. */
export const inject = ['connection', 'systemPrompt']

/** Exact browser Fetch route; the dispatcher requires it to live under `/api`. */
export const ROUTE_PATH = '/api/multi-workspace/state'

/** Prompt-section identity and placement (after tool sections, before deliverables). */
export const SECTION_NAME = 'multi-workspace:roots'
export const SECTION_ORDER = 8000

/** On-disk format version for `<DSH_HOME>/multi-workspace/state.json`. */
export const STATE_VERSION = 1

/** Directory and file names below DSH_HOME. */
const STATE_DIRECTORY = 'multi-workspace'
const STATE_FILE = 'state.json'

/** Windows path comparison is case-insensitive; every other platform keeps case. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32'

/** Defensive limits for Host-side input validation. */
const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4096
const MAX_ROOTS = 256

/**
 * A malformed client payload, answered with HTTP 400 and a stable error code.
 * Anything else escaping a route handler is treated as a server fault (500).
 */
class RequestError extends Error {
  /**
   * @param {string} code - stable machine-readable code returned to the client.
   * @param {string} message - human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'RequestError'
    this.code = code
  }
}

/** @returns an empty in-memory / on-disk state document. */
export function createEmptyState() {
  return { version: STATE_VERSION, workspaces: {} }
}

/**
 * Resolve the per-user Harness home directory.
 *
 * Mirrors the harness convention: an explicit `DSH_HOME` environment variable
 * wins (the portable installer sets it for custom directories), otherwise
 * `~/.dsh`.
 *
 * @param {Record<string, unknown>} [env] - environment to read.
 * @param {string} [homeDirectory] - fallback user home.
 * @returns {string} the DSH home directory (not normalized to an absolute path).
 */
export function resolveDshHome(env = process.env, homeDirectory = os.homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured.length > 0) return configured
  return path.join(homeDirectory, '.dsh')
}

/**
 * Compute the state-file path for one DSH home.
 *
 * @param {string} dshHome - DSH home directory.
 * @returns {string} absolute path of `multi-workspace/state.json`.
 */
export function stateFilePath(dshHome) {
  return path.join(path.resolve(dshHome), STATE_DIRECTORY, STATE_FILE)
}

/**
 * Strip a Windows extended-length prefix so stored paths stay in the spelling
 * the DSH workspace registry and Session headers use.
 *
 * @param {string} value - canonical path from `fs.realpath`.
 * @returns {string} the same path without a `\\?\` prefix.
 */
function stripLongPathPrefix(value) {
  if (!value.startsWith('\\\\?\\')) return value
  const rest = value.slice(4)
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`
  return rest
}

/**
 * Comparison/folding key for an absolute path.
 *
 * Windows paths fold separators and letter case and drop the trailing
 * separator, so `C:/Foo/`, `C:\foo` and `c:\Foo` all address one folder.
 * Empty or non-string input yields `''` (never a match).
 *
 * @param {unknown} value - candidate path.
 * @returns {string} folded key.
 */
export function normalizePathKey(value) {
  if (typeof value !== 'string') return ''
  let trimmed = value.trim()
  if (trimmed === '') return ''
  if (CASE_INSENSITIVE_PATHS) trimmed = trimmed.replaceAll('/', '\\')
  try {
    trimmed = path.normalize(trimmed)
  } catch {
    // Keep the raw spelling when normalize rejects it.
  }
  trimmed = stripLongPathPrefix(trimmed)
  const root = path.parse(trimmed).root
  if (trimmed !== root) {
    const withoutTrailing = trimmed.replace(/[\\/]+$/, '')
    if (withoutTrailing.length > 0) trimmed = withoutTrailing
  }
  if (CASE_INSENSITIVE_PATHS) return trimmed.toLowerCase()
  return trimmed
}

/**
 * Read the live DSH workspace ids from the optional registry service.
 *
 * The registry is a *soft* dependency: when it is not mounted (or its
 * projection is not ready) the state file is left untouched rather than being
 * pruned against an unknown list.
 *
 * @param {object} ctx - Cordis plugin context.
 * @returns {string[] | undefined} live ids, or `undefined` when unknowable.
 */
function readWorkspaceIds(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
    if (registry === null || typeof registry !== 'object' || typeof registry.list !== 'function') return undefined
    const workspaces = registry.list()
    if (!Array.isArray(workspaces)) return undefined
    const ids = []
    for (const workspace of workspaces) {
      const id = workspace?.id
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
    return ids
  } catch {
    // A registry failure must never break a state read.
    return undefined
  }
}

/**
 * Build a `ctx.logger`-backed warning sink that can never throw.
 *
 * @param {object} ctx - Cordis plugin context.
 * @returns {(message: string) => void} warning sink.
 */
function createWarningSink(ctx) {
  return (message) => {
    try {
      const logger = ctx?.logger
      if (logger === null || logger === undefined) return
      const scoped = typeof logger === 'function' ? logger('multi-workspace') : logger
      if (scoped !== null && scoped !== undefined && typeof scoped.warn === 'function') scoped.warn(message)
    } catch {
      // Logging is best-effort and must never affect plugin behaviour.
    }
  }
}

/**
 * Reduce arbitrary on-disk data to the supported state shape.
 *
 * Unknown records are dropped, roots are de-duplicated and de-linked from the
 * primary folder. Corrupt or foreign files degrade to an empty state instead of
 * failing plugin activation.
 *
 * @param {unknown} raw - parsed JSON value.
 * @returns {{ version: number, workspaces: Record<string, object> }} sanitized state.
 */
export function sanitizeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return createEmptyState()
  if (raw.version !== STATE_VERSION) return createEmptyState()
  const source = raw.workspaces
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return createEmptyState()
  const workspaces = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : key
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) continue
    const primary = typeof value.path === 'string' ? value.path.trim() : ''
    if (primary === '' || primary.length > MAX_PATH_LENGTH || !path.isAbsolute(primary)) continue
    const roots = []
    const seen = new Set([normalizePathKey(primary)])
    if (Array.isArray(value.roots)) {
      for (const candidate of value.roots) {
        if (typeof candidate !== 'string') continue
        const trimmed = candidate.trim()
        if (trimmed === '' || trimmed.length > MAX_PATH_LENGTH || !path.isAbsolute(trimmed)) continue
        const rootKey = normalizePathKey(trimmed)
        if (rootKey === '' || seen.has(rootKey)) continue
        seen.add(rootKey)
        roots.push(trimmed)
      }
    }
    const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.length > 0 ? value.updatedAt : new Date(0).toISOString()
    workspaces[id] = { id, path: primary, roots, updatedAt }
  }
  return { version: STATE_VERSION, workspaces }
}

/**
 * Read and sanitize the state file synchronously.
 *
 * Synchronous so `apply()` can publish the prompt section immediately (a prompt
 * section's `text` callback cannot await). A missing file is an empty state; an
 * unreadable or corrupt file is reported through `warn` and also yields an empty
 * state, so a bad file never blocks plugin activation.
 *
 * @param {string} file - absolute state-file path.
 * @param {(message: string) => void} [warn] - diagnostics sink.
 * @returns {{ version: number, workspaces: Record<string, object> }} loaded state.
 */
export function readStateFileSync(file, warn = () => {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`multi-workspace: cannot read ${file}: ${describeError(error)}`)
    return createEmptyState()
  }
  try {
    return sanitizeState(JSON.parse(text))
  } catch (error) {
    warn(`multi-workspace: ${file} is not valid JSON (${describeError(error)}); starting with an empty state`)
    return createEmptyState()
  }
}

/**
 * Serialize a state document in the on-disk format.
 *
 * @param {{ version: number, workspaces: Record<string, object> }} state - state document.
 * @returns {string} JSON text with a trailing newline.
 */
export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * Atomically replace the state file: write a sibling temporary file, then
 * rename it over the target (Windows `rename` replaces an existing file).
 *
 * @param {string} file - absolute state-file path.
 * @param {string} text - complete serialized state.
 * @returns {Promise<void>} resolution after the rename.
 */
export async function writeStateFileAtomic(file, text) {
  const directory = path.dirname(file)
  await fsp.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`)
  try {
    await fsp.writeFile(temporary, text, 'utf8')
    await fsp.rename(temporary, file)
  } catch (error) {
    try {
      await fsp.rm(temporary, { force: true })
    } catch {
      // Best-effort cleanup; the original error is the one worth reporting.
    }
    throw error
  }
}

/**
 * Render a short error description without assuming an `Error` shape.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} description.
 */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Build the folded-path → workspace-id index used by the prompt section.
 *
 * @param {{ workspaces?: Record<string, object> }} state - state document.
 * @returns {Map<string, string>} index; the first record wins a duplicated path.
 */
export function buildPathIndex(state) {
  const index = new Map()
  const workspaces = state?.workspaces ?? {}
  for (const [id, record] of Object.entries(workspaces)) {
    const key = normalizePathKey(record?.path)
    if (key === '' || index.has(key)) continue
    index.set(key, typeof record?.id === 'string' && record.id.length > 0 ? record.id : id)
  }
  return index
}

/**
 * Find the workspace record owning one Session cwd (pure helper).
 *
 * @param {{ workspaces?: Record<string, object> }} state - state document.
 * @param {unknown} cwd - Session `header.cwd`.
 * @returns {object | undefined} a defensive copy of the matching record.
 */
export function findRecordByCwd(state, cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return undefined
  for (const record of Object.values(state?.workspaces ?? {})) {
    if (normalizePathKey(record?.path) === key) return cloneRecord(record)
  }
  return undefined
}

/**
 * @param {object} record - stored record.
 * @returns {object} defensive copy with a copied `roots` array.
 */
function cloneRecord(record) {
  return {
    id: record.id,
    path: record.path,
    roots: Array.isArray(record.roots) ? [...record.roots] : [],
    updatedAt: record.updatedAt,
  }
}

/**
 * Validate a workspace id.
 *
 * @param {unknown} value - candidate id.
 * @returns {string} trimmed id.
 * @throws {RequestError} when the value is not a usable id.
 */
function validateId(value) {
  if (typeof value !== 'string') throw new RequestError('invalid-id', 'id must be a non-empty string')
  const trimmed = value.trim()
  if (trimmed === '') throw new RequestError('invalid-id', 'id must be a non-empty string')
  if (trimmed.length > MAX_ID_LENGTH) throw new RequestError('invalid-id', `id must not exceed ${MAX_ID_LENGTH} characters`)
  if (trimmed.includes('\u0000')) throw new RequestError('invalid-id', 'id must not contain NUL characters')
  return trimmed
}

/**
 * Validate one absolute folder path from a client payload.
 *
 * @param {unknown} value - candidate path.
 * @param {string} field - field name used in diagnostics.
 * @returns {string} trimmed absolute path.
 * @throws {RequestError} when the value is not an absolute path.
 */
function validatePathValue(value, field) {
  if (typeof value !== 'string') throw new RequestError('invalid-path', `${field} must be an absolute folder path`)
  const trimmed = value.trim()
  if (trimmed === '') throw new RequestError('invalid-path', `${field} must be a non-empty absolute folder path`)
  if (trimmed.length > MAX_PATH_LENGTH) throw new RequestError('invalid-path', `${field} must not exceed ${MAX_PATH_LENGTH} characters`)
  if (trimmed.includes('\u0000')) throw new RequestError('invalid-path', `${field} must not contain NUL characters`)
  if (!path.isAbsolute(trimmed)) throw new RequestError('invalid-path', `${field} must be an absolute folder path: ${JSON.stringify(trimmed)}`)
  return trimmed
}

/**
 * Validate the `roots` input: absent means "no member folders".
 *
 * @param {unknown} roots - candidate list.
 * @returns {string[]} absolute folder paths in input order.
 * @throws {RequestError} when the list is malformed.
 */
function validateRootValues(roots) {
  if (roots === undefined || roots === null) return []
  if (!Array.isArray(roots)) throw new RequestError('invalid-roots', 'roots must be an array of absolute folder paths')
  if (roots.length > MAX_ROOTS) throw new RequestError('invalid-roots', `roots must not contain more than ${MAX_ROOTS} entries`)
  return roots.map((root, index) => {
    try {
      return validatePathValue(root, `roots[${index}]`)
    } catch (error) {
      throw new RequestError('invalid-roots', error instanceof Error ? error.message : `roots[${index}] must be an absolute folder path`)
    }
  })
}

/**
 * Canonicalize one folder path with `fs.realpath`, keeping the original
 * spelling when the folder cannot be resolved (the client may be saving a path
 * that is briefly unavailable, and the design keeps the record rather than
 * rejecting the save).
 *
 * @param {string} value - absolute path.
 * @param {(target: string) => Promise<string>} realpath - resolver.
 * @returns {Promise<string>} canonical or original absolute path.
 */
async function canonicalizePath(value, realpath) {
  try {
    const resolved = await realpath(value)
    if (typeof resolved !== 'string' || resolved.trim() === '') return value
    return stripLongPathPrefix(path.normalize(resolved))
  } catch {
    return value
  }
}

/**
 * Validate and canonicalize one `save` payload into a storable record body.
 *
 * Roots are canonicalized, de-duplicated (folded path comparison) and any root
 * equal to the primary folder is dropped, preserving selection order.
 *
 * @param {unknown} input - parsed POST body.
 * @param {{ realpath?: (target: string) => Promise<string> }} [options] - injectable resolver for tests.
 * @returns {Promise<{ id: string, path: string, roots: string[] }>} normalized record.
 * @throws {RequestError} when the payload is malformed.
 */
export async function normalizeWorkspaceInput(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestError('invalid-body', 'request body must be a JSON object')
  }
  const realpath = typeof options.realpath === 'function' ? options.realpath : fsp.realpath
  const id = validateId(input.id)
  const primary = await canonicalizePath(validatePathValue(input.path, 'path'), realpath)
  const roots = []
  const seen = new Set([normalizePathKey(primary)])
  for (const candidate of validateRootValues(input.roots)) {
    const resolved = await canonicalizePath(candidate, realpath)
    const key = normalizePathKey(resolved)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    roots.push(resolved)
  }
  return { id, path: primary, roots }
}

/**
 * Build the model-facing prompt section for one workspace record.
 *
 * A record without member folders produces `''` (an ordinary single-folder
 * workspace contributes nothing the model does not already know), and empty
 * section text is dropped by the prompt registry.
 *
 * @param {object | undefined} record - workspace record.
 * @returns {string} section text, or `''`.
 */
export function buildPromptSectionText(record) {
  if (record === null || typeof record !== 'object') return ''
  const primary = typeof record.path === 'string' ? record.path : ''
  if (primary === '') return ''
  const primaryKey = normalizePathKey(primary)
  const roots = []
  for (const root of Array.isArray(record.roots) ? record.roots : []) {
    if (typeof root !== 'string' || root === '') continue
    const key = normalizePathKey(root)
    if (key === '' || key === primaryKey) continue
    roots.push(root)
  }
  if (roots.length === 0) return ''
  const lines = [
    'This Session belongs to a multi-folder Workspace. Member folders (absolute paths):',
    `- ${primary} (primary folder of this Session)`,
    ...roots.map((root) => `- ${root}`),
    'You may read and search files in every member folder with absolute paths. The Session workspace root is the primary folder; writing or editing outside it is allowed only through the normal sandbox escalation (`sandbox_permissions`), which asks the user for approval. Do not treat the other folders as missing or outside the project.',
  ]
  return lines.join('\n')
}

/**
 * Render the prompt section for one prompt-assembly context.
 *
 * The Session cwd comes from `context.agent.session.header.cwd` (the agent loop
 * passes its live agent through `AssembleContext`). Member roots are never
 * treated as a Session cwd, so the primary folder label is exact.
 *
 * @param {{ findByCwd: (cwd: string) => object | undefined }} store - state store.
 * @param {unknown} context - prompt assembly context.
 * @returns {string} section text, or `''` when this Session has no match.
 */
export function renderPromptForContext(store, context) {
  const cwd = context?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return ''
  return buildPromptSectionText(store.findByCwd(cwd))
}

/**
 * Create the in-memory state store backed by one state file.
 *
 * The store owns every mutation and serializes writes through a promise chain
 * so concurrent POSTs cannot interleave `state.json` writes. Memory always
 * reflects the newest accepted truth; a failed write rejects the caller (the
 * route answers 500) without reverting memory, matching the fail-loud design
 * of the rest of the harness.
 *
 * @param {{
 *   file: string,
 *   realpath?: (target: string) => Promise<string>,
 *   warn?: (message: string) => void,
 * }} options - store options.
 * @returns {object} store API used by `apply()` and the route handler.
 */
export function createStateStore(options = {}) {
  const file = options.file
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('createStateStore requires a state file path')
  const realpath = typeof options.realpath === 'function' ? options.realpath : fsp.realpath
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  const state = readStateFileSync(file, warn)
  const records = state.workspaces
  let pathIndex = buildPathIndex(state)
  let writeChain = Promise.resolve()
  let disposed = false

  /** Rebuild the folded-path index after a mutation. */
  function rebuildIndex() {
    pathIndex = buildPathIndex(state)
  }

  /**
   * Queue a write of the *current* state. The text is serialized now, so the
   * queue preserves the mutation order even when writes overlap.
   *
   * @returns {Promise<void>} resolution after this write landed.
   */
  function enqueueWrite() {
    if (disposed) return Promise.resolve()
    const text = serializeState(state)
    const write = () => writeStateFileAtomic(file, text)
    const task = writeChain.then(write, write)
    writeChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  return {
    /** Absolute state-file path this store persists to. */
    file,

    /**
     * @param {string} id - workspace id.
     * @returns {object | undefined} defensive copy of the record.
     */
    get(id) {
      return typeof id === 'string' && Object.hasOwn(records, id) ? cloneRecord(records[id]) : undefined
    },

    /** @returns {object[]} defensive copies in insertion order. */
    list() {
      return Object.values(records).map(cloneRecord)
    },

    /** @returns {{ version: number, workspaces: Record<string, object> }} defensive snapshot. */
    snapshot() {
      const workspaces = {}
      for (const [id, record] of Object.entries(records)) workspaces[id] = cloneRecord(record)
      return { version: STATE_VERSION, workspaces }
    },

    /**
     * @param {unknown} cwd - Session cwd.
     * @returns {object | undefined} defensive copy of the matching record.
     */
    findByCwd(cwd) {
      const key = normalizePathKey(cwd)
      if (key === '') return undefined
      const id = pathIndex.get(key)
      return id === undefined ? undefined : cloneRecord(records[id])
    },

    /**
     * Upsert one workspace record from a client `save` payload.
     *
     * @param {unknown} input - parsed POST body.
     * @returns {Promise<object>} the stored record (defensive copy).
     */
    async save(input) {
      const normalized = await normalizeWorkspaceInput(input, { realpath })
      const record = {
        id: normalized.id,
        path: normalized.path,
        roots: normalized.roots,
        updatedAt: new Date().toISOString(),
      }
      records[record.id] = record
      rebuildIndex()
      await enqueueWrite()
      return cloneRecord(record)
    },

    /**
     * Delete one workspace record.
     *
     * @param {string} id - workspace id.
     * @returns {Promise<{ id: string, removed: boolean }>} whether a record existed.
     */
    async remove(id) {
      if (!Object.hasOwn(records, id)) return { id, removed: false }
      delete records[id]
      rebuildIndex()
      await enqueueWrite()
      return { id, removed: true }
    },

    /**
     * Drop records whose workspace no longer exists in the DSH registry.
     *
     * @param {readonly string[] | undefined} ids - live workspace ids.
     * @returns {Promise<number>} number of dropped records.
     */
    async syncWithWorkspaceIds(ids) {
      if (!Array.isArray(ids)) return 0
      const live = new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))
      let removed = 0
      for (const id of Object.keys(records)) {
        if (live.has(id)) continue
        delete records[id]
        removed += 1
      }
      if (removed === 0) return 0
      rebuildIndex()
      try {
        await enqueueWrite()
      } catch (error) {
        warn(`multi-workspace: cannot persist pruned state: ${describeError(error)}`)
      }
      return removed
    },

    /** Stop accepting writes (plugin unload). */
    dispose() {
      disposed = true
    },
  }
}

/**
 * Build the JSON `Response` for one Fetch-route result.
 *
 * @param {unknown} payload - JSON-serializable body.
 * @param {number} [status] - HTTP status.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {Response} the response.
 */
function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/**
 * Build one 400 error response.
 *
 * @param {string} code - stable error code.
 * @param {string} message - explanation.
 * @returns {Response} the response.
 */
function errorResponse(code, message) {
  return jsonResponse({ ok: false, error: { code, message } }, 400)
}

/**
 * Handle `GET`: optionally prune deleted workspaces, then return the state.
 *
 * @param {object} store - state store.
 * @param {() => (readonly string[] | undefined)} [getWorkspaceIds] - live-id reader.
 * @returns {Promise<Response>} the response.
 */
async function handleGet(store, getWorkspaceIds) {
  if (typeof getWorkspaceIds === 'function') {
    try {
      const ids = getWorkspaceIds()
      if (Array.isArray(ids)) await store.syncWithWorkspaceIds(ids)
    } catch {
      // Pruning is best-effort; a broken registry must not fail the read.
    }
  }
  return jsonResponse({ ok: true, value: store.snapshot() })
}

/**
 * Handle `POST`: apply one `save` / `remove` operation.
 *
 * @param {object} store - state store.
 * @param {Request} request - buffered request.
 * @returns {Promise<Response>} the response.
 */
async function handlePost(store, request) {
  let body
  try {
    body = await request.json()
  } catch {
    throw new RequestError('invalid-json', 'request body must be valid JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('invalid-body', 'request body must be a JSON object')
  }
  switch (body.op) {
    case 'save': {
      const value = await store.save(body)
      return jsonResponse({ ok: true, value })
    }
    case 'remove': {
      const value = await store.remove(validateId(body.id))
      return jsonResponse({ ok: true, value })
    }
    default:
      throw new RequestError('invalid-op', 'op must be "save" or "remove"')
  }
}

/**
 * Build the exact Fetch route registered on `ctx.connection.fetch`.
 *
 * Contract (0.2.1-rc.2 `HostConnectionFetch.register`): the path must stay
 * under `/api` with a single-segment namespace, `methods` must be non-empty and
 * unique, `requestBody` describes buffering, and `fetch` resolves a `Response`.
 * The dispatcher authenticates the browser cookie and requires the owner
 * principal before calling `fetch`, so non-owner/unauthenticated callers never
 * reach this handler.
 *
 * @param {object} store - state store.
 * @param {{ getWorkspaceIds?: () => (readonly string[] | undefined) }} [options] - live-id reader.
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }} route.
 */
export function createFetchRoute(store, options = {}) {
  const getWorkspaceIds = typeof options.getWorkspaceIds === 'function' ? options.getWorkspaceIds : undefined
  return {
    path: ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let method = 'GET'
      try {
        method = String(request?.method ?? 'GET').toUpperCase()
      } catch {
        method = 'GET'
      }
      try {
        if (method === 'GET') return await handleGet(store, getWorkspaceIds)
        if (method === 'POST') return await handlePost(store, request)
        return jsonResponse({ ok: false, error: { code: 'method-not-allowed', message: `${method} is not supported by ${ROUTE_PATH}` } }, 405, { allow: 'GET, POST' })
      } catch (error) {
        if (error instanceof RequestError) return errorResponse(error.code, error.message)
        return jsonResponse({ ok: false, error: { code: 'internal-error', message: describeError(error) } }, 500)
      }
    },
  }
}

/**
 * Register the Host half on one Cordis plugin context.
 *
 * Every registration is captured and released through a single `ctx.effect`
 * composite disposer, so unload/reinstall is idempotent: the composite runs
 * first, each stored disposer runs at most once, and the service-owned effects
 * registered inside `register()` / `section()` are no-ops when their own
 * teardown follows.
 *
 * @param {object} ctx - Cordis plugin context (services `connection` and `systemPrompt` injected).
 * @returns {void}
 */
export function apply(ctx) {
  const warn = createWarningSink(ctx)
  const store = createStateStore({
    file: stateFilePath(resolveDshHome()),
    warn,
  })

  const disposers = []
  let disposed = false
  /**
   * Track one registration disposer; it runs at most once.
   *
   * @param {unknown} disposer - value returned by the service registration.
   */
  function track(disposer) {
    if (typeof disposer !== 'function') return
    let done = false
    disposers.push(() => {
      if (done) return
      done = true
      try {
        disposer()
      } catch (error) {
        warn(`multi-workspace: registration cleanup failed: ${describeError(error)}`)
      }
    })
  }

  const fetchRegistry = ctx?.connection?.fetch
  if (fetchRegistry === undefined || fetchRegistry === null || typeof fetchRegistry.register !== 'function') {
    warn('multi-workspace: ctx.connection.fetch is unavailable; the browser state route was not registered')
  } else {
    track(
      fetchRegistry.register(
        createFetchRoute(store, {
          getWorkspaceIds: () => readWorkspaceIds(ctx),
        }),
      ),
    )
  }

  const promptRegistry = ctx?.systemPrompt
  if (promptRegistry === undefined || promptRegistry === null || typeof promptRegistry.section !== 'function') {
    warn('multi-workspace: ctx.systemPrompt is unavailable; the workspace prompt section was not registered')
  } else {
    track(
      promptRegistry.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: (context) => {
          try {
            return renderPromptForContext(store, context)
          } catch {
            // A prompt contribution must never fail an assembly.
            return ''
          }
        },
      }),
    )
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => () => {
        if (disposed) return
        disposed = true
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
        disposers.length = 0
        store.dispose()
      },
      'multi-workspace: Host half registrations',
    )
  }
}
