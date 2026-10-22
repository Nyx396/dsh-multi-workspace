/**
 * Host-half unit tests for dsh-multi-workspace.
 *
 * Run with: "C:\Program Files\nodejs\node.exe" --test test/host.test.mjs
 *
 * The suite is fully offline and never touches the real DSH home:
 * every test creates its own temporary DSH_HOME (and folder fixtures) under the
 * OS temp directory, points `process.env.DSH_HOME` at it, and removes it after.
 *
 * `lib/index.js` is loaded through a `data:` URL instead of a normal file import
 * so this test does not depend on the Lead-owned `package.json` (`type`), and so
 * each import can be isolated. The plugin imports `node:` builtins only, which
 * is exactly what makes that loading strategy valid — a dedicated test asserts
 * the import surface stays clean.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_FILE = fileURLToPath(import.meta.url)
const PLUGIN_FILE = path.resolve(path.dirname(TEST_FILE), '..', 'lib', 'index.js')
const ROUTE_URL = 'http://127.0.0.1/api/multi-workspace/state'
const WINDOWS = process.platform === 'win32'

const PROMPT_HEADER = 'This Session belongs to a multi-folder Workspace. Member folders (absolute paths):'
const PROMPT_FOOTER =
  'You may read and search files in every member folder with absolute paths. The Session workspace root is the primary folder; writing or editing outside it is allowed only through the normal sandbox escalation (`sandbox_permissions`), which asks the user for approval. Do not treat the other folders as missing or outside the project.'

let importGeneration = 0

/**
 * Import the plugin from its source text through an isolated `data:` URL.
 *
 * @returns {Promise<object>} the plugin module namespace.
 */
async function loadPlugin() {
  const source = await fsp.readFile(PLUGIN_FILE, 'utf8')
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  importGeneration += 1
  return import(`data:text/javascript;base64,${encoded}#${importGeneration}`)
}

const plugin = await loadPlugin()

/**
 * Create an isolated harness: temp root, temp DSH_HOME and three real folders.
 *
 * @param {string} label - short label used in the temp directory name.
 * @returns {Promise<object>} harness paths.
 */
async function makeHarness(label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dsh-mw-host-${label}-`))
  const dshHome = path.join(root, 'dsh-home')
  const folders = path.join(root, 'folders')
  const primary = path.join(folders, 'primary folder 主')
  const memberA = path.join(folders, 'member-a')
  const memberB = path.join(folders, 'member-b 副')
  await fsp.mkdir(dshHome, { recursive: true })
  await Promise.all([
    fsp.mkdir(primary, { recursive: true }),
    fsp.mkdir(memberA, { recursive: true }),
    fsp.mkdir(memberB, { recursive: true }),
  ])
  return { root, dshHome, folders, primary, memberA, memberB }
}

/**
 * Run one callback with `DSH_HOME` pointing at a temporary harness home.
 *
 * @template T
 * @param {string} dshHome - temporary home directory.
 * @param {() => T | Promise<T>} run - callback.
 * @returns {Promise<T>} callback result.
 */
async function withDshHome(dshHome, run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/**
 * Minimal Cordis-like context: records registrations and mirrors `ctx.effect`
 * semantics (execute immediately, collected disposers run in reverse once).
 *
 * @param {{ services?: Record<string, unknown>, logger?: unknown }} [options] - extra services.
 * @returns {object} fake context.
 */
function createFakeCtx(options = {}) {
  const effects = []
  const routes = []
  const routeDisposers = []
  const sections = []
  const sectionDisposers = []
  const ctx = {
    logger: options.logger,
    effects,
    routes,
    routeDisposers,
    sections,
    sectionDisposers,
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          let done = false
          return () => {
            if (done) return
            done = true
            routeDisposers.push(route)
          }
        },
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        let done = false
        return () => {
          if (done) return
          done = true
          sectionDisposers.push(section)
        }
      },
    },
    get(name) {
      if (options.services && Object.hasOwn(options.services, name)) return options.services[name]
      return undefined
    },
    effect(execute, label) {
      const disposer = execute()
      let done = false
      const wrapped = () => {
        if (done) return
        done = true
        return typeof disposer === 'function' ? disposer() : undefined
      }
      effects.push({ label, disposer: wrapped })
      return wrapped
    },
    dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index].disposer()
    },
  }
  return ctx
}

/**
 * Apply the plugin under a temporary home with a fake context.
 *
 * @param {object} harness - temp harness.
 * @param {{ services?: Record<string, unknown>, logger?: unknown }} [ctxOptions] - fake-ctx options.
 * @returns {Promise<object>} the fake context.
 */
function startHost(harness, ctxOptions = {}) {
  return withDshHome(harness.dshHome, () => {
    const ctx = createFakeCtx(ctxOptions)
    plugin.apply(ctx)
    return ctx
  })
}

/**
 * @param {object} route - registered Fetch route.
 * @returns {Promise<Response>} GET response.
 */
function getState(route) {
  return route.fetch(new Request(ROUTE_URL, { method: 'GET' }))
}

/**
 * @param {object} route - registered Fetch route.
 * @param {unknown} body - object or raw string body.
 * @returns {Promise<Response>} POST response.
 */
function postState(route, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return route.fetch(
    new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    }),
  )
}

/**
 * @param {Response} response - response to read.
 * @returns {Promise<{ status: number, headers: Headers, body: any }>} status + parsed JSON.
 */
async function readJson(response) {
  return { status: response.status, headers: response.headers, body: await response.json() }
}

/**
 * Assert one 400 response with a stable error code.
 *
 * @param {Response} response - response.
 * @param {string} code - expected error code.
 * @returns {Promise<void>} resolution after assertions.
 */
async function assertBadRequest(response, code) {
  const parsed = await readJson(response)
  assert.equal(parsed.status, 400)
  assert.equal(parsed.body.ok, false)
  assert.equal(parsed.body.error.code, code)
  assert.equal(typeof parsed.body.error.message, 'string')
}

/**
 * @param {string} target - folder path.
 * @returns {Promise<string>} folded real path.
 */
async function realKey(target) {
  return plugin.normalizePathKey(await fsp.realpath(target))
}

/**
 * Build a prompt-assembly context for one Session cwd.
 *
 * @param {unknown} cwd - Session `header.cwd`.
 * @returns {object} assembly context.
 */
function sessionContext(cwd) {
  return { agent: { id: 'session-1', session: { header: { cwd } } }, scope: {} }
}

test('module exports the Host plugin contract and imports node: builtins only', async () => {
  const source = await fsp.readFile(PLUGIN_FILE, 'utf8')
  const specifiers = [...source.matchAll(/^import\s+(?:(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"])/gm)].map((match) => match[1])
  assert.ok(specifiers.length > 0, 'expected at least one import')
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'), `plugin must import node: builtins only, found ${specifier}`)
    assert.equal(specifier.startsWith('@deepseek-ai/'), false, `plugin must not import ${specifier}`)
  }
  assert.equal(/require\(\s*['"]@deepseek-ai\//.test(source), false, 'must never require @deepseek-ai/* packages')

  assert.equal(plugin.name, 'dsh-multi-workspace')
  assert.deepEqual(plugin.inject, ['connection', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal('Config' in plugin, false, 'the plugin must not declare a Config schema')
  assert.equal(plugin.ROUTE_PATH, '/api/multi-workspace/state')
  assert.equal(plugin.SECTION_NAME, 'multi-workspace:roots')
  assert.equal(plugin.SECTION_ORDER, 8000)
  assert.equal(plugin.STATE_VERSION, 1)
})

test('resolveDshHome honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(plugin.resolveDshHome({ DSH_HOME: '  D:\\custom home  ' }, 'C:\\Users\\x'), 'D:\\custom home')
  assert.equal(plugin.resolveDshHome({ DSH_HOME: '' }, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'))
  assert.equal(plugin.resolveDshHome({}, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'))
  assert.equal(plugin.resolveDshHome({ DSH_HOME: 42 }, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'))
  assert.equal(plugin.stateFilePath('D:\\dsh'), path.join(path.resolve('D:\\dsh'), 'multi-workspace', 'state.json'))
})

test('normalizePathKey folds separators, trailing separators and (on Windows) case', () => {
  assert.equal(plugin.normalizePathKey(''), '')
  assert.equal(plugin.normalizePathKey(undefined), '')
  assert.equal(plugin.normalizePathKey(42), '')
  if (WINDOWS) {
    assert.equal(plugin.normalizePathKey('C:/Foo/Bar/'), plugin.normalizePathKey('c:\\foo\\bar'))
    assert.equal(plugin.normalizePathKey('C:\\Foo\\'), 'c:\\foo')
    assert.equal(plugin.normalizePathKey('C:\\'), 'c:\\')
  } else {
    assert.equal(plugin.normalizePathKey('/Foo/Bar/'), '/Foo/Bar')
    assert.notEqual(plugin.normalizePathKey('/Foo'), plugin.normalizePathKey('/foo'))
  }
})

test('GET returns the documented envelope and registers the exact Fetch route', async (t) => {
  const harness = await makeHarness('get')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)

  assert.equal(ctx.routes.length, 1)
  const route = ctx.routes[0]
  assert.equal(route.path, '/api/multi-workspace/state')
  assert.equal(route.path.startsWith('/api/'), true)
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')

  const response = await getState(route)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.deepEqual(body, { ok: true, value: { version: 1, workspaces: {} } })

  // Nothing is written before the first successful mutation.
  await assert.rejects(fsp.access(plugin.stateFilePath(harness.dshHome)))

  // The registered prompt section carries the documented identity.
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'multi-workspace:roots')
  assert.equal(ctx.sections[0].order, 8000)
  assert.equal(ctx.sections[0].interpolate, false)
  assert.equal(typeof ctx.sections[0].text, 'function')
})

test('save canonicalizes paths, drops duplicate/primary roots and persists atomically', async (t) => {
  const harness = await makeHarness('save')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]

  const before = await getState(route).then(readJson)
  const response = await postState(route, {
    op: 'save',
    id: 'ws-1',
    name: 'ignored display name',
    path: harness.primary,
    roots: [harness.primary, harness.memberA, `${harness.memberA}${path.sep}`, harness.memberB],
  })
  const saved = await readJson(response)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.deepEqual(Object.keys(saved.body.value).sort(), ['id', 'path', 'roots', 'updatedAt'])
  assert.equal(saved.body.value.id, 'ws-1')
  assert.equal('name' in saved.body.value, false, 'name is accepted but never persisted')
  assert.equal(plugin.normalizePathKey(saved.body.value.path), plugin.normalizePathKey(await fsp.realpath(harness.primary)))
  assert.equal(saved.body.value.roots.length, 2, 'primary and duplicate roots are removed')
  assert.equal(plugin.normalizePathKey(saved.body.value.roots[0]), await realKey(harness.memberA))
  assert.equal(plugin.normalizePathKey(saved.body.value.roots[1]), await realKey(harness.memberB))
  assert.equal(Number.isNaN(Date.parse(saved.body.value.updatedAt)), false)

  const after = await getState(route).then(readJson)
  assert.deepEqual(after.body.value.workspaces['ws-1'], saved.body.value)
  assert.notDeepEqual(after.body.value, before.body.value)

  // The on-disk document is the supported shape, and no temporary file remains.
  const file = plugin.stateFilePath(harness.dshHome)
  const document = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.deepEqual(Object.keys(document.workspaces), ['ws-1'])
  assert.equal(document.workspaces['ws-1'].roots.length, 2)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['state.json'])

  // Overwriting the same workspace id replaces the record in place.
  const replaced = await readJson(
    await postState(route, { op: 'save', id: 'ws-1', path: harness.primary, roots: [harness.memberB] }),
  )
  assert.equal(replaced.status, 200)
  assert.equal(replaced.body.value.roots.length, 1)
  assert.deepEqual(Object.keys((await getState(route).then(readJson)).body.value.workspaces), ['ws-1'])
})

test('save accepts a path that cannot be realpath-ed and keeps its spelling', async (t) => {
  const harness = await makeHarness('missing')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]
  const missing = path.join(harness.folders, 'not-created-yet')
  const saved = await readJson(await postState(route, { op: 'save', id: 'ws-missing', path: missing, roots: [] }))
  assert.equal(saved.status, 200)
  assert.equal(plugin.normalizePathKey(saved.body.value.path), plugin.normalizePathKey(missing))
  assert.deepEqual(saved.body.value.roots, [])
})

test('save rejects malformed payloads with HTTP 400 and leaves state untouched', async (t) => {
  const harness = await makeHarness('invalid')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]

  const cases = [
    ['{', 'invalid-json'],
    ['null', 'invalid-body'],
    ['[]', 'invalid-body'],
    [{ op: 'nope', id: 'ws-1', path: harness.primary }, 'invalid-op'],
    [{ op: 'save', path: harness.primary }, 'invalid-id'],
    [{ op: 'save', id: '   ', path: harness.primary }, 'invalid-id'],
    [{ op: 'save', id: 'ws-1', path: '' }, 'invalid-path'],
    [{ op: 'save', id: 'ws-1', path: 42 }, 'invalid-path'],
    [{ op: 'save', id: 'ws-1', path: 'relative\\folder' }, 'invalid-path'],
    [{ op: 'save', id: 'ws-1', path: harness.primary, roots: 'not-an-array' }, 'invalid-roots'],
    [{ op: 'save', id: 'ws-1', path: harness.primary, roots: [''] }, 'invalid-roots'],
    [{ op: 'save', id: 'ws-1', path: harness.primary, roots: ['relative'] }, 'invalid-roots'],
  ]
  for (const [body, code] of cases) {
    await assertBadRequest(await postState(route, body), code)
  }

  const state = await getState(route).then(readJson)
  assert.deepEqual(state.body.value.workspaces, {})
  await assert.rejects(fsp.access(plugin.stateFilePath(harness.dshHome)), 'no file may be written for rejected payloads')
})

test('remove deletes one record and is idempotent for unknown ids', async (t) => {
  const harness = await makeHarness('remove')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]

  await postState(route, { op: 'save', id: 'ws-a', path: harness.primary, roots: [harness.memberA] })
  await postState(route, { op: 'save', id: 'ws-b', path: harness.memberB, roots: [] })

  const removed = await readJson(await postState(route, { op: 'remove', id: 'ws-a' }))
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body, { ok: true, value: { id: 'ws-a', removed: true } })

  const missing = await readJson(await postState(route, { op: 'remove', id: 'ws-a' }))
  assert.deepEqual(missing.body, { ok: true, value: { id: 'ws-a', removed: false } })

  await assertBadRequest(await postState(route, { op: 'remove' }), 'invalid-id')

  const state = await getState(route).then(readJson)
  assert.deepEqual(Object.keys(state.body.value.workspaces), ['ws-b'])
  const document = JSON.parse(await fsp.readFile(plugin.stateFilePath(harness.dshHome), 'utf8'))
  assert.deepEqual(Object.keys(document.workspaces), ['ws-b'])
})

test('state survives a plugin restart (unload + reapply)', async (t) => {
  const harness = await makeHarness('restart')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))

  const first = await startHost(harness)
  const saved = await readJson(
    await postState(first.routes[0], { op: 'save', id: 'ws-persist', path: harness.primary, roots: [harness.memberA, harness.memberB] }),
  )
  assert.equal(saved.status, 200)
  first.dispose()

  const second = await startHost(harness)
  const state = await readJson(await getState(second.routes[0]))
  assert.deepEqual(state.body.value.workspaces['ws-persist'], saved.body.value)

  // The prompt section of the new instance also sees the restored record.
  const section = second.sections[0]
  const text = section.text(sessionContext(saved.body.value.path))
  assert.equal(text.split('\n')[1], `- ${saved.body.value.path} (primary folder of this Session)`)
})

test('prompt section lists every member folder for the matching Session', async (t) => {
  const harness = await makeHarness('prompt')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]
  const record = (await readJson(
    await postState(route, { op: 'save', id: 'ws-prompt', path: harness.primary, roots: [harness.memberA, harness.memberB] }),
  )).body.value

  const section = ctx.sections[0]
  assert.deepEqual(section.text(sessionContext(record.path)).split('\n'), [
    PROMPT_HEADER,
    `- ${record.path} (primary folder of this Session)`,
    `- ${record.roots[0]}`,
    `- ${record.roots[1]}`,
    PROMPT_FOOTER,
  ])
  assert.equal(section.text(sessionContext(record.path)).includes('sandbox_permissions'), true)

  // Trailing separators address the same folder.
  assert.notEqual(section.text(sessionContext(`${record.path}${path.sep}`)), '')

  if (WINDOWS) {
    // Windows cwd comparison is case-insensitive.
    const upper = record.path.toUpperCase()
    assert.notEqual(upper, record.path)
    assert.notEqual(section.text(sessionContext(upper)), '')
  }
})

test('prompt section stays empty (and never throws) when it does not apply', async (t) => {
  const harness = await makeHarness('prompt-miss')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]
  const section = ctx.sections[0]

  assert.equal(section.text(), '')
  assert.equal(section.text({}), '')
  assert.equal(section.text({ agent: {} }), '')
  assert.equal(section.text({ agent: { session: {} } }), '')
  assert.equal(section.text({ agent: { session: { header: {} } } }), '')
  assert.equal(section.text(sessionContext(42)), '')
  assert.equal(section.text(sessionContext(path.join(harness.folders, 'unrelated'))), '')
  assert.equal(
    section.text({
      get agent() {
        throw new Error('assembly context exploded')
      },
    }),
    '',
    'a throwing context must degrade to an empty section',
  )

  const record = (await readJson(
    await postState(route, { op: 'save', id: 'ws-single', path: harness.primary, roots: [] }),
  )).body.value
  assert.equal(section.text(sessionContext(record.path)), '', 'a single-folder workspace adds no section')

  await postState(route, { op: 'save', id: 'ws-multi', path: harness.memberA, roots: [harness.memberB] })
  assert.equal(section.text(sessionContext(record.path)), '', 'a single-folder record keeps contributing no section')
  assert.equal(section.text(sessionContext(harness.memberB)), '', 'member roots are not Session cwds')
  const realMemberA = await fsp.realpath(harness.memberA)
  assert.equal(
    section.text(sessionContext(harness.memberA)).split('\n')[1],
    `- ${realMemberA} (primary folder of this Session)`,
  )

  await postState(route, { op: 'remove', id: 'ws-single' })
  await postState(route, { op: 'remove', id: 'ws-multi' })
  assert.equal(section.text(sessionContext(record.path)), '')
})

test('GET prunes records whose DSH workspace no longer exists', async (t) => {
  const harness = await makeHarness('prune')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness, {
    services: {
      workspaceRegistry: {
        list: () => [{ id: 'ws-keep' }, { id: 'ws-new' }],
      },
    },
  })
  const route = ctx.routes[0]
  await postState(route, { op: 'save', id: 'ws-keep', path: harness.primary, roots: [harness.memberA] })
  await postState(route, { op: 'save', id: 'ws-drop', path: harness.memberB, roots: [] })

  const state = await getState(route).then(readJson)
  assert.deepEqual(Object.keys(state.body.value.workspaces), ['ws-keep'])
  const document = JSON.parse(await fsp.readFile(plugin.stateFilePath(harness.dshHome), 'utf8'))
  assert.deepEqual(Object.keys(document.workspaces), ['ws-keep'])

  // A second GET is stable (no spurious change).
  const again = await getState(route).then(readJson)
  assert.deepEqual(again.body.value, state.body.value)
})

test('GET keeps records when the workspace registry is missing, broken or unready', async (t) => {
  const harness = await makeHarness('registry-off')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))

  const withoutRegistry = await startHost(harness)
  await postState(withoutRegistry.routes[0], { op: 'save', id: 'ws-a', path: harness.primary, roots: [harness.memberA] })

  const brokenRegistry = await startHost(harness, {
    services: {
      workspaceRegistry: {
        list() {
          throw new Error('registry exploded')
        },
      },
    },
  })
  const brokenState = await getState(brokenRegistry.routes[0]).then(readJson)
  assert.equal(brokenState.status, 200)
  assert.deepEqual(Object.keys(brokenState.body.value.workspaces), ['ws-a'])

  const unreadyRegistry = await startHost(harness, {
    services: { workspaceRegistry: { list: () => undefined } },
  })
  const unreadyState = await getState(unreadyRegistry.routes[0]).then(readJson)
  assert.deepEqual(Object.keys(unreadyState.body.value.workspaces), ['ws-a'])
})

test('corrupt or foreign state files degrade to an empty state and are recoverable', async (t) => {
  const harness = await makeHarness('corrupt')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const file = plugin.stateFilePath(harness.dshHome)
  await fsp.mkdir(path.dirname(file), { recursive: true })

  for (const content of ['{ not json', JSON.stringify({ version: 99, workspaces: {} }), JSON.stringify({ workspaces: 'nope' })]) {
    await fsp.writeFile(file, content, 'utf8')
    const ctx = await startHost(harness)
    const state = await getState(ctx.routes[0]).then(readJson)
    assert.deepEqual(state.body.value.workspaces, {}, `expected empty state for ${content}`)
    ctx.dispose()
  }

  const ctx = await startHost(harness)
  const saved = await readJson(await postState(ctx.routes[0], { op: 'save', id: 'ws-fixed', path: harness.primary, roots: [harness.memberA] }))
  assert.equal(saved.status, 200)
  const document = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.deepEqual(Object.keys(document.workspaces), ['ws-fixed'])
})

test('concurrent saves are serialized and both survive', async (t) => {
  const harness = await makeHarness('concurrent')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]

  const [first, second] = await Promise.all([
    postState(route, { op: 'save', id: 'ws-1', path: harness.primary, roots: [harness.memberA] }),
    postState(route, { op: 'save', id: 'ws-2', path: harness.memberB, roots: [harness.memberA] }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  const state = await getState(route).then(readJson)
  assert.deepEqual(Object.keys(state.body.value.workspaces).sort(), ['ws-1', 'ws-2'])
  const document = JSON.parse(await fsp.readFile(plugin.stateFilePath(harness.dshHome), 'utf8'))
  assert.deepEqual(Object.keys(document.workspaces).sort(), ['ws-1', 'ws-2'])
})

test('unsupported methods answer 405 without touching state', async (t) => {
  const harness = await makeHarness('method')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)
  const route = ctx.routes[0]
  const response = await route.fetch(new Request(ROUTE_URL, { method: 'PUT', body: '{}' }))
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, POST')
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'method-not-allowed')
  await assert.rejects(fsp.access(plugin.stateFilePath(harness.dshHome)))
})

test('unload disposal is idempotent and releases both registrations', async (t) => {
  const harness = await makeHarness('dispose')
  t.after(() => fsp.rm(harness.root, { recursive: true, force: true }))
  const ctx = await startHost(harness)

  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.effects.length, 1)
  assert.equal(typeof ctx.effects[0].label, 'string')
  assert.match(ctx.effects[0].label, /multi-workspace/)

  ctx.dispose()
  ctx.dispose()
  ctx.effects[0].disposer()
  assert.equal(ctx.routeDisposers.length, 1)
  assert.equal(ctx.sectionDisposers.length, 1)
})

test('apply tolerates a context without the optional Host surface', () => {
  const registrations = []
  const minimal = {
    connection: {
      fetch: {
        register(route) {
          registrations.push(route)
          return () => {}
        },
      },
    },
    get: () => undefined,
  }
  assert.doesNotThrow(() => plugin.apply(minimal))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].path, '/api/multi-workspace/state')
})
