// Lightweight, dependency-free smoke test for the multi-workspace client UI.
//
// It concatenates the real client fragments exactly like tools/build-client.mjs
// does, evaluates them against a stub React renderer in a `vm` context, and
// checks: fragment syntax, required exports, locale completeness, CSS token
// discipline, pure path helpers and the rendered structure of the dialogs.
//
// Usage:
//   "C:\Program Files\nodejs\node.exe" dev/ui-smoke.mjs
//
// Exit code 0 means every assertion passed. No browser or network is needed.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const srcDir = join(root, 'src', 'client')
const fragments = readdirSync(srcDir)
  .filter((name) => name.endsWith('.js'))
  .sort((left, right) => left.localeCompare(right, 'en'))
const sources = new Map(fragments.map((name) => [name, readFileSync(join(srcDir, name), 'utf8')]))

const results = []
function check(name, run) {
  try {
    const detail = run()
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error && error.message ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}
function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message} (missing ${JSON.stringify(needle)})`)
}

// --- Stub React: enough hooks for one render pass, elements keep their props.
let idCounter = 0
const Fragment = Symbol('Fragment')
const ReactStub = {
  Fragment,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(callback) {
    return callback
  },
  useId() {
    idCounter += 1
    return 'smoke-' + idCounter
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}
const h = ReactStub.createElement
const createPortal = (node) => node
const documentStub = {
  body: { style: {} },
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll() {
    return []
  },
  createElement() {
    return { style: {}, dataset: {}, remove() {}, setAttribute() {} }
  },
}
const sandbox = {
  React: ReactStub,
  createPortal,
  h,
  Fragment,
  document: documentStub,
  requestAnimationFrame: (fn) => { fn(); return 1 },
  cancelAnimationFrame() {},
  AbortController,
  setTimeout,
  clearTimeout,
  console,
  fetch: async () => { throw new Error('network is not available in the smoke test') },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const probe = `
  return {
    MW_I18N_NS, MW_DICTS, MW_I18N_KEYS, mwI18nTranslator, mwI18nFormat,
    MW_CSS, Icon, Button, Modal,
    mwBrowserParentPath, mwBrowserSegments, mwBrowserJoin, mwBrowserKey,
    FolderBrowser, MwFolderRow,
    mwDlgMergeFolders, mwDlgKey, CreateWorkspaceDialog, ModifyWorkspaceDialog, OverlayHost,
    mwBasename, mwPathKey, mwErrorMessage, mwUiText,
    apply: typeof apply === 'function' ? apply : null,
    installWorkspaceMenuAction: typeof installWorkspaceMenuAction === 'function' ? installWorkspaceMenuAction : null,
  };
`
const body = fragments.map((name) => `//#region ${name}\n${sources.get(name).trimEnd()}\n//#endregion`).join('\n')
const bundle = `(function(React, createPortal, h, Fragment){\n'use strict';\n${body}\n${probe}\n})`
let api = null

// --- 1. The real fragments must parse and evaluate as one shared closure.
check('all client fragments parse and evaluate as one closure', () => {
  const factory = vm.runInContext(bundle, sandbox, { filename: 'mw-client-smoke.js' })
  api = factory(ReactStub, createPortal, h, Fragment)
  assert(api && typeof api === 'object', 'factory result is not an object')
  return `${fragments.length} fragments`
})

// --- 2. No fragment may use ESM syntax or top-level browser side effects.
check('fragments are plain script bodies (no import/export, no window access)', () => {
  for (const [name, source] of sources) {
    assert(!/^\s*(import|export)\s/m.test(source), `${name} contains an import/export statement`)
    assert(!/\bwindow\./.test(source), `${name} touches window at module level`)
  }
  return 'import/export none, window none'
})

// --- 3. Exports the wiring in 90-apply.js depends on.
check('required symbols are exported by the fragments', () => {
  const required = [
    'MW_DICTS', 'MW_CSS', 'Icon', 'Button', 'Modal', 'FolderBrowser',
    'CreateWorkspaceDialog', 'ModifyWorkspaceDialog', 'OverlayHost',
    'mwBrowserParentPath', 'mwBrowserJoin', 'mwBrowserSegments',
    'mwI18nTranslator', 'mwUiText', 'mwDlgMergeFolders',
  ]
  for (const name of required) assert(api[name] !== undefined, `missing symbol: ${name}`)
  assert(typeof api.apply === 'function', 'apply is not a function')
  return required.join(', ')
})

// --- 4. Locale dictionaries: same key set, expected wording, working formatter.
check('MW_DICTS.zh and MW_DICTS.en have identical key sets', () => {
  const zh = Object.keys(api.MW_DICTS.zh).sort()
  const en = Object.keys(api.MW_DICTS.en).sort()
  const missing = zh.filter((key) => !en.includes(key))
  const extra = en.filter((key) => !zh.includes(key))
  assertEqual(missing.length, 0, 'en is missing keys: ' + missing.join(', '))
  assertEqual(extra.length, 0, 'en has extra keys: ' + extra.join(', '))
  assertEqual(api.MW_I18N_KEYS.length, zh.length, 'MW_I18N_KEYS is out of sync')
  return zh.length + ' keys'
})

check('localized wording matches the product copy', () => {
  const zh = api.mwI18nTranslator('zh')
  const en = api.mwI18nTranslator('en')
  assertEqual(zh('dialog.create.title'), '创建工作区', 'zh dialog.create.title')
  assertEqual(zh('dialog.modify.title'), '修改工作区', 'zh dialog.modify.title')
  assertEqual(zh('field.name.placeholder'), '工作区名称', 'zh placeholder')
  assertEqual(zh('section.workspace'), '工作区信息', 'zh workspace section')
  assertEqual(zh('source.count', { n: 2 }), '2 个', 'zh folder count interpolation')
  assertEqual(zh('section.sourceFolder'), '源文件夹', 'zh section')
  assertEqual(zh('source.addPrompt'), '在此电脑上添加文件夹', 'zh add prompt')
  assertEqual(zh('badge.primary'), '主文件夹', 'zh primary badge')
  assertEqual(zh('browser.showHidden'), '显示隐藏文件夹', 'zh hidden toggle')
  assertEqual(zh('browser.selectedCount', { n: 2 }), '已选择 2 个文件夹', 'zh placeholder interpolation')
  assertEqual(zh('menu.modify'), '修改工作区', 'zh menu item')
  assertEqual(en('dialog.create.title'), 'New Workspace', 'en title')
  assertEqual(en('error.noFolder'), 'Add at least one folder', 'en error.noFolder')
  assertEqual(en('action.addSelected'), 'Add selected', 'en add selected')
  return 'zh/en copy verified'
})

// --- 5. Every key referenced by the fragments exists in both dictionaries.
check('every localization key used in the fragments exists in MW_DICTS', () => {
  const used = new Set()
  const pattern = /\b(?:t|translate)\(\s*(['"])([A-Za-z][\w.-]*)\1/g
  for (const source of sources.values()) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      if (match[2].includes('.')) used.add(match[2])
    }
  }
  assert(used.size > 20, 'too few localization keys discovered: ' + used.size)
  const missing = [...used].filter((key) => !(key in api.MW_DICTS.zh) || !(key in api.MW_DICTS.en))
  assertEqual(missing.length, 0, 'keys used but not defined: ' + missing.join(', '))
  return used.size + ' keys referenced'
})

// --- 6. CSS discipline: scoped workbench variables, host theme + a11y hooks.
check('MW_CSS scopes workbench styles and retains DSH theme adaptation', () => {
  const css = api.MW_CSS
  assert(typeof css === 'string' && css.length > 2000, 'MW_CSS is missing or suspiciously short')
  const classes = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1])
  // Host theme markers may scope a palette override; plugin classes stay mw-.
  const unprefixed = [...new Set(classes.filter((name) => !name.startsWith('mw-') && !['dark', 'light'].includes(name)))]
  assertEqual(unprefixed.length, 0, 'classes without the mw- prefix: ' + unprefixed.join(', '))
  const vars = [...css.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((match) => match[1])
  const foreign = [...new Set(vars.filter((name) => !name.startsWith('--dsw-') && !name.startsWith('--mw-')))]
  assertEqual(foreign.length, 0, 'custom properties outside --mw-* / --dsw-*: ' + foreign.join(', '))
  assert(vars.some((name) => name.startsWith('--mw-')), 'local workbench design variables are missing')
  assert(vars.some((name) => name.startsWith('--dsw-alias-')), 'DSH theme adaptation is missing')
  assert(/@media\s*\([^)]*max-width\s*:/.test(css), 'narrow-window layout guard is missing')
  assert(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(css), 'reduced-motion media query is missing')
  assert(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/.test(css), 'forced-colors media query is missing')
  return `${new Set(classes).size} classes, ${new Set(vars).size} tokens`
})

// --- 7. Pure path helpers used by the folder browser and the dialogs.
check('browser path helpers cover Windows and POSIX roots', () => {
  assertEqual(api.mwBrowserParentPath('D:\\Work\\Demo', '\\'), 'D:\\Work', 'windows parent')
  assertEqual(api.mwBrowserParentPath('D:\\Work', '\\'), 'D:\\', 'windows drive parent')
  assertEqual(api.mwBrowserParentPath('D:\\', '\\'), undefined, 'drive root has no parent')
  assertEqual(api.mwBrowserParentPath('/home/user', '/'), '/home', 'posix parent')
  assertEqual(api.mwBrowserParentPath('/home', '/'), '/', 'posix root parent')
  assertEqual(api.mwBrowserJoin('D:\\Work', 'Demo', '\\'), 'D:\\Work\\Demo', 'join below a folder')
  assertEqual(api.mwBrowserJoin('D:\\', 'Demo', '\\'), 'D:\\Demo', 'join at a drive root')
  assertEqual(api.mwBrowserJoin('D:\\Work\\', 'Demo', '\\'), 'D:\\Work\\Demo', 'join strips trailing separator')
  const win = api.mwBrowserSegments('D:\\Work\\Demo', '\\')
  assertEqual(win.map((part) => part.label).join('|'), 'D:|Work|Demo', 'windows breadcrumb labels')
  assertEqual(win[2].path, 'D:\\Work\\Demo', 'windows breadcrumb path')
  const posix = api.mwBrowserSegments('/home/user', '/')
  assertEqual(posix.map((part) => part.label).join('|'), 'home|user', 'posix breadcrumb labels')
  assertEqual(posix[1].path, '/home/user', 'posix breadcrumb path')
  assertEqual(api.mwBrowserKey('D:\\Work\\Demo'), 'd:\\work\\demo', 'selection dedupe key')
  return 'parent/join/segments/key'
})

check('dialog folder merge dedupes case-insensitively and keeps order', () => {
  const merged = api.mwDlgMergeFolders(['D:\\One'], ['D:/one', 'E:\\Two', 'E:\\Two', '', null])
  assertEqual(merged.length, 2, 'merged folder count')
  assertEqual(merged[0], 'D:\\One', 'first folder kept as primary')
  assertEqual(merged[1], 'E:\\Two', 'new folder appended')
  assertEqual(api.mwBasename('D:\\Work\\Demo'), 'Demo', 'basename helper from 10-api')
  return 'merge + basename'
})

// --- 8. Render helpers: expand function components using the stub hooks.
function evaluate(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(evaluate).filter((item) => item !== null)
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    return evaluate(type({ ...props }))
  }
  if (type === Fragment) return evaluate(props.children)
  return { type, props: { ...props, children: evaluate(props.children) } }
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props ? node.props.children : null)
}
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (typeof node === 'string') return out
  if (predicate(node)) out.push(node)
  findAll(node.props ? node.props.children : null, predicate, out)
  return out
}
const render = (Component, props) => evaluate(h(Component, props))
const buttonTexts = (tree) => findAll(tree, (node) => node.type === 'button').map((node) => textOf(node.props.children)).filter(Boolean)

// --- 9. Create dialog: workspace information, overview and empty selection.
check('CreateWorkspaceDialog renders workspace sections and disables empty submission', () => {
  const tree = render(api.CreateWorkspaceDialog, {
    dialog: { mode: 'create', workspace: null, flow: null },
    actions: {},
    t: undefined,
  })
  const text = textOf(tree)
  for (const needle of ['创建工作区', '工作区信息', '工作区概览', '源文件夹', '0 个', '在此电脑上添加文件夹', '取消', '创建', '添加']) {
    assertIncludes(text, needle, 'create dialog text')
  }
  const dialogs = findAll(tree, (node) => node.props && node.props.role === 'dialog')
  assertEqual(dialogs.length, 1, 'exactly one role=dialog')
  assertEqual(dialogs[0].props['aria-modal'], 'true', 'aria-modal on the dialog')
  assert(dialogs[0].props['aria-labelledby'], 'dialog has aria-labelledby')
  assertEqual(dialogs[0].props.tabIndex, -1, 'dialog is focusable programmatically')
  const labels = findAll(tree, (node) => node.type === 'input').map((node) => node.props['aria-label'] || node.props.placeholder)
  assert(labels.includes('工作区名称'), 'name input is labelled')
  const create = findAll(tree, (node) => node.type === 'button' && textOf(node.props.children) === '创建')
  assertEqual(create.length, 1, 'one Create button')
  assertEqual(create[0].props.disabled, true, 'Create is disabled without folders')
  assertEqual(buttonTexts(tree).filter((label) => label.includes('关闭')).length, 0, 'close button is icon-only with aria-label')
  return 'workspace sections, folder count, labelled name, empty prompt, disabled submit'
})

// --- 10. Modify dialog structure with the prefilled workspace.
check('ModifyWorkspaceDialog prefills name and primary folder', () => {
  const workspace = { workspaceId: 'ws-1', title: '演示工作区', path: 'D:\\Work\\Demo' }
  const tree = render(api.ModifyWorkspaceDialog, {
    dialog: { mode: 'modify', workspace, flow: null },
    actions: {},
    t: undefined,
  })
  const text = textOf(tree)
  for (const needle of ['修改工作区', '工作区信息', '工作区概览', 'D:\\Work\\Demo', '主文件夹', '1 个', '保存', '取消', '源文件夹']) {
    assertIncludes(text, needle, 'modify dialog text')
  }
  const nameInput = findAll(tree, (node) => node.type === 'input' && node.props['aria-label'] === '工作区名称')
  assertEqual(nameInput.length, 1, 'name input present')
  assertEqual(nameInput[0].props.value, '演示工作区', 'name prefilled from the workspace title')
  const save = findAll(tree, (node) => node.type === 'button' && textOf(node.props.children) === '保存')
  assertEqual(save.length, 1, 'one Save button')
  assertEqual(save[0].props.disabled, false, 'Save is enabled with one folder')
  const removeButtons = findAll(tree, (node) => node.type === 'button' && String(node.props['aria-label'] || '').startsWith('移除文件夹'))
  assertEqual(removeButtons.length, 0, 'the primary folder has no remove button')
  return 'prefilled name, fixed primary folder, Save enabled'
})

// --- 11. FolderBrowser open/closed and initial structure.
check('FolderBrowser is closed without an open flag and renders when opened', () => {
  assertEqual(render(api.FolderBrowser, { open: false }), null, 'closed browser renders null')
  const tree = render(api.FolderBrowser, {
    open: true,
    initialPath: 'D:\\Work',
    listDirectory: async () => ({ home: 'D:\\', separator: '\\', entries: [] }),
    createDirectory: async () => undefined,
    onClose: () => {},
    onConfirm: () => {},
    t: undefined,
  })
  const text = textOf(tree)
  for (const needle of ['添加文件夹', '新建文件夹', '显示隐藏文件夹', '添加所选', '取消']) {
    assertIncludes(text, needle, 'folder browser text')
  }
  const crumbs = findAll(tree, (node) => node.type === 'button' && node.props['aria-current'] === 'page')
  assertEqual(crumbs.length, 1, 'current breadcrumb is marked')
  assertEqual(textOf(crumbs[0].props.children), 'Work', 'current breadcrumb label')
  const inputs = findAll(tree, (node) => node.type === 'input')
  const pathInput = inputs.find((node) => node.props['aria-label'] === '路径')
  assert(pathInput, 'path input is rendered and labelled')
  assertEqual(pathInput.props.value, 'D:\\Work', 'path input shows the initial path')
  const addSelected = findAll(tree, (node) => node.type === 'button' && textOf(node.props.children) === '添加所选')
  assertEqual(addSelected.length, 1, 'one Add selected button')
  assertEqual(addSelected[0].props.disabled, true, 'Add selected is disabled without a selection')
  const dialogs = findAll(tree, (node) => node.props && node.props.role === 'dialog')
  assertEqual(dialogs.length, 1, 'browser has one role=dialog')
  return 'closed null, opened layout, breadcrumb, labelled path input'
})

// --- 12. OverlayHost reads the shared store and renders the right dialog.
check('OverlayHost reacts to the shared store snapshot', () => {
  const emptyStore = { subscribe: () => () => {}, getSnapshot: () => ({ dialog: null }) }
  assertEqual(render(api.OverlayHost, { store: emptyStore, actions: {}, t: undefined }), null, 'no dialog renders nothing')
  const createStore = { subscribe: () => () => {}, getSnapshot: () => ({ dialog: { mode: 'create', workspace: null, flow: null } }) }
  assertIncludes(textOf(render(api.OverlayHost, { store: createStore, actions: {}, t: undefined })), '创建工作区', 'create dialog through OverlayHost')
  const modifyStore = {
    subscribe: () => () => {},
    getSnapshot: () => ({ dialog: { mode: 'modify', workspace: { workspaceId: 'w', title: '改', path: 'E:\\X' }, flow: null } }),
  }
  assertIncludes(textOf(render(api.OverlayHost, { store: modifyStore, actions: {}, t: undefined })), '修改工作区', 'modify dialog through OverlayHost')
  return 'null snapshot, create mode, modify mode'
})

// --- 13. Toolbar/menu integration points exist (apply and the menu install).
check('90-apply and 50-menu exports are reachable from the bundle', () => {
  assert(typeof api.apply === 'function', 'apply missing')
  if (api.installWorkspaceMenuAction !== null) {
    assert(typeof api.installWorkspaceMenuAction === 'function', 'installWorkspaceMenuAction is not a function')
    return 'apply + menu augmentation present'
  }
  return 'apply present (50-menu.js not delivered yet)'
})

// --- Report.
console.log('== dsh-multi-workspace UI smoke ==')
console.log('node ' + process.version + ' | fragments: ' + fragments.join(', '))
let failed = 0
for (const row of results) {
  if (row.ok) console.log('[PASS] ' + row.name + (row.detail ? ' — ' + row.detail : ''))
  else {
    failed += 1
    console.log('[FAIL] ' + row.name + ' — ' + row.detail)
  }
}
console.log('')
console.log((results.length - failed) + ' passed, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
