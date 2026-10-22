/**
 * Host bridge and shared client state for dsh-multi-workspace.
 *
 * The Host plugin owns the durable record and the model-facing prompt section;
 * this module only reads/writes the exact Fetch route it registers. All helpers
 * here are pure or self-contained so they can be unit-tested without a browser.
 */

/** Exact Fetch route registered by the Host half. */
const MW_API_PATH = '/api/multi-workspace/state';

/** Minimal external store; components subscribe through useSyncExternalStore. */
function createMwStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(patch) {
      const next = typeof patch === 'function' ? patch(snapshot) : { ...snapshot, ...patch };
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* a listener must not break the store */ }
      }
    },
  };
}

/** Read one JSON answer from the plugin's Host route; fold non-2xx and Host errors into Error. */
async function mwFetchJson(method, body) {
  let response;
  try {
    response = await fetch(MW_API_PATH, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error('无法连接 DSH 服务：' + mwErrorMessage(cause));
  }
  let payload;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok || payload === undefined || payload.ok !== true) {
    const detail = payload && payload.error && typeof payload.error.message === 'string'
      ? payload.error.message
      : 'HTTP ' + String(response.status);
    throw new Error(detail);
  }
  return payload.value;
}

/** Load the complete multi-folder state. Always resolves to a workspace map. */
async function mwLoadState() {
  const value = await mwFetchJson('GET');
  if (!value || typeof value !== 'object' || value.workspaces === null || typeof value.workspaces !== 'object') {
    return { version: 1, workspaces: {} };
  }
  return { version: value.version || 1, workspaces: value.workspaces };
}

/** Persist one workspace record (primary folder + member folders). */
async function mwSaveWorkspace(record) {
  return mwFetchJson('POST', {
    op: 'save',
    id: record.id,
    name: record.name || '',
    path: record.path,
    roots: Array.isArray(record.roots) ? record.roots : [],
  });
}

/** Forget one workspace record; folders and sessions are untouched. */
async function mwRemoveWorkspace(id) {
  return mwFetchJson('POST', { op: 'remove', id });
}

/** Human-readable message for an unknown thrown value. */
function mwErrorMessage(value) {
  if (value instanceof Error && typeof value.message === 'string' && value.message) return value.message;
  if (value && typeof value === 'object' && typeof value.message === 'string' && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return String(value);
}

/** Last path segment of a Windows or POSIX absolute path. */
function mwBasename(path) {
  if (typeof path !== 'string') return '';
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Parent of an absolute path, or undefined at a drive/root. */
function mwDirname(path) {
  if (typeof path !== 'string') return undefined;
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (at <= 0) return undefined;
  const parent = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent;
}

/** Case/normalized key used only for local display dedupe, never for Host identity. */
function mwPathKey(path) {
  if (typeof path !== 'string') return '';
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase();
}

/** Member folders for one workspace id from a state document. */
function mwRecordFor(state, workspaceId) {
  if (!state || !state.workspaces || typeof workspaceId !== 'string') return undefined;
  return state.workspaces[workspaceId];
}

/** Member folders (primary excluded) for one workspace, defaulting to none. */
function mwRecordRoots(state, workspaceId) {
  const record = mwRecordFor(state, workspaceId);
  return record && Array.isArray(record.roots) ? record.roots.slice() : [];
}

/** Primary folder for one workspace, preferring the durable record over the snapshot. */
function mwRecordPrimaryPath(state, workspace) {
  const record = workspace === undefined ? undefined : mwRecordFor(state, workspace.workspaceId);
  if (record && typeof record.path === 'string' && record.path) return record.path;
  return workspace && typeof workspace.path === 'string' ? workspace.path : '';
}

/** Dedupe selected folders, drop the primary folder and reject blank/non-absolute entries. */
function mwNormalizeSelection(paths, primaryPath) {
  const primary = typeof primaryPath === 'string' ? primaryPath.trim() : '';
  const primaryKey = mwPathKey(primary);
  const seen = new Set();
  const kept = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    if (typeof value !== 'string') continue;
    const path = value.trim();
    if (!path || !/^([A-Za-z]:[\\/]|\\\\)/.test(path)) continue;
    const key = mwPathKey(path);
    if (!key || key === primaryKey || seen.has(key)) continue;
    seen.add(key);
    kept.push(path);
  }
  return kept;
}

/** Resolve a Workspace by the display label carried by a native aria-label. */
function mwFindWorkspaceByLabel(items, label) {
  if (!Array.isArray(items) || typeof label !== 'string') return undefined;
  const needle = label.normalize('NFKC').trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const titled = items.filter((item) => item && typeof item.title === 'string' && item.title.trim());
  const exact = titled.filter((item) => item.title.normalize('NFKC').trim().toLocaleLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const contained = titled.filter((item) => needle.includes(item.title.normalize('NFKC').trim().toLocaleLowerCase()));
  return contained.length === 1 ? contained[0] : undefined;
}
