/**
 * Automated verification for the dsh-multi-workspace client half.
 *
 * Strategy:
 *  1. `node tools/build-client.mjs` regenerates `lib/client.js` from
 *     `src/client/*.js` (skipped while the integration is still in progress).
 *  2. The bundle is evaluated inside a `node:vm` context whose `window` equals
 *     the sandbox global, so `window.__ModuleLoader__.load({id, factory})` is
 *     captured exactly like the DSH browser module system does it.
 *  3. `require('react')` / `require('react-dom')` are minimal but runnable
 *     stubs: `createElement` returns a vnode-shaped object, hooks are callable,
 *     `createPortal` is inert. No rendering library is needed.
 *  4. A fake Cordis client context records `slots.inject` / `slots.register`,
 *     `locale.register`, `ctx.effect` disposers and the client services
 *     (`workspaces`, `uiWorkspace`, `locale`) so the wiring can be asserted.
 *  5. Pure helpers from `src/client/10-api.js` are loaded directly in a small
 *     vm sandbox (they are closure functions, not module exports), which keeps
 *     the API behavior covered independently of the bundle.
 *
 * Run:
 *   & "C:\Program Files\nodejs\node.exe" --test test/client.test.mjs
 * While other members are still writing sources every bundle test is skipped
 * with an explicit message. Set MW_STRICT=1 to turn "integration pending" into
 * hard failures (used for the final acceptance run).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '..');
const srcDir = path.join(rootDir, 'src', 'client');
const bundlePath = path.join(rootDir, 'lib', 'client.js');
const buildScript = path.join(rootDir, 'tools', 'build-client.mjs');
const apiFragment = path.join(srcDir, '10-api.js');
const i18nFragment = path.join(srcDir, '15-i18n.js');
const menuFragment = path.join(srcDir, '50-menu.js');

const EXPECTED_FRAGMENTS = [
  '10-api.js',
  '15-i18n.js',
  '20-ui-kit.js',
  '30-browser.js',
  '40-dialogs.js',
  '50-menu.js',
  '90-apply.js',
];

const STRICT = process.env.MW_STRICT === '1';
const exists = (file) => fs.existsSync(file);
const readText = (file) => fs.readFileSync(file, 'utf8');
/** false when ready; otherwise the skip reason (or false in strict mode). */
const skipUnless = (ready, reason) => (ready || STRICT ? false : reason);
const toHost = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const srcFiles = exists(srcDir) ? fs.readdirSync(srcDir).filter((name) => name.endsWith('.js')) : [];
const missingFragments = EXPECTED_FRAGMENTS.filter((name) => !srcFiles.includes(name));
const integrationReady = exists(buildScript) && missingFragments.length === 0;

/**
 * Regenerate the bundle once, before any test needs it. Only when every
 * fragment is present: an incomplete build would overwrite the artifact other
 * members depend on with a half-integrated bundle.
 */
const build = { attempted: false, ok: false, output: '', error: '' };
if (integrationReady) {
  build.attempted = true;
  try {
    build.output = execFileSync(process.execPath, [buildScript], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    build.ok = true;
  } catch (error) {
    build.error = String((error && error.stderr) || '') + String((error && error.message) || error);
  }
}
const bundleReady = exists(bundlePath);
const bundleUsable = bundleReady && (build.ok || !build.attempted);
let bundleReason = null;
if (!bundleUsable) {
  if (!exists(buildScript)) bundleReason = 'tools/build-client.mjs is missing (integration pending)';
  else if (missingFragments.length > 0) bundleReason = 'waiting for integration; missing fragments: ' + missingFragments.join(', ');
  else if (build.attempted && !build.ok) bundleReason = 'build-client.mjs failed; fix the build first';
  else bundleReason = 'lib/client.js is missing';
}
const bundleSkip = skipUnless(bundleUsable, bundleReason);

// ---------------------------------------------------------------------------
// Minimal browser environment (document / window / observers / fetch)
// ---------------------------------------------------------------------------

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle: (name, force) => {
      const on = force === undefined ? !values.has(name) : Boolean(force);
      if (on) values.add(name);
      else values.delete(name);
      return on;
    },
    contains: (name) => values.has(name),
  };
}

function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function createEventClass() {
  class StubEvent {
    constructor(type, init) {
      this.type = String(type);
      this.bubbles = Boolean(init && init.bubbles);
      this.cancelable = Boolean(init && init.cancelable);
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      if (init && typeof init === 'object') Object.assign(this, init);
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {}
  }
  return StubEvent;
}

function createDomHarness() {
  const documentListeners = new Map();
  const observers = [];
  const windowListeners = new Map();

  function makeElement(tag) {
    const attributes = new Map();
    const elementListeners = new Map();
    const el = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      style: {
        cssText: '',
        setProperty() {},
        removeProperty() {},
        getPropertyValue() {
          return '';
        },
        getPropertyPriority() {
          return '';
        },
        item() {
          return '';
        },
        length: 0,
      },
      dataset: {},
      classList: makeClassList(),
      children: [],
      parentNode: null,
      textContent: '',
      innerHTML: '',
      id: '',
      className: '',
      hidden: false,
      disabled: false,
      value: '',
      checked: false,
      tabIndex: 0,
      get childNodes() {
        return el.children;
      },
      get firstChild() {
        return el.children[0] ?? null;
      },
      get lastChild() {
        return el.children[el.children.length - 1] ?? null;
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode) child.parentNode.removeChild(child);
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      insertBefore(child, reference) {
        if (!child) return child;
        const index = reference ? el.children.indexOf(reference) : -1;
        if (index < 0) el.children.push(child);
        else el.children.splice(index, 0, child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
      },
      replaceChild(next, previous) {
        const index = el.children.indexOf(previous);
        if (index >= 0) el.children.splice(index, 1, next);
        if (next) next.parentNode = el;
        return previous;
      },
      remove() {
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      setAttribute(name, value) {
        attributes.set(String(name), String(value));
        if (name === 'id') el.id = String(value);
        if (name === 'class') el.className = String(value);
      },
      getAttribute(name) {
        return attributes.has(String(name)) ? attributes.get(String(name)) : null;
      },
      hasAttribute(name) {
        return attributes.has(String(name));
      },
      removeAttribute(name) {
        attributes.delete(String(name));
      },
      addEventListener(type, listener) {
        const set = elementListeners.get(type) ?? new Set();
        set.add(listener);
        elementListeners.set(type, set);
      },
      removeEventListener(type, listener) {
        const set = elementListeners.get(type);
        if (set) set.delete(listener);
      },
      dispatchEvent() {
        return true;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      matches() {
        return false;
      },
      contains() {
        return false;
      },
      focus() {},
      blur() {},
      click() {},
      scrollIntoView() {},
      animate() {
        return { cancel() {}, finished: Promise.resolve() };
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      },
      ownerDocument: null,
    };
    return el;
  }

  const document = {
    nodeType: 9,
    title: 'DSH verifier',
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    documentElement: null,
    body: null,
    head: null,
    defaultView: null,
    fonts: { ready: Promise.resolve() },
    createElement: (tag) => makeElement(tag),
    createElementNS: (_namespace, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), data: String(text), parentNode: null }),
    createDocumentFragment: () => makeElement('fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    addEventListener(type, listener) {
      const set = documentListeners.get(type) ?? new Set();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type, listener) {
      const set = documentListeners.get(type);
      if (set) set.delete(listener);
    },
    dispatchEvent: () => true,
    hasFocus: () => true,
    getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {}, collapse() {}, setStart() {}, setEnd() {} }),
    elementFromPoint: () => null,
    execCommand: () => true,
    exitFullscreen: () => Promise.resolve(),
  };
  document.documentElement = makeElement('html');
  document.body = makeElement('body');
  document.head = makeElement('head');
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  for (const el of [document.documentElement, document.body, document.head]) el.ownerDocument = document;

  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observed = [];
      observers.push(this);
    }
    observe(target, options) {
      this.observed.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  return {
    document,
    observers,
    documentListeners,
    windowListeners,
    MutationObserver: MutationObserverStub,
    ResizeObserver: ResizeObserverStub,
    IntersectionObserver: IntersectionObserverStub,
    StubEvent: createEventClass(),
    makeElement,
  };
}

function createBrowserSandbox(dom) {
  const fetchCalls = [];
  const EventStub = dom.StubEvent;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop, table: noop, group: noop, groupEnd: noop },
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    IntersectionObserver: dom.IntersectionObserver,
    Event: EventStub,
    CustomEvent: EventStub,
    KeyboardEvent: EventStub,
    MouseEvent: EventStub,
    PointerEvent: EventStub,
    FocusEvent: EventStub,
    UIEvent: EventStub,
    HTMLElement: class HTMLElementStub {},
    SVGElement: class SVGElementStub {},
    Element: class ElementStub {},
    Node: class NodeStub {},
    getComputedStyle: () => ({ getPropertyValue: () => '', color: '', backgroundColor: '' }),
    matchMedia: (query) => ({
      matches: false,
      media: String(query),
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
    }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    requestIdleCallback: (callback) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 16 }), 0),
    cancelIdleCallback: (handle) => clearTimeout(handle),
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: async () => ({ ok: true, value: { version: 1, workspaces: {} } }),
        text: async () => '',
      };
    },
    navigator: {
      userAgent: 'mw-verifier',
      language: 'zh-CN',
      languages: ['zh-CN', 'en'],
      platform: 'Win32',
      clipboard: { writeText: async () => {}, readText: async () => '' },
    },
    location: {
      href: 'http://127.0.0.1:64620/',
      origin: 'http://127.0.0.1:64620',
      protocol: 'http:',
      host: '127.0.0.1:64620',
      hostname: '127.0.0.1',
      port: '64620',
      pathname: '/',
      search: '',
      hash: '',
      assign: noop,
      replace: noop,
      reload: noop,
    },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone: (value) => structuredClone(value),
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    process: { env: {} },
    alert: noop,
    confirm: () => true,
    prompt: () => null,
    open: noop,
    close: noop,
    scrollTo: noop,
    scrollBy: noop,
    focus: noop,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener(type, listener) {
      const set = dom.windowListeners.get(type) ?? new Set();
      set.add(listener);
      dom.windowListeners.set(type, set);
    },
    removeEventListener(type, listener) {
      const set = dom.windowListeners.get(type);
      if (set) set.delete(listener);
    },
    dispatchEvent: () => true,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  dom.document.defaultView = sandbox;
  return { sandbox, fetchCalls };
}

// ---------------------------------------------------------------------------
// React / ReactDOM stubs
// ---------------------------------------------------------------------------

function createReactStub() {
  const hookCalls = [];
  const record = (name) => (...args) => {
    hookCalls.push({ name, args: args.length });
    return undefined;
  };

  const normalizeChildren = (children) => {
    const result = [];
    const walk = (value) => {
      if (value === null || value === undefined || value === false || value === true) return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      result.push(value);
    };
    children.forEach(walk);
    return result;
  };

  const createElement = (type, props, ...children) => {
    const merged = props && typeof props === 'object' ? { ...props } : {};
    const key = merged.key ?? null;
    delete merged.key;
    const kids = normalizeChildren(children);
    if (kids.length === 1) merged.children = kids[0];
    else if (kids.length > 1) merged.children = kids;
    return { type, key, props: merged, __vnode: true };
  };

  const react = {
    createElement,
    cloneElement: (element, props, ...children) => ({
      ...element,
      props: { ...(element && element.props ? element.props : {}), ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
    }),
    createContext(defaultValue) {
      return { _currentValue: defaultValue, Provider: Symbol.for('react.provider'), Consumer: Symbol.for('react.consumer') };
    },
    useContext(context) {
      return context && context._currentValue;
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      const setter = (next) => {
        hookCalls.push({ name: 'setState', args: 1, value: typeof next === 'function' ? next(value) : next });
      };
      return [value, setter];
    },
    useReducer(reducer, initial) {
      const state = typeof initial === 'function' ? initial() : initial;
      return [state, () => {}];
    },
    useEffect(fn) {
      hookCalls.push({ name: 'useEffect', args: 1, fn });
    },
    useLayoutEffect(fn) {
      hookCalls.push({ name: 'useLayoutEffect', args: 1, fn });
    },
    useInsertionEffect(fn) {
      hookCalls.push({ name: 'useInsertionEffect', args: 1, fn });
    },
    useRef(initial) {
      return { current: initial === undefined ? null : initial };
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useId() {
      return 'mw-test-' + String(hookCalls.length);
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      try {
        const unsubscribe = subscribe(() => {});
        if (typeof unsubscribe !== 'function') hookCalls.push({ name: 'useSyncExternalStore:no-unsubscribe', args: 1 });
      } catch {
        /* an idle subscription is fine for a single render */
      }
      return getSnapshot();
    },
    useTransition() {
      return [false, (fn) => fn()];
    },
    useDeferredValue(value) {
      return value;
    },
    useImperativeHandle() {},
    memo: (component) => component,
    forwardRef: (component) => component,
    createRef: () => ({ current: null }),
    isValidElement: (value) => Boolean(value && value.__vnode),
    Children: {
      map: (children, fn) => normalizeChildren([children]).map(fn),
      forEach: (children, fn) => normalizeChildren([children]).forEach(fn),
      count: (children) => normalizeChildren([children]).length,
      toArray: (children) => normalizeChildren([children]),
      only: (children) => children,
    },
    StrictMode: Symbol.for('react.strict_mode'),
    Suspense: Symbol.for('react.suspense'),
    Fragment: Symbol.for('react.fragment'),
    startTransition: (fn) => fn(),
  };
  react.default = react;
  const reactDom = {
    createPortal(node, container) {
      return { type: 'portal', props: { children: node, container }, __vnode: true };
    },
    flushSync: (fn) => fn(),
    version: 'stub',
  };
  return { react, reactDom, hookCalls };
}

// ---------------------------------------------------------------------------
// Fake Cordis client context
// ---------------------------------------------------------------------------

function createFakeCtx() {
  const registrations = [];
  const injections = [];
  const localeRegistrations = [];
  const effects = [];
  const effectDisposals = { count: 0, errors: [] };
  const warnCalls = [];
  const listeners = new Map();

  const workspaceItems = [
    { workspaceId: 'ws-1', title: '测试工作区', path: 'D:\\主文件夹', sessionIds: [], updatedAt: '2026-10-21T00:00:00.000Z' },
    { workspaceId: 'ws-2', title: 'Another', path: 'E:\\other', sessionIds: [], updatedAt: '2026-10-21T00:00:00.000Z' },
  ];
  const workspaceStore = {
    snapshot: { items: workspaceItems.slice() },
    listeners: new Set(),
    getSnapshot() {
      return workspaceStore.snapshot;
    },
    subscribe(listener) {
      workspaceStore.listeners.add(listener);
      return () => workspaceStore.listeners.delete(listener);
    },
  };
  const workspaces = {
    list: workspaceStore,
    async create({ path: primaryPath }) {
      const name = String(primaryPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace';
      return { workspaceId: 'ws-new', title: name, path: primaryPath, sessionIds: [], updatedAt: new Date().toISOString() };
    },
    async rename(workspaceId, title) {
      const found = workspaceItems.find((item) => item.workspaceId === workspaceId);
      return { ...(found || { workspaceId }), title };
    },
    async delete() {},
  };
  const uiWorkspace = {
    async listDirectory(dirPath) {
      return {
        home: dirPath || 'D:\\主文件夹',
        separator: '\\',
        entries: [
          { name: 'child-a', path: String(dirPath) + '\\child-a', hidden: false },
          { name: 'child-b', path: String(dirPath) + '\\child-b', hidden: false },
        ],
        truncated: false,
      };
    },
    async createDirectory() {
      return 'created';
    },
    async openWorkspace() {},
  };
  const localeSnapshot = { locale: 'zh-CN' };
  const locale = {
    register(namespace, localeName, dict) {
      const entry = { namespace, locale: localeName, dict };
      localeRegistrations.push(entry);
      return () => {
        const index = localeRegistrations.indexOf(entry);
        if (index >= 0) localeRegistrations.splice(index, 1);
      };
    },
    bind(namespace) {
      return (key) => String(key);
    },
    getLocale() {
      return localeSnapshot;
    },
  };
  const logger = {
    warn: (message) => warnCalls.push(String(message)),
    error: (message) => warnCalls.push(String(message)),
    info() {},
    debug() {},
  };

  const services = { workspaces, uiWorkspace, locale };
  const ctx = {
    logger,
    workspaces,
    uiWorkspace,
    locale,
    slots: {
      inject(name, callback) {
        injections.push({ name, callback });
        if (typeof callback !== 'function') return () => {};
        const result = callback();
        return typeof result === 'function' ? result : () => {};
      },
      register(options, component) {
        const registration = { options, component, disposed: false };
        registrations.push(registration);
        return () => {
          registration.disposed = true;
        };
      },
      entriesOfSlot(name) {
        return registrations.filter((registration) => registration.options && registration.options.name === name);
      },
      entries(name) {
        return this.entriesOfSlot(name);
      },
      getVersion() {
        return registrations.length;
      },
      subscribe() {
        return () => {};
      },
    },
    effect(fn) {
      const entry = { fn, disposed: false, disposer: null, dispose: null };
      effects.push(entry);
      const result = fn();
      const dispose = () => {
        if (entry.disposed) return;
        entry.disposed = true;
        effectDisposals.count += 1;
        if (typeof result !== 'function') return;
        try {
          result();
        } catch (error) {
          effectDisposals.errors.push(error);
          throw error;
        }
      };
      entry.dispose = dispose;
      if (typeof result === 'function') entry.disposer = result;
      return dispose;
    },
    on(event, callback) {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
      return () => set.delete(callback);
    },
    get(name) {
      return services[name];
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    registrations,
    injections,
    localeRegistrations,
    effects,
    effectDisposals,
    warnCalls,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Bundle loading through the DSH module-loader contract
// ---------------------------------------------------------------------------

function loadClientBundle() {
  const dom = createDomHarness();
  const { sandbox, fetchCalls } = createBrowserSandbox(dom);
  const reactParts = createReactStub();
  const requireCalls = [];
  const moduleLoadCalls = [];
  let captured = null;

  sandbox.__ModuleLoader__ = {
    load(entry) {
      moduleLoadCalls.push(entry);
      captured = entry;
    },
  };

  const context = vm.createContext(sandbox);
  const source = readText(bundlePath);
  vm.runInContext(source, context, { filename: 'lib/client.js', displayErrors: true });

  assert.equal(moduleLoadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once');
  assert.ok(captured && typeof captured === 'object', 'the module loader entry must be an object');
  assert.equal(typeof captured.factory, 'function', 'the loader entry must expose factory(require)');

  const requireImpl = (id) => {
    requireCalls.push(id);
    if (id === 'react') return reactParts.react;
    if (id === 'react-dom') return reactParts.reactDom;
    throw new Error('client bundle required an unsupported module: ' + id);
  };
  const plugin = captured.factory(requireImpl);
  return { entry: captured, plugin, dom, reactParts, requireCalls, fetchCalls };
}

// ---------------------------------------------------------------------------
// Source-fragment loaders (pure helpers not exported by the factory)
// ---------------------------------------------------------------------------

function createBasicSandbox() {
  const calls = [];
  let responseFactory = () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { version: 1, workspaces: {} } }),
  });
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responseFactory(url, init);
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  return {
    sandbox,
    calls,
    setResponse(factory) {
      responseFactory = factory;
    },
  };
}

const API_EXPORTS = [
  'createMwStore',
  'mwFetchJson',
  'mwLoadState',
  'mwSaveWorkspace',
  'mwRemoveWorkspace',
  'mwErrorMessage',
  'mwBasename',
  'mwDirname',
  'mwPathKey',
  'mwRecordFor',
  'mwRecordRoots',
  'mwRecordPrimaryPath',
  'mwNormalizeSelection',
  'mwFindWorkspaceByLabel',
];

function loadApiFragment() {
  const harness = createBasicSandbox();
  const context = vm.createContext(harness.sandbox);
  const source = readText(apiFragment);
  const tail =
    '\n;globalThis.__mwApi = {' +
    API_EXPORTS.map((name) => name + ': typeof ' + name + " === 'function' ? " + name + ' : undefined').join(', ') +
    '};';
  vm.runInContext(source + tail, context, { filename: 'src/client/10-api.js', displayErrors: true });
  assert.ok(harness.sandbox.__mwApi && typeof harness.sandbox.__mwApi === 'object', '10-api.js did not load');
  return { api: harness.sandbox.__mwApi, calls: harness.calls, setResponse: harness.setResponse };
}

function loadI18nFragment() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const source = readText(i18nFragment);
  const tail =
    '\n;globalThis.__mwI18n = {' +
    " dicts: typeof MW_DICTS !== 'undefined' ? MW_DICTS : undefined," +
    " ns: typeof MW_LOCALE_NS !== 'undefined' ? MW_LOCALE_NS : undefined" +
    ' };';
  vm.runInContext(source + tail, context, { filename: 'src/client/15-i18n.js', displayErrors: true });
  return sandbox.__mwI18n;
}

/**
 * Small DOM with a selector engine, deep cloning, event dispatch and manual
 * MutationObserver triggering. 50-menu.js is a DOM enhancement, so its behavior
 * can only be verified with these primitives.
 */
function matchesMenuSelector(element, selectorList) {
  if (!element || element.nodeType !== 1) return false;
  const selectors = String(selectorList).split(',');
  for (const raw of selectors) {
    const selector = raw.trim();
    if (!selector) continue;
    if (selector === '*') return true;
    const shape = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(selector);
    if (!shape) continue;
    const tag = shape[1];
    const attributesPart = shape[2] || '';
    if (tag && String(element.tagName).toLowerCase() !== tag.toLowerCase()) continue;
    const attributeRegex = /\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
    let ok = true;
    let match;
    while ((match = attributeRegex.exec(attributesPart)) !== null) {
      const name = match[1].trim();
      const expected = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
      if (!element.hasAttribute(name)) {
        ok = false;
        break;
      }
      if (expected !== undefined && element.getAttribute(name) !== expected) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function createMenuDomHarness() {
  const observers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();

  function makeElement(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const el = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      style: { cssText: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      dataset: {},
      classList: makeClassList(),
      children: [],
      parentNode: null,
      textContent: '',
      id: '',
      className: '',
      ownerDocument: null,
      get parentElement() {
        return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
      },
      get childNodes() {
        return el.children.slice();
      },
      get nextSibling() {
        if (!el.parentNode) return null;
        const index = el.parentNode.children.indexOf(el);
        return index >= 0 ? el.parentNode.children[index + 1] ?? null : null;
      },
      get isConnected() {
        let node = el;
        while (node) {
          if (node === document) return true;
          node = node.parentNode;
        }
        return false;
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode) child.parentNode.removeChild(child);
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      insertBefore(child, reference) {
        if (!child) return child;
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = reference ? el.children.indexOf(reference) : -1;
        if (index < 0) el.children.push(child);
        else el.children.splice(index, 0, child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
      },
      remove() {
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      setAttribute(name, value) {
        attributes.set(String(name), String(value));
        if (name === 'id') el.id = String(value);
        if (name === 'class') el.className = String(value);
      },
      getAttribute(name) {
        return attributes.has(String(name)) ? attributes.get(String(name)) : null;
      },
      hasAttribute(name) {
        return attributes.has(String(name));
      },
      removeAttribute(name) {
        attributes.delete(String(name));
      },
      getAttributeNames() {
        return Array.from(attributes.keys());
      },
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        const set = listeners.get(type);
        if (set) set.delete(listener);
      },
      dispatchEvent(event) {
        if (!event || typeof event.type !== 'string') return true;
        if (!event.target) event.target = el;
        event.currentTarget = el;
        for (const listener of Array.from(listeners.get(event.type) ?? [])) {
          try {
            listener.call(el, event);
          } catch {
            /* a listener throwing must not break dispatch in the fixture */
          }
        }
        if (event.bubbles && el.parentNode && event.propagationStopped !== true) el.parentNode.dispatchEvent(event);
        return event.defaultPrevented !== true;
      },
      matches(selector) {
        return matchesMenuSelector(el, selector);
      },
      closest(selector) {
        let node = el;
        while (node) {
          if (node.nodeType === 1 && matchesMenuSelector(node, selector)) return node;
          node = node.parentNode;
        }
        return null;
      },
      querySelector(selector) {
        return el.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll(selector) {
        const result = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (matchesMenuSelector(child, selector)) result.push(child);
            walk(child);
          }
        };
        walk(el);
        return result;
      },
      cloneNode(deep) {
        return cloneElement(el, deep !== false);
      },
      focus() {},
      blur() {},
      click() {},
      scrollIntoView() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    };
    return el;
  }

  function cloneElement(source, deep) {
    const clone = makeElement(String(source.tagName).toLowerCase());
    clone.ownerDocument = source.ownerDocument || document;
    for (const name of source.getAttributeNames()) clone.setAttribute(name, source.getAttribute(name));
    clone.textContent = source.textContent;
    clone.dataset = { ...source.dataset };
    if (deep) for (const child of source.children) clone.appendChild(cloneElement(child, true));
    return clone;
  }

  const document = {
    nodeType: 9,
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    documentElement: null,
    body: null,
    head: null,
    createElement(tag) {
      const el = makeElement(tag);
      el.ownerDocument = document;
      return el;
    },
    createElementNS(_namespace, tag) {
      return document.createElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), nodeValue: String(text), data: String(text), parentNode: null };
    },
    addEventListener(type, listener) {
      const set = documentListeners.get(type) ?? new Set();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type, listener) {
      const set = documentListeners.get(type);
      if (set) set.delete(listener);
    },
    dispatchEvent(event) {
      if (!event || typeof event.type !== 'string') return true;
      if (!event.target) event.target = document;
      event.currentTarget = document;
      for (const listener of Array.from(documentListeners.get(event.type) ?? [])) {
        try {
          listener.call(document, event);
        } catch {
          /* fixture listener errors must not break the dispatch */
        }
      }
      return event.defaultPrevented !== true;
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const result = [];
      const walk = (node) => {
        for (const child of node.children ?? []) {
          if (matchesMenuSelector(child, selector)) result.push(child);
          walk(child);
        }
      };
      walk(document.documentElement || document.body);
      return result;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === document) return true;
        current = current.parentNode;
      }
      return false;
    },
  };
  document.documentElement = document.createElement('html');
  document.documentElement.parentNode = document;
  document.body = document.createElement('body');
  document.head = document.createElement('head');
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);

  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observed = [];
      observers.push(this);
    }
    observe(target, options) {
      this.observed.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }

  class MenuEventStub {
    constructor(type, init) {
      this.type = String(type);
      this.bubbles = Boolean(init && init.bubbles);
      this.cancelable = Boolean(init && init.cancelable);
      this.defaultPrevented = false;
      if (init && typeof init === 'object') Object.assign(this, init);
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      this.propagationStopped = true;
    }
    stopImmediatePropagation() {
      this.propagationStopped = true;
    }
  }

  return {
    document,
    observers,
    documentListeners,
    windowListeners,
    MutationObserver: MutationObserverStub,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    StubEvent: MenuEventStub,
  };
}

function makeClickEvent(target) {
  return {
    type: 'click',
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    propagationStopped: false,
    target,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
    },
  };
}

function loadMenuFragment() {
  const dom = createMenuDomHarness();
  const { sandbox } = createBrowserSandbox(dom);
  const context = vm.createContext(sandbox);
  const source = readText(menuFragment);
  const tail = "\n;globalThis.__mwMenu = { install: typeof installWorkspaceMenuAction === 'function' ? installWorkspaceMenuAction : undefined };";
  vm.runInContext(source + tail, context, { filename: 'src/client/50-menu.js', displayErrors: true });
  return { install: sandbox.__mwMenu.install, dom };
}

/**
 * Whitebox harness for the "actions layer": concatenate every source fragment
 * inside one closure exactly like tools/build-client.mjs does, then expose the
 * internal factories (createMwActions / mwRequestFolderPick / dialogs) so the
 * wiring can be exercised without a browser.
 */
function loadIntegrationHarness() {
  const dom = createDomHarness();
  const { sandbox, fetchCalls } = createBrowserSandbox(dom);
  const reactParts = createReactStub();
  let responseFactory = () => okValue({});
  sandbox.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return responseFactory(String(url), init);
  };
  sandbox.require = (id) => {
    if (id === 'react') return reactParts.react;
    if (id === 'react-dom') return reactParts.reactDom;
    throw new Error('integration harness required an unsupported module: ' + id);
  };
  const context = vm.createContext(sandbox);
  const fragments = EXPECTED_FRAGMENTS.map((name) => readText(path.join(srcDir, name))).join('\n');
  const prelude =
    "'use strict';\nconst React = require('react');\nconst { createPortal } = require('react-dom');\nconst h = React.createElement;\nconst Fragment = React.Fragment;\n";
  const tail =
    '\nreturn { createMwActions, createMwStore, mwRequestFolderPick, mwTranslate, mwDlgMergeFolders, MwSourceFolders, CreateWorkspaceDialog, ModifyWorkspaceDialog, MultiWorkspaceFlow, apply };\n';
  const source = '(function(){\n' + prelude + fragments + tail + '})()';
  const exposed = vm.runInContext(source, context, { filename: 'integration-harness.js', displayErrors: true });
  return {
    exposed,
    sandbox,
    dom,
    fetchCalls,
    setResponse(factory) {
      responseFactory = factory;
    },
  };
}

function okValue(value) {
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
}

function createActionsCtx() {
  const calls = { create: [], rename: [], delete: [], openWorkspace: [], listDirectory: [], createDirectory: [], pickDirectory: 0 };
  const view = { workspaceId: 'ws-new', title: '新建文件夹', path: 'D:\\FlowPrimary', sessionIds: [], updatedAt: '2026-10-21T00:00:00.000Z' };
  const ctx = {
    workspaces: {
      list: { getSnapshot: () => ({ items: [] }) },
      async create(input) {
        calls.create.push(input);
        return { ...view };
      },
      async rename(workspaceId, title) {
        calls.rename.push({ workspaceId, title });
        return { ...view, workspaceId, title };
      },
      async delete(workspaceId) {
        calls.delete.push(workspaceId);
      },
    },
    uiWorkspace: {
      async listDirectory(dirPath) {
        calls.listDirectory.push(dirPath);
        return { home: dirPath || 'D:\\', separator: '\\', entries: [] };
      },
      async createDirectory(parentPath, name) {
        calls.createDirectory.push({ parentPath, name });
        return name;
      },
      async openWorkspace(workspaceId) {
        calls.openWorkspace.push(workspaceId);
      },
      async pickDirectory() {
        calls.pickDirectory += 1;
        return undefined;
      },
    },
    locale: {
      getLocale: () => ({ active: 'zh-CN' }),
      register: () => () => {},
      bind: () => (key) => String(key),
    },
    logger: { warn() {} },
  };
  return { ctx, calls };
}

function findVnodeProp(node, propName) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props && typeof node.props[propName] === 'function') return node.props[propName];
  const children = node.props ? node.props.children : undefined;
  const list = Array.isArray(children) ? children : children === undefined || children === null ? [] : [children];
  for (const child of list) {
    const found = findVnodeProp(child, propName);
    if (found) return found;
  }
  return undefined;
}

/** Collect every vnode in a rendered tree that matches a predicate. */
function collectVnodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (node.__vnode && predicate(node)) result.push(node);
  const children = node.props ? node.props.children : undefined;
  const list = Array.isArray(children) ? children : children === undefined || children === null ? [] : [children];
  for (const child of list) collectVnodes(child, predicate, result);
  return result;
}

const actionsSkip = skipUnless(missingFragments.length === 0, 'waiting for integration; missing fragments: ' + missingFragments.join(', '));

// ---------------------------------------------------------------------------
// Tests: integration readiness + bundle build
// ---------------------------------------------------------------------------

test(
  'integration: every DESIGN client fragment exists',
  { skip: skipUnless(missingFragments.length === 0, 'waiting for integration; missing: ' + missingFragments.join(', ')) },
  () => {
    assert.deepEqual(missingFragments, []);
  },
);

test(
  'build: tools/build-client.mjs regenerates lib/client.js',
  { skip: skipUnless(integrationReady, 'build script or fragments missing (integration pending)') },
  () => {
    assert.ok(exists(buildScript), 'tools/build-client.mjs is missing');
    assert.ok(build.ok, 'build-client.mjs failed:\n' + build.error);
    assert.ok(exists(bundlePath), 'lib/client.js was not produced');
    const source = readText(bundlePath);
    assert.match(source, /id:\s*["']dsh-multi-workspace["']/);
    assert.match(source, /\/\/#region src\/client\//);
  },
);

test('bundle: ModuleLoader wrapper declares id, factory and only React requires', { skip: bundleSkip }, () => {
  assert.ok(exists(bundlePath), 'lib/client.js is missing; run tools/build-client.mjs');
  const source = readText(bundlePath);
  assert.match(source, /window\.__ModuleLoader__\.load\s*\(/);
  assert.match(source, /id:\s*["']dsh-multi-workspace["']/);
  assert.match(source, /factory\s*\(\s*require\s*\)\s*\{/);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, 'source fragments must be plain script bodies (no import/export)');
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  const unexpected = requires.filter((id) => id !== 'react' && id !== 'react-dom');
  assert.deepEqual(unexpected, [], 'the client bundle may only require react and react-dom');
  assert.deepEqual([...new Set(requires)].sort(), ['react', 'react-dom']);
  const regions = [...source.matchAll(/\/\/#region src\/client\/([^\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(regions.slice().sort(), EXPECTED_FRAGMENTS.slice().sort(), 'every DESIGN fragment must be concatenated into the bundle');
});

test('bundle: scoped DSH workbench styles support themes, narrow windows and folder dragging', { skip: bundleSkip }, () => {
  const source = readText(bundlePath);
  assert.ok(/\.mw-[a-z]/i.test(source), 'styles must use the mw- CSS prefix');
  assert.ok(source.includes('--mw-'), 'styles must expose local workbench design variables');
  assert.ok(source.includes('--dsw-alias-'), 'styles must use --dsw-alias-* theme tokens');
  assert.ok(source.includes('multi-workspace'), 'the multi-workspace locale namespace must appear in the bundle');
  // Theme adaptation, narrow-window layout and accessibility fallbacks.
  assert.match(source, /@media\s*\([^)]*max-width\s*:/, 'styles must adapt to narrow windows');
  assert.ok(source.includes('prefers-reduced-motion'), 'reduced-motion fallback must be present');
  assert.ok(source.includes('forced-colors'), 'forced-colors fallback must be present');
  // Drag-and-drop folder rows.
  assert.ok(source.includes('mw-folder--draggable'), 'folder rows must expose the draggable class');
  assert.ok(source.includes('mw-folder--dragging'), 'folder rows must expose the dragging class');
  assert.ok(source.includes('mw-folder--dragover'), 'folder rows must expose the dragover class');
});

// ---------------------------------------------------------------------------
// Tests: module load + apply wiring
// ---------------------------------------------------------------------------

test('module: vm load captures {id, factory}, factory runs and exports inject/apply', { skip: bundleSkip }, () => {
  const loaded = loadClientBundle();
  assert.equal(loaded.entry.id, 'dsh-multi-workspace');
  assert.ok(loaded.plugin && typeof loaded.plugin === 'object', 'factory must return the plugin exports');
  assert.equal(typeof loaded.plugin.apply, 'function', 'factory must return apply');
  assert.deepEqual(toHost(loaded.plugin.inject), ['slots', 'workspaces', 'uiWorkspace', 'locale']);
  assert.deepEqual([...new Set(loaded.requireCalls)].sort(), ['react', 'react-dom']);
});

test('apply: directoryFlow x2 at priority -100, shell.overlay host, locale dicts, disposers', { skip: bundleSkip }, () => {
  const loaded = loadClientBundle();
  const ctx = createFakeCtx();
  assert.doesNotThrow(() => loaded.plugin.apply(ctx), 'apply(ctx) threw');
  assert.ok(ctx.registrations.length >= 3, 'apply must register components through ctx.slots.register');

  const registrationsFor = (slot) => ctx.registrations.filter((registration) => registration.options && registration.options.name === slot);

  for (const slot of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']) {
    const matches = registrationsFor(slot);
    assert.equal(matches.length, 1, 'expected exactly one occupant for ' + slot);
    assert.equal(matches[0].options.priority, -100, slot + ' must shadow the native picker with priority -100');
    assert.equal(matches[0].options.id, 'multi-workspace-flow');
    assert.equal(typeof matches[0].component, 'function', slot + ' must register a component function');
  }

  const overlays = registrationsFor('shell.overlay');
  assert.ok(overlays.length >= 1, 'shell.overlay must have a persistent host registration');
  assert.equal(typeof overlays[0].component, 'function', 'shell.overlay host must be a component function');

  const dictionaries = ctx.localeRegistrations.filter((registration) => registration.namespace === 'multi-workspace');
  assert.ok(dictionaries.length >= 2, 'expected zh + en dictionaries under the multi-workspace namespace');
  assert.ok(dictionaries.every((registration) => registration.dict && Object.keys(registration.dict).length > 0), 'locale dictionaries must not be empty');
  const locales = dictionaries.map((registration) => registration.locale).sort();
  assert.deepEqual(locales, ['en', 'zh']);

  const injectedSlots = new Set(ctx.injections.map((injection) => injection.name));
  assert.ok(injectedSlots.has('sidebar.workspaces.directoryFlow'), 'sidebar directoryFlow must be injected before registration');
  assert.ok(injectedSlots.has('conversation.hero.workspace.directoryFlow'), 'hero directoryFlow must be injected before registration');
  assert.ok(injectedSlots.has('shell.overlay'), 'shell.overlay must be injected before registration');

  assert.ok(ctx.effects.length >= 2, 'apply must own its side effects through ctx.effect');
  assert.ok(ctx.effects.every((effect) => typeof effect.disposer === 'function'), 'every ctx.effect() must return a disposer');
});

test('render: every registered component renders without throwing', { skip: bundleSkip }, () => {
  const loaded = loadClientBundle();
  const ctx = createFakeCtx();
  loaded.plugin.apply(ctx);
  const rendered = [];

  for (const registration of ctx.registrations) {
    const slot = registration.options && registration.options.name;
    assert.equal(typeof registration.component, 'function', slot + ' must be a component function');
    let injected = {};
    if (registration.options && typeof registration.options.inject === 'function') {
      try {
        const value = registration.options.inject();
        if (value && typeof value === 'object') injected = value;
      } catch {
        injected = {};
      }
    }
    const props = {
      ...injected,
      open: false,
      busy: false,
      onPicked() {},
      onCancel() {},
      onError() {},
      close() {},
      sessionId: 'session-test',
      workspace: null,
    };
    const vnode = registration.component(props);
    assert.ok(vnode === null || typeof vnode === 'object', slot + ' must render a vnode or null');
    rendered.push(slot);
  }
  assert.ok(rendered.length >= 3, 'expected the two flows and the overlay host to render');
});

test('dispose: effect disposers remove style, disconnect observers, are idempotent', { skip: bundleSkip }, () => {
  const loaded = loadClientBundle();
  const ctx = createFakeCtx();
  const head = loaded.dom.document.head;
  const headBefore = head.children.length;

  loaded.plugin.apply(ctx);
  const styleNodes = head.children.filter((node) => String(node.tagName).toLowerCase() === 'style');
  assert.ok(styleNodes.length >= 1, 'apply must inject a <style> tag through ctx.effect');

  for (const effect of ctx.effects) {
    assert.doesNotThrow(() => effect.dispose(), 'an effect disposer threw');
  }
  // Disposing twice must stay a no-op (Cordis can call disposal more than once).
  for (const effect of ctx.effects) {
    assert.doesNotThrow(() => effect.dispose(), 'an effect disposer is not idempotent');
  }

  assert.equal(ctx.effectDisposals.errors.length, 0, 'effect cleanup threw: ' + ctx.effectDisposals.errors.map(String).join('; '));
  assert.equal(
    ctx.effectDisposals.count,
    ctx.effects.filter((effect) => typeof effect.disposer === 'function').length,
    'every ctx.effect disposer must have run exactly once',
  );
  assert.equal(head.children.length, headBefore, 'the <style> tag injected by apply was not removed on dispose');
  assert.equal(head.children.filter((node) => String(node.tagName).toLowerCase() === 'style').length, 0);

  if (loaded.dom.observers.length > 0) {
    assert.ok(loaded.dom.observers.every((observer) => observer.disconnected), 'the workspace menu MutationObserver was not disconnected on dispose');
  }
});

// ---------------------------------------------------------------------------
// Tests: pure API helpers (src/client/10-api.js, loaded directly)
// ---------------------------------------------------------------------------

const apiSkip = skipUnless(exists(apiFragment), 'src/client/10-api.js is missing');
const i18nSkip = skipUnless(exists(i18nFragment), 'src/client/15-i18n.js is missing');
const menuSkip = skipUnless(exists(menuFragment), 'src/client/50-menu.js is missing');

test('api: basename / dirname / path-key helpers', { skip: apiSkip }, () => {
  const { api } = loadApiFragment();
  assert.equal(api.mwBasename('D:\\工作\\项目\\'), '项目');
  assert.equal(api.mwBasename('E:/root/sub'), 'sub');
  assert.equal(api.mwBasename(''), '');
  assert.equal(api.mwBasename(undefined), '');
  assert.equal(api.mwDirname('D:\\工作\\项目'), 'D:\\工作');
  assert.equal(api.mwDirname('D:\\工作'), 'D:\\');
  assert.equal(api.mwDirname('D:\\'), undefined);
  assert.equal(api.mwDirname('/root/sub'), '/root');
  assert.equal(api.mwPathKey('D:\\Work\\Project\\'), 'd:\\work\\project');
  assert.equal(api.mwPathKey('D:/work/project'), 'd:\\work\\project');
  assert.equal(api.mwPathKey(null), '');
});

test('api: normalizeSelection dedupes, drops the primary folder and rejects relative paths', { skip: apiSkip }, () => {
  const { api } = loadApiFragment();
  const selection = toHost(api.mwNormalizeSelection(['D:\\A', 'd:\\a\\', 'E:\\b', '', 'relative\\x', 'F:/c', null, 42], 'D:\\A'));
  assert.deepEqual(selection, ['E:\\b', 'F:/c']);
  assert.deepEqual(toHost(api.mwNormalizeSelection([], 'D:\\A')), []);
  assert.deepEqual(toHost(api.mwNormalizeSelection(undefined, 'D:\\A')), []);
  assert.deepEqual(toHost(api.mwNormalizeSelection(['D:\\A\\'], 'D:\\A')), []);
});

test('api: store notifies subscribers and isolates listener failures', { skip: apiSkip }, () => {
  const { api } = loadApiFragment();
  const store = api.createMwStore({ dialog: null });
  assert.deepEqual(toHost(store.getSnapshot()), { dialog: null });
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(toHost(store.getSnapshot())));
  store.setState({ dialog: 'create' });
  assert.deepEqual(toHost(store.getSnapshot()), { dialog: 'create' });
  assert.equal(seen.length, 1);
  store.setState((snapshot) => ({ ...snapshot, N: 1 }));
  assert.deepEqual(toHost(store.getSnapshot()), { dialog: 'create', N: 1 });
  unsubscribe();
  store.setState({ dialog: null });
  assert.equal(seen.length, 2);

  let secondListenerCalls = 0;
  store.subscribe(() => {
    throw new Error('listener boom');
  });
  store.subscribe(() => {
    secondListenerCalls += 1;
  });
  assert.doesNotThrow(() => store.setState({ safe: true }));
  assert.equal(secondListenerCalls, 1);
});

test('api: fetch bridge maps GET/POST bodies and folds Host/network errors', { skip: apiSkip }, async () => {
  const harness = loadApiFragment();
  const { api } = harness;

  harness.setResponse(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { version: 1, workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\A', roots: [] } } } }),
  }));
  const state = await api.mwLoadState();
  assert.deepEqual(toHost(state), { version: 1, workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\A', roots: [] } } });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, '/api/multi-workspace/state');
  assert.equal(harness.calls[0].init.method, 'GET');
  assert.equal(harness.calls[0].init.credentials, 'same-origin');

  harness.setResponse(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { id: 'ws-1' } }) }));
  await api.mwSaveWorkspace({ id: 'ws-1', name: '名字', path: 'D:\\A', roots: ['E:\\B'] });
  assert.equal(harness.calls[1].init.method, 'POST');
  assert.equal(harness.calls[1].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(harness.calls[1].init.body), { op: 'save', id: 'ws-1', name: '名字', path: 'D:\\A', roots: ['E:\\B'] });

  harness.setResponse(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }));
  await api.mwRemoveWorkspace('ws-1');
  assert.deepEqual(JSON.parse(harness.calls[2].init.body), { op: 'remove', id: 'ws-1' });

  harness.setResponse(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }));
  assert.deepEqual(toHost(await api.mwLoadState()), { version: 1, workspaces: {} });

  harness.setResponse(() => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'bad', message: 'bad request' } }) }));
  await assert.rejects(() => api.mwLoadState(), /bad request/);

  harness.setResponse(() => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }));
  await assert.rejects(() => api.mwLoadState(), /HTTP 500/);

  harness.setResponse(() => { throw new Error('offline'); });
  await assert.rejects(() => api.mwLoadState(), /offline/);
});

test('api: record helpers and workspace label resolution', { skip: apiSkip }, () => {
  const { api } = loadApiFragment();
  const state = { version: 1, workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\A', roots: ['E:\\B', 'E:\\C'] } } };
  assert.deepEqual(toHost(api.mwRecordRoots(state, 'ws-1')), ['E:\\B', 'E:\\C']);
  assert.deepEqual(toHost(api.mwRecordRoots(state, 'missing')), []);
  assert.equal(api.mwRecordPrimaryPath(state, { workspaceId: 'ws-1', path: 'D:\\other' }), 'D:\\A');
  assert.equal(api.mwRecordPrimaryPath({}, { workspaceId: 'missing', path: 'D:\\other' }), 'D:\\other');
  assert.equal(api.mwRecordPrimaryPath({}, { workspaceId: 'missing' }), '');

  const items = [
    { workspaceId: 'ws-1', title: '我的 项目' },
    { workspaceId: 'ws-2', title: 'Other' },
    { workspaceId: 'ws-3', title: 'Duplicate' },
    { workspaceId: 'ws-4', title: 'Duplicate' },
  ];
  assert.equal(api.mwFindWorkspaceByLabel(items, '我的 项目').workspaceId, 'ws-1');
  assert.equal(api.mwFindWorkspaceByLabel(items, '打开 我的 项目 的工作区菜单').workspaceId, 'ws-1');
  assert.equal(api.mwFindWorkspaceByLabel(items, '不存在'), undefined);
  assert.equal(api.mwFindWorkspaceByLabel(items, 'Duplicate'), undefined);
  assert.equal(api.mwErrorMessage(new Error('boom')), 'boom');
  assert.equal(api.mwErrorMessage('plain'), 'plain');
});

// ---------------------------------------------------------------------------
// Tests: i18n dictionary consistency (src/client/15-i18n.js)
// ---------------------------------------------------------------------------

test('i18n: MW_DICTS ships matching zh/en key sets', { skip: i18nSkip }, () => {
  const i18n = loadI18nFragment();
  assert.ok(i18n.dicts && typeof i18n.dicts === 'object', '15-i18n.js must define MW_DICTS');
  const zh = i18n.dicts.zh;
  const en = i18n.dicts.en;
  assert.ok(zh && typeof zh === 'object' && Object.keys(zh).length > 0, 'MW_DICTS.zh must be a non-empty object');
  assert.ok(en && typeof en === 'object' && Object.keys(en).length > 0, 'MW_DICTS.en must be a non-empty object');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en dictionaries must expose the same keys');
  // Workspace grouping, overview and folder interaction copy must be localized.
  for (const key of ['section.workspace', 'overview.title', 'overview.summary', 'source.count', 'source.primaryHint', 'action.dragFolder', 'source.removePrimaryHint', 'action.removeFolder.aria']) {
    assert.equal(typeof zh[key], 'string', 'MW_DICTS.zh must define ' + key);
    assert.ok(zh[key].trim().length > 0, 'MW_DICTS.zh must localize ' + key);
    assert.equal(typeof en[key], 'string', 'MW_DICTS.en must define ' + key);
    assert.ok(en[key].trim().length > 0, 'MW_DICTS.en must localize ' + key);
  }
  if (i18n.ns !== undefined) assert.equal(i18n.ns, 'multi-workspace');
});

// ---------------------------------------------------------------------------
// Tests: workspace menu augmentation lifecycle (src/client/50-menu.js)
// ---------------------------------------------------------------------------

test('menu: installWorkspaceMenuAction installs, stays silent and disposes idempotently', { skip: menuSkip }, () => {
  const { install, dom } = loadMenuFragment();
  assert.equal(typeof install, 'function', '50-menu.js must define installWorkspaceMenuAction');
  const requested = [];
  const disposer = install({
    onOpen: (workspace) => requested.push(workspace),
    t: (key) => String(key),
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    resolveWorkspace: () => undefined,
    resolveWorkspaceByLabel: () => undefined,
  });
  assert.equal(typeof disposer, 'function', 'installWorkspaceMenuAction must return a disposer');
  assert.doesNotThrow(() => disposer(), 'menu disposer threw');
  assert.doesNotThrow(() => disposer(), 'menu disposer is not idempotent');
  if (dom.observers.length > 0) {
    assert.ok(dom.observers.every((observer) => observer.disconnected), 'menu disposer must disconnect every MutationObserver');
  }
  assert.deepEqual(requested, []);
});

test('menu: enhances the native workspace menu and opens the modify dialog', { skip: menuSkip }, () => {
  const { install, dom } = loadMenuFragment();
  const document = dom.document;
  const workspace = { workspaceId: 'ws-1', title: '测试工作区' };
  const opened = [];
  const warnings = [];
  const dispose = install({
    t: (key) => (key === 'menu.modifyWorkspace' ? '修改工作区' : String(key)),
    logger: { warn: (message) => warnings.push(String(message)) },
    resolveWorkspace: (label) => (label === '测试工作区' ? workspace : undefined),
    onOpen: (value) => opened.push(value),
  });

  function makeNativeMenu() {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const viewport = document.createElement('div');
    viewport.setAttribute('role', 'presentation');
    for (const label of ['重命名', '删除工作区']) {
      const wrap = document.createElement('div');
      const button = document.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(icon);
      button.appendChild(text);
      wrap.appendChild(button);
      viewport.appendChild(wrap);
    }
    menu.appendChild(viewport);
    return menu;
  }

  try {
    const row = document.createElement('div');
    row.setAttribute('data-row-key', 'workspace:ws-1');
    row.setAttribute('role', 'treeitem');
    const title = document.createElement('span');
    title.textContent = '测试工作区';
    row.appendChild(title);
    const actionButton = document.createElement('button');
    actionButton.setAttribute('aria-label', '工作区“测试工作区”的操作');
    row.appendChild(actionButton);
    document.body.appendChild(row);

    // Capture-phase click on the row action tells the augmentation which workspace is active.
    document.dispatchEvent(makeClickEvent(actionButton));

    // The native menu is portalled to document.body after the click.
    const menu = makeNativeMenu();
    document.body.appendChild(menu);
    assert.ok(dom.observers.length > 0, 'install must create a MutationObserver');
    assert.equal(menu.querySelectorAll('button[role="menuitem"]').length, 2, 'fixture menu must look like the native workspace menu');
    assert.equal((dom.documentListeners.get('click') ?? new Set()).size, 1, 'install must add one capture click listener');
    dom.observers[0].callback([{ type: 'childList', target: document.body, addedNodes: [menu] }]);

    assert.equal(
      menu.getAttribute('data-mw-menu-enhanced'),
      '1',
      'the workspace menu must be marked as enhanced; warnings=' + JSON.stringify(warnings),
    );
    const clones = menu.querySelectorAll('[data-mw-menu-action]');
    assert.equal(clones.length, 1, 'exactly one augmented item must be inserted');
    const clone = clones[0];
    assert.equal(clone.getAttribute('data-mw-menu-action'), 'modify-workspace');
    assert.equal(menu.querySelectorAll('button[role="menuitem"]').length, 3, 'the native two items stay and one augmentation is added');
    const labels = clone.querySelectorAll('span').map((span) => span.textContent);
    assert.ok(labels.includes('修改工作区'), 'the cloned item must carry the localized modify label');

    clone.dispatchEvent(makeClickEvent(null));
    assert.deepEqual(opened, [workspace], 'clicking the augmentation must open the modify dialog');
    assert.equal(menu.querySelectorAll('[data-mw-menu-action]').length, 0, 'the clone removes itself after being used');
  } finally {
    dispose();
    dispose();
  }
  assert.ok(dom.observers.every((observer) => observer.disconnected), 'dispose must disconnect the menu observer');
});

// ---------------------------------------------------------------------------
// Tests: actions layer (create / modify / native picker fallback)
// ---------------------------------------------------------------------------

test('actions: submitCreate runs create -> rename -> POST save -> flow.onPicked', { skip: actionsSkip }, async () => {
  const harness = loadIntegrationHarness();
  const { ctx, calls } = createActionsCtx();
  const store = harness.exposed.createMwStore({ dialog: null });
  const actions = harness.exposed.createMwActions(ctx, store, (key) => String(key), { warn() {} });
  const picked = [];
  const flow = { open: true, busy: false, onPicked: (value) => picked.push(value), onCancel() {}, onError() {} };
  store.setState({ dialog: { mode: 'create', workspace: null, flow } });
  harness.setResponse(() => okValue({ id: 'ws-new' }));

  const view = await actions.submitCreate({ name: '我的工作区', primaryPath: 'D:\\FlowPrimary', roots: ['E:\\B', 'e:\\b\\', 'D:\\FlowPrimary\\'] });

  assert.equal(view.workspaceId, 'ws-new');
  assert.deepEqual(toHost(calls.create), [{ path: 'D:\\FlowPrimary' }], 'create is called with the primary folder');
  assert.deepEqual(calls.rename, [{ workspaceId: 'ws-new', title: '我的工作区' }], 'the typed name is applied through workspaces.rename');
  assert.equal(harness.fetchCalls.length, 1, 'exactly one Host request after create/rename');
  assert.equal(harness.fetchCalls[0].url, '/api/multi-workspace/state');
  assert.equal(harness.fetchCalls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].init.body), {
    op: 'save',
    id: 'ws-new',
    name: '我的工作区',
    path: 'D:\\FlowPrimary',
    roots: ['E:\\B'],
  });
  assert.deepEqual(picked, ['D:\\FlowPrimary'], 'the owner flow adopts the primary folder so DSH opens the workspace/session');
  assert.deepEqual(calls.openWorkspace, [], 'a flow owner must not also open the workspace directly');
  assert.equal(store.getSnapshot().dialog, null, 'the dialog is closed after a successful create');
});

test('actions: submitCreate falls back to the folder basename when no name is typed', { skip: actionsSkip }, async () => {
  const harness = loadIntegrationHarness();
  const { ctx, calls } = createActionsCtx();
  const store = harness.exposed.createMwStore({ dialog: null });
  const actions = harness.exposed.createMwActions(ctx, store, (key) => String(key), { warn() {} });
  harness.setResponse(() => okValue({ id: 'ws-new' }));

  await actions.submitCreate({ name: '   ', primaryPath: 'D:\\FlowPrimary', roots: [] });

  assert.deepEqual(calls.rename, [{ workspaceId: 'ws-new', title: 'FlowPrimary' }], 'blank name falls back to the basename of the primary folder');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].init.body), {
    op: 'save',
    id: 'ws-new',
    name: 'FlowPrimary',
    path: 'D:\\FlowPrimary',
    roots: [],
  });
});

test('actions: submitModify renames and saves with deduped roots minus the primary folder', { skip: actionsSkip }, async () => {
  const harness = loadIntegrationHarness();
  const { ctx, calls } = createActionsCtx();
  const store = harness.exposed.createMwStore({ dialog: null });
  const actions = harness.exposed.createMwActions(ctx, store, (key) => String(key), { warn() {} });
  const state = { version: 1, workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\Primary', roots: ['E:\\A'] } } };
  harness.setResponse((_url, init) => {
    if (init && init.method === 'GET') return okValue(state);
    return okValue({ id: 'ws-1' });
  });

  const result = await actions.submitModify({
    workspace: { workspaceId: 'ws-1', title: '旧名', path: 'D:\\Old' },
    name: '新名',
    roots: ['D:\\Primary', 'E:\\B', 'd:\\primary\\', 'E:\\b'],
  });

  assert.equal(result.workspaceId, 'ws-1');
  assert.equal(result.title, '新名');
  assert.deepEqual(calls.rename, [{ workspaceId: 'ws-1', title: '新名' }], 'renaming happens before saving');
  assert.equal(harness.fetchCalls.length, 2, 'modify = GET current state + POST save');
  assert.equal(harness.fetchCalls[0].init.method, 'GET');
  assert.equal(harness.fetchCalls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(harness.fetchCalls[1].init.body), {
    op: 'save',
    id: 'ws-1',
    name: '新名',
    path: 'D:\\Primary',
    roots: ['E:\\B'],
  });
  assert.equal(store.getSnapshot().dialog, null);
});

test('actions: pickDirectory delegates and mwRequestFolderPick falls back to the browser', { skip: actionsSkip }, async () => {
  const harness = loadIntegrationHarness();
  const request = harness.exposed.mwRequestFolderPick;
  assert.equal(typeof request, 'function', '40-dialogs.js must expose mwRequestFolderPick in the shared closure');

  assert.deepEqual(toHost(await request({ pickDirectory: async () => ' E:\\Picked ' })), { kind: 'picked', paths: ['E:\\Picked'] });
  assert.deepEqual(toHost(await request({ pickDirectory: async () => null })), { kind: 'cancelled' }, 'a cancelled native pick is not an error');
  assert.deepEqual(toHost(await request({ pickDirectory: async () => { throw new Error('async boom'); } })), { kind: 'browse' }, 'a rejecting picker falls back to the in-app browser');
  assert.deepEqual(toHost(await request({ pickDirectory: () => { throw new Error('sync boom'); } })), { kind: 'browse' }, 'a synchronous picker throw falls back to the in-app browser');
  assert.deepEqual(toHost(await request({})), { kind: 'browse' }, 'a composition without pickDirectory uses the browser');
  assert.deepEqual(toHost(await request(null)), { kind: 'browse' });

  const { ctx, calls } = createActionsCtx();
  const store = harness.exposed.createMwStore({ dialog: null });
  const actions = harness.exposed.createMwActions(ctx, store, (key) => String(key), { warn() {} });
  ctx.uiWorkspace.pickDirectory = async () => {
    calls.pickDirectory += 1;
    return 'F:\\Native';
  };
  assert.equal(await actions.pickDirectory(), 'F:\\Native', 'actions.pickDirectory delegates to uiWorkspace.pickDirectory');
  assert.equal(calls.pickDirectory, 1);
});

test('actions: create dialog "add" uses the native picker, ignoring cancellation and surviving failures', { skip: actionsSkip }, async () => {
  const harness = loadIntegrationHarness();
  const { ctx, calls } = createActionsCtx();
  const store = harness.exposed.createMwStore({ dialog: null });
  const actions = harness.exposed.createMwActions(ctx, store, (key) => String(key), { warn() {} });
  let pickResult = 'E:\\Picked';
  ctx.uiWorkspace.pickDirectory = async () => {
    calls.pickDirectory += 1;
    return pickResult;
  };
  const vnode = harness.exposed.CreateWorkspaceDialog({ actions, t: (key) => String(key), dialog: { mode: 'create', workspace: null, flow: null } });
  const onAdd = findVnodeProp(vnode, 'onAdd');
  assert.equal(typeof onAdd, 'function', 'the create dialog must wire an onAdd handler');

  onAdd();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.pickDirectory, 1, 'the add button prefers the native picker');
  assert.equal(harness.fetchCalls.length, 0, 'picking a folder must not create anything yet');

  pickResult = null;
  assert.doesNotThrow(() => onAdd());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.pickDirectory, 2, 'a cancelled pick resolves quietly');

  ctx.uiWorkspace.pickDirectory = async () => {
    calls.pickDirectory += 1;
    throw new Error('picker unavailable');
  };
  assert.doesNotThrow(() => onAdd());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.pickDirectory, 3, 'a failing picker falls back without throwing into the dialog');
});

// ---------------------------------------------------------------------------
// Tests: source-folder rows (removable primary / drag reorder)
// ---------------------------------------------------------------------------

test('ui: source folder rows are draggable and the create primary row is removable', { skip: actionsSkip }, () => {
  const harness = loadIntegrationHarness();
  const text = (key) => String(key);
  const removed = [];
  const reordered = [];
  const vnode = harness.exposed.MwSourceFolders({
    folders: ['D:\\Primary', 'E:\\Member'],
    lockPrimary: false,
    draggable: true,
    busy: false,
    text,
    onAdd() {},
    onRemove: (index) => removed.push(index),
    onReorder: (from, to) => reordered.push([from, to]),
  });
  const isFolderRow = (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('mw-folder');
  const rows = collectVnodes(vnode, isFolderRow);
  assert.equal(rows.length, 2, 'one row per selected folder');
  for (const row of rows) {
    assert.equal(row.props.draggable, true, 'rows must be draggable when reordering is available');
    assert.ok(row.props.className.includes('mw-folder--draggable'), 'draggable rows advertise the class');
    assert.equal(row.props.title, 'action.dragFolder', 'draggable rows explain the gesture');
  }

  const removeButtonsOf = (row) => collectVnodes(row, (node) => node.type === 'button' && node.props['aria-label'] === 'action.removeFolder.aria');
  assert.equal(removeButtonsOf(rows[0]).length, 1, 'the create dialog allows deleting the primary folder too');
  assert.equal(removeButtonsOf(rows[1]).length, 1);
  removeButtonsOf(rows[0])[0].props.onClick();
  removeButtonsOf(rows[1])[0].props.onClick();
  assert.deepEqual(removed, [0, 1], 'remove buttons report their row index');

  const primaryBadge = collectVnodes(rows[0], (node) => node.props.className === 'mw-folder__badge')[0];
  assert.equal(primaryBadge.props.title, 'source.primaryHint', 'the dynamic primary badge explains drag reordering');

  const transfers = [];
  const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData(type, value) { transfers.push([type, value]); } };
  rows[0].props.onDragStart({ dataTransfer });
  assert.deepEqual(transfers, [['text/plain', '0']], 'drag start carries the row index');
  assert.equal(dataTransfer.effectAllowed, 'move');
  let prevented = false;
  rows[1].props.onDragOver({ dataTransfer, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'dragover accepts the drop');
  assert.equal(dataTransfer.dropEffect, 'move');
  assert.doesNotThrow(() => rows[1].props.onDragLeave());
  assert.doesNotThrow(() => rows[1].props.onDragEnd());
  assert.deepEqual(reordered, [], 'no reorder happens without a completed drop');
});

test('ui: modify dialog locks the primary folder and a single folder is not reorderable', { skip: actionsSkip }, () => {
  const harness = loadIntegrationHarness();
  const text = (key) => String(key);
  const isFolderRow = (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('mw-folder');

  const modify = harness.exposed.MwSourceFolders({
    folders: ['D:\\Primary', 'E:\\Member'],
    lockPrimary: true,
    draggable: true,
    busy: false,
    text,
    onAdd() {},
    onRemove() {},
    onReorder() {},
  });
  const rows = collectVnodes(modify, isFolderRow);
  assert.equal(rows.length, 2);
  const removeButtonsOf = (row) => collectVnodes(row, (node) => node.type === 'button' && node.props['aria-label'] === 'action.removeFolder.aria');
  assert.equal(removeButtonsOf(rows[0]).length, 0, 'modify mode must keep the primary folder locked');
  assert.equal(removeButtonsOf(rows[1]).length, 1, 'member folders stay removable in modify mode');
  const primaryBadge = collectVnodes(rows[0], (node) => node.props.className === 'mw-folder__badge')[0];
  assert.equal(primaryBadge.props.title, 'source.removePrimaryHint', 'the locked primary explains why it cannot be removed');

  const single = harness.exposed.MwSourceFolders({
    folders: ['D:\\Only'],
    lockPrimary: true,
    draggable: true,
    busy: false,
    text,
    onAdd() {},
    onRemove() {},
    onReorder() {},
  });
  const singleRow = collectVnodes(single, isFolderRow)[0];
  assert.equal(singleRow.props.draggable, false, 'a single folder is not reorderable');
  assert.equal(singleRow.props.onDragStart, undefined);
  assert.equal(singleRow.props.className.includes('mw-folder--draggable'), false);
});
