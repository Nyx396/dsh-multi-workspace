window.__ModuleLoader__.load({
  id: "dsh-multi-workspace",
  factory(require) {
    'use strict';
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const Fragment = React.Fragment;
    //#region src/client/10-api.js
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
    //#endregion
    //#region src/client/15-i18n.js
    /**
     * Locale dictionaries for dsh-multi-workspace.
     *
     * The plugin registers `MW_DICTS` through `ctx.locale.register(ns, locale, dict)`
     * (the wiring lives in 90-apply.js) and receives a bound `t(key, params)` from
     * there. Components never create their own translator: they use the injected
     * function, and fall back to this table only when no `t` is available (for
     * example while a fragment is rendered by the unit smoke harness).
     *
     * Keys are dotted, English-complete and use `{name}` placeholders. Both
     * dictionaries must keep the same key set; the smoke test enforces that.
     */

    /** Locale namespace shared by every string this plugin contributes. */
    const MW_I18N_NS = 'multi-workspace';

    /** Simplified Chinese dictionary: the key-set source of truth. */
    const MW_DICTS_ZH = {
      // Dialog chrome and fields.
      'dialog.create.title': '创建工作区',
      'dialog.modify.title': '修改工作区',
      'dialog.loading': '正在读取工作区…',
      'dialog.eyebrow': 'DSH / 工作台',
      'dialog.footnote': '文件夹保留在原位置',
      'overview.title': '一个工作区，多个文件夹',
      'overview.description': '把相关代码、文档与资源组织在一起。',
      'overview.summary': '工作区概览',
      'overview.folders': '个文件夹',
      'section.workspace': '工作区信息',
      'field.name.hint': '留空时使用主文件夹的名称。',
      'field.name.modifyHint': '留空时保留工作区的原名称。',
      'source.emptyTitle': '从第一个文件夹开始',
      'source.addMore': '继续关联项目文件夹',
      'source.count': '{n} 个',
      'source.reorderHint': '首项为主文件夹，拖动可调整顺序。',
      'source.lockedHint': '主文件夹已固定，成员文件夹可随时调整。',
      'field.name.label': '工作区名称',
      'field.name.placeholder': '工作区名称',
      'section.sourceFolder': '源文件夹',
      'badge.primary': '主文件夹',
      'source.addPrompt': '在此电脑上添加文件夹',
      'source.noSelection': '未选择文件夹',
      'source.removePrimaryHint': '主文件夹是会话的工作目录，不能移除；如需更换请重新创建工作区。',
      'source.primaryHint': '列表第一项是主文件夹；拖动文件夹行可调整顺序。',

      // Shared actions.
      'action.add': '添加',
      'action.addFolder': '添加文件夹',
      'action.addSelected': '添加所选',
      'action.cancel': '取消',
      'action.close': '关闭',
      'action.create': '创建',
      'action.creating': '正在创建…',
      'action.open': '打开',
      'action.remove': '移除',
      'action.removeFolder': '移除文件夹',
      'action.removeFolder.aria': '移除文件夹“{path}”',
      'action.dragFolder': '拖动调整顺序',
      'action.retry': '重试',
      'action.save': '保存',
      'action.saving': '正在保存…',

      // Stacked folder browser.
      'browser.title': '添加文件夹',
      'browser.path': '路径',
      'browser.up': '上一级',
      'browser.loading': '正在加载…',
      'browser.empty': '这个文件夹里没有可添加的子文件夹',
      'browser.truncated': '文件夹过多，仅显示开头部分。',
      'browser.showHidden': '显示隐藏文件夹',
      'browser.selectedCount': '已选择 {n} 个文件夹',
      'browser.noSelection': '未选择文件夹',
      'browser.selectFolder': '选择文件夹“{name}”',
      'browser.openFolder': '打开文件夹“{name}”',
      'browser.crumbs': '路径导航',
      'browser.newFolder': '新建文件夹',
      'browser.folderName': '文件夹名称',
      'browser.createFolder': '创建文件夹',
      'browser.cancelCreate': '取消新建',
      'browser.error': '无法读取文件夹：{message}',
      'browser.errorPath': '无法打开路径：{message}',
      'browser.errorCreate': '无法新建文件夹：{message}',
      'browser.nameRequired': '请输入文件夹名称',

      // Failures surfaced inside a dialog (role=alert), never thrown.
      'error.noFolder': '请至少添加一个文件夹',
      'error.noWorkspace': '找不到要修改的工作区',
      'error.submit': '无法创建工作区，请重试',
      'error.save': '无法保存工作区，请重试',
      'error.load': '无法读取工作区信息：{message}',
      'error.noAction': '当前界面无法执行该操作',

      // Workspace row menu augmentation (50-menu.js consumes these through t).
      'menu.modify': '修改工作区',
      'menu.modify.aria': '修改工作区“{name}”',
      'menu.modifyWorkspace': '修改工作区',
      'menu.modifyWorkspace.aria': '修改工作区“{name}”',
    };

    /** English dictionary, key-complete against the Chinese source of truth. */
    const MW_DICTS_EN = {
      'dialog.create.title': 'New Workspace',
      'dialog.modify.title': 'Edit Workspace',
      'dialog.loading': 'Loading workspace…',
      'dialog.eyebrow': 'DSH / WORKBENCH',
      'dialog.footnote': 'Folders stay in their original location',
      'overview.title': 'One workspace. Connected folders.',
      'overview.description': 'Bring related code, documents and resources together.',
      'overview.summary': 'WORKSPACE OVERVIEW',
      'overview.folders': 'folders',
      'section.workspace': 'Workspace details',
      'field.name.hint': 'Leave blank to use the primary folder’s name.',
      'field.name.modifyHint': 'Leave blank to keep the current workspace name.',
      'source.emptyTitle': 'Start with your first folder',
      'source.addMore': 'Connect another project folder',
      'source.count': '{n} total',
      'source.reorderHint': 'The first folder is primary. Drag to reorder.',
      'source.lockedHint': 'The primary folder is fixed. Member folders can be changed.',
      'field.name.label': 'Workspace name',
      'field.name.placeholder': 'Workspace name',
      'section.sourceFolder': 'Source folders',
      'badge.primary': 'Primary folder',
      'source.addPrompt': 'Add a folder on this computer',
      'source.noSelection': 'No folders selected',
      'source.removePrimaryHint': 'The primary folder is the session working directory and cannot be removed. Create a new workspace to change it.',
      'source.primaryHint': 'The first row is the primary folder; drag folder rows to reorder them.',

      'action.add': 'Add',
      'action.addFolder': 'Add folder',
      'action.addSelected': 'Add selected',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.create': 'Create',
      'action.creating': 'Creating…',
      'action.open': 'Open',
      'action.remove': 'Remove',
      'action.removeFolder': 'Remove folder',
      'action.removeFolder.aria': 'Remove folder "{path}"',
      'action.dragFolder': 'Drag to reorder',
      'action.retry': 'Retry',
      'action.save': 'Save',
      'action.saving': 'Saving…',

      'browser.title': 'Add folders',
      'browser.path': 'Path',
      'browser.up': 'Up one level',
      'browser.loading': 'Loading…',
      'browser.empty': 'This folder has no subfolders to add',
      'browser.truncated': 'Too many folders; only the beginning is shown.',
      'browser.showHidden': 'Show hidden folders',
      'browser.selectedCount': 'Selected {n} folder(s)',
      'browser.noSelection': 'No folders selected',
      'browser.selectFolder': 'Select folder "{name}"',
      'browser.openFolder': 'Open folder "{name}"',
      'browser.crumbs': 'Path',
      'browser.newFolder': 'New folder',
      'browser.folderName': 'Folder name',
      'browser.createFolder': 'Create folder',
      'browser.cancelCreate': 'Cancel',
      'browser.error': 'Could not read the folder: {message}',
      'browser.errorPath': 'Could not open the path: {message}',
      'browser.errorCreate': 'Could not create the folder: {message}',
      'browser.nameRequired': 'Enter a folder name',

      'error.noFolder': 'Add at least one folder',
      'error.noWorkspace': 'The workspace to edit was not found',
      'error.submit': 'Could not create the workspace. Try again.',
      'error.save': 'Could not save the workspace. Try again.',
      'error.load': 'Could not load workspace details: {message}',
      'error.noAction': 'This action is not available on this screen',

      'menu.modify': 'Edit Workspace',
      'menu.modify.aria': 'Edit workspace "{name}"',
      'menu.modifyWorkspace': 'Edit Workspace',
      'menu.modifyWorkspace.aria': 'Edit workspace "{name}"',
    };

    /** All dictionaries handed to `ctx.locale.register`. */
    const MW_DICTS = Object.freeze({
      zh: Object.freeze(MW_DICTS_ZH),
      en: Object.freeze(MW_DICTS_EN),
    });

    /** Keys of the Chinese dictionary; useful to assert locale completeness. */
    const MW_I18N_KEYS = Object.freeze(Object.keys(MW_DICTS_ZH));

    /** Replace `{name}` placeholders without throwing on missing/odd values. */
    function mwI18nFormat(template, params) {
      if (typeof template !== 'string') return '';
      if (!params || typeof params !== 'object') return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }

    /** Pick the dictionary for a BCP 47-ish locale id, defaulting to Chinese. */
    function mwI18nDictionary(locale) {
      return /^en\b/i.test(String(locale || '')) ? MW_DICTS.en : MW_DICTS.zh;
    }

    /** Translate one key with `MW_DICTS`; used only when no injected `t` exists. */
    function mwI18nTranslator(locale) {
      const primary = mwI18nDictionary(locale);
      return function translate(key, params) {
        const text = Object.prototype.hasOwnProperty.call(primary, key)
          ? primary[key]
          : MW_DICTS.zh[key];
        return mwI18nFormat(typeof text === 'string' ? text : key, params);
      };
    }
    //#endregion
    //#region src/client/20-ui-kit.js
    /**
     * Small UI kit shared by the multi-workspace dialogs: inline SVG icons, the
     * button variants, the portal modal shell and the single CSS string injected by
     * 90-apply.js.
     *
     * Every rule is prefixed `mw-`; local design tokens inherit DSH surfaces, so
     * light/dark switching and the reduced-motion preference come from DSH itself.
     * `Modal` owns the portal, mask, Esc handling, focus trap, focus ring and
     * aria-modal wiring; it is the only place that touches `document`.
     */

    /** Icon paths drawn in a 24x24 view box; every shape inherits currentColor. */
    const MW_ICON_PATHS = Object.freeze({
      folder: [
        h('path', { key: 'body', d: 'M3.5 7.5a2 2 0 0 1 2-2h3l1.9 2.2h8.1a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z' }),
      ],
      'folder-plus': [
        h('path', { key: 'body', d: 'M3.5 7.5a2 2 0 0 1 2-2h3l1.9 2.2h8.1a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z' }),
        h('path', { key: 'plus', d: 'M12 11.2v5.2M9.4 13.8h5.2' }),
      ],
      plus: [h('path', { key: 'plus', d: 'M12 5v14M5 12h14' })],
      close: [h('path', { key: 'x', d: 'm6 6 12 12M18 6 6 18' })],
      'chevron-down': [h('path', { key: 'v', d: 'm6 9.5 6 6 6-6' })],
      'chevron-right': [h('path', { key: 'v', d: 'm9.5 6 6 6-6 6' })],
      'chevron-left': [h('path', { key: 'v', d: 'm14.5 6-6 6 6 6' })],
      'arrow-up': [h('path', { key: 'up', d: 'M12 19V5M6 11l6-6 6 6' })],
      pencil: [
        h('path', { key: 'body', d: 'M4 20h4.2L19.4 8.8a2.1 2.1 0 0 0-3-3L5.2 16.9Z' }),
        h('path', { key: 'line', d: 'M14.6 6.6l3 3' }),
      ],
      search: [
        h('circle', { key: 'ring', cx: 10.5, cy: 10.5, r: 6.2 }),
        h('path', { key: 'line', d: 'm15.2 15.2 4.6 4.6' }),
      ],
      check: [h('path', { key: 'v', d: 'm5 12.5 4.4 4.4L19 7.2' })],
      home: [h('path', { key: 'roof', d: 'm4 10.5 8-6.5 8 6.5M6.6 9.2V19h10.8V9.2' })],
      drive: [
        h('rect', { key: 'box', x: 3.5, y: 5, width: 17, height: 10, rx: 2 }),
        h('path', { key: 'base', d: 'M7 19h10M10 18.4h.01M13 18.4h.01' }),
      ],
      alert: [
        h('path', { key: 'ring', d: 'M12 4.2 3 20h18ZM12 9.5v4.4M12 17.2h.01' }),
      ],
      refresh: [
        h('path', { key: 'arc', d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { key: 'head', d: 'M20 4.2V9.5h-5.3' }),
      ],
      workspace: [
        h('rect', { key: 'main', x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { key: 'member', x: 14, y: 14, width: 7, height: 7, rx: 1.5 }),
        h('path', { key: 'link', d: 'M14 6.5h3.5v4M6.5 14v3.5h4' }),
      ],
      grip: [
        h('path', { key: 'dots', d: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01', strokeWidth: 3 }),
      ],
      lock: [
        h('rect', { key: 'body', x: 6, y: 10, width: 12, height: 10, rx: 2 }),
        h('path', { key: 'shackle', d: 'M8.5 10V7a3.5 3.5 0 0 1 7 0v3M12 14v2' }),
      ],
    });

    /** Draw one named icon; unknown kinds fall back to a folder. */
    function Icon(props) {
      const kind = props && props.kind ? props.kind : 'folder';
      const size = props && Number.isFinite(props.size) ? props.size : 20;
      const rest = props ? { ...props } : {};
      delete rest.kind;
      delete rest.size;
      const shape = MW_ICON_PATHS[kind] || MW_ICON_PATHS.folder;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        ...rest,
      }, shape);
    }

    /** Prefer the injected DSH translator, falling back to the bundled table. */
    function mwUiText(t, key, params) {
      if (typeof t === 'function') {
        try {
          const value = t(key, params);
          if (typeof value === 'string' && value && value !== key) return value;
        } catch { /* the injected translator must never break rendering */ }
      }
      return mwI18nTranslator('zh')(key, params);
    }

    /** Button with the three variants the dialogs need. */
    function Button(props) {
      const variant = props.variant === 'primary' || props.variant === 'outline' ? props.variant : 'ghost';
      const rest = { ...props };
      delete rest.variant;
      delete rest.size;
      delete rest.icon;
      delete rest.children;
      const className = [
        'mw-btn',
        variant === 'ghost' ? '' : 'mw-btn--' + variant,
        props.size === 'sm' ? 'mw-btn--sm' : '',
        props.className || '',
      ].filter(Boolean).join(' ');
      rest.type = rest.type || 'button';
      rest.className = className;
      return h('button', rest, props.icon || null, props.children);
    }

    /** Focusable descendants used by the modal focus trap. */
    const MW_FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

    /** Nested modal stack: Esc/Tab only act on the top-most dialog. */
    const MW_MODAL_STACK = [];

    /** Body scroll lock shared by stacked modals. */
    const MW_SCROLL_LOCK = { count: 0, overflow: '', paddingRight: '' };

    /** Disable page scrolling while at least one modal is mounted. */
    function mwLockPageScroll() {
      if (typeof document === 'undefined' || !document.body) return;
      const lock = MW_SCROLL_LOCK;
      if (lock.count === 0) {
        lock.overflow = document.body.style.overflow;
        lock.paddingRight = document.body.style.paddingRight;
        document.body.style.overflow = 'hidden';
      }
      lock.count += 1;
    }

    /** Restore page scrolling once the last modal unmounts. */
    function mwUnlockPageScroll() {
      const lock = MW_SCROLL_LOCK;
      if (lock.count > 0) lock.count -= 1;
      if (lock.count > 0 || typeof document === 'undefined' || !document.body) return;
      document.body.style.overflow = lock.overflow;
      document.body.style.paddingRight = lock.paddingRight;
    }

    /**
     * Portal modal shell.
     *
     * @param props.title       - visible dialog title (string).
     * @param props.closeLabel  - accessible label for the X button.
     * @param props.onClose     - invoked by X, Esc and a mask click.
     * @param props.layer       - stacking level; the folder browser uses 1.
     * @param props.className   - extra classes for the dialog card.
     * @param props.initialFocusRef - element focused after mount.
     * @param props.describedBy - optional id of the description element.
     */
    function Modal(props) {
      const reactId = React.useId();
      const titleId = props.titleId || 'mw-title-' + reactId;
      const dialogRef = React.useRef(null);
      const tokenRef = React.useRef(null);
      const previousFocusRef = React.useRef(null);
      const onCloseRef = React.useRef(props.onClose);
      onCloseRef.current = props.onClose;
      const initialFocusRef = props.initialFocusRef;

      React.useEffect(() => {
        const token = tokenRef.current || { id: reactId };
        tokenRef.current = token;
        MW_MODAL_STACK.push(token);
        previousFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null;
        mwLockPageScroll();
        const dialog = dialogRef.current;
        const frame = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => {
            const target = initialFocusRef && initialFocusRef.current ? initialFocusRef.current : dialog;
            try { target?.focus?.(); } catch { /* focus is best effort */ }
          })
          : null;

        const topMost = () => MW_MODAL_STACK[MW_MODAL_STACK.length - 1] === token;
        const close = () => {
          try { onCloseRef.current?.(); } catch { /* a close handler must not throw */ }
        };
        const keydown = (event) => {
          if (!topMost()) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== 'Tab' || !dialog) return;
          const focusables = [...dialog.querySelectorAll(MW_FOCUSABLE_SELECTOR)]
            .filter((node) => node && (node.offsetParent !== null || node === document.activeElement));
          if (focusables.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === first || active === dialog)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', keydown, true);
        return () => {
          document.removeEventListener('keydown', keydown, true);
          if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
          const at = MW_MODAL_STACK.lastIndexOf(token);
          if (at >= 0) MW_MODAL_STACK.splice(at, 1);
          mwUnlockPageScroll();
          const previous = previousFocusRef.current;
          if (previous && typeof previous.focus === 'function') {
            try { previous.focus(); } catch { /* element may be gone */ }
          }
        };
      }, []);

      const maskDown = (event) => {
        if (event && event.target === event.currentTarget) {
          try { onCloseRef.current?.(); } catch { /* ignore */ }
        }
      };
      const className = ['mw-dialog', props.className || ''].filter(Boolean).join(' ');
      const describedBy = props.describedBy;
      return createPortal(
        h('div', { className: 'mw-overlay', style: { zIndex: 1000 + (Number.isFinite(props.layer) ? props.layer : 0) * 10 } },
          h('div', { className: 'mw-mask', 'aria-hidden': true, onPointerDown: maskDown, onMouseDown: maskDown }),
          h('div', {
            ref: dialogRef,
            className,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            ...(describedBy ? { 'aria-describedby': describedBy } : null),
            tabIndex: -1,
          },
            h('header', { className: 'mw-dialog__header' },
              h('div', { className: 'mw-dialog__heading' },
                h('span', { className: 'mw-dialog__mark' }, h(Icon, { kind: props.icon || 'workspace', size: 23 })),
                h('div', null,
                  h('p', { className: 'mw-dialog__eyebrow' }, props.eyebrow || mwUiText(null, 'dialog.eyebrow')),
                  h('h2', { className: 'mw-dialog__title', id: titleId }, props.title))),
              h('button', {
                type: 'button',
                className: 'mw-icon-button',
                onClick: () => { try { onCloseRef.current?.(); } catch { /* ignore */ } },
                'aria-label': props.closeLabel || mwUiText(null, 'action.close'),
                title: props.closeLabel || mwUiText(null, 'action.close'),
              }, h(Icon, { kind: 'close', size: 16 }))),
            props.children)),
        document.body,
      );
    }

    /**
     * Scoped design tokens combine DSH theme surfaces with a blue-cyan accent.
     * The host supplies light/dark surface and text tokens; all rules stay local.
     */
    const MW_CSS = `
    .mw-overlay{--mw-surface:var(--dsw-alias-bg-layer-2,#151c25);--mw-inset:var(--dsw-alias-bg-layer-1,#10161e);--mw-raised:var(--dsw-alias-bg-layer-3,#1f2935);--mw-text:var(--dsw-alias-label-primary,#edf3fa);--mw-muted:var(--dsw-alias-label-secondary,#9eafc1);--mw-subtle:var(--dsw-alias-label-tertiary,#7b8da1);--mw-line:var(--dsw-alias-border-l3,#31404e);--mw-accent:color-mix(in srgb,#0997bb 75%,var(--mw-text) 25%);--mw-accent-soft:color-mix(in srgb,var(--mw-accent) 10%,var(--mw-surface));--mw-fill:#087f9d;--mw-on-fill:#fff;--mw-error:var(--dsw-alias-label-error,#ec818a);position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:inherit;font-size:14px;line-height:1.5}
    .mw-overlay *{box-sizing:border-box}
    .mw-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,#020912a6);backdrop-filter:blur(5px);animation:mw-fade-in .16s ease}
    .mw-dialog{position:relative;z-index:1;display:flex;flex-direction:column;width:min(640px,100%);max-height:min(780px,calc(100dvh - 48px));overflow:hidden;border:1px solid var(--mw-line);border-radius:18px;background:var(--mw-surface);color:var(--mw-text);box-shadow:0 28px 100px #0005,0 4px 20px #0002;font:inherit;animation:mw-dialog-in .18s ease;outline:none}
    .mw-dialog :is(button,input):focus-visible,.mw-dialog:focus-visible{outline:2px solid var(--mw-accent);outline-offset:3px}
    .mw-dialog--workspace{width:min(850px,100%)}
    .mw-dialog__header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 26px;border-bottom:1px solid var(--mw-line)}
    .mw-dialog__heading{display:flex;align-items:center;gap:13px;min-width:0}
    .mw-dialog__mark{display:grid;place-items:center;flex:none;width:44px;height:44px;border:1px solid color-mix(in srgb,var(--mw-accent) 25%,var(--mw-line));border-radius:12px;color:var(--mw-accent);background:var(--mw-accent-soft)}
    .mw-dialog__eyebrow{margin:0 0 3px;color:var(--mw-muted);font-size:10px;line-height:16px;font-weight:600;letter-spacing:.13em}
    .mw-dialog__title{margin:0;font-size:20px;line-height:28px;letter-spacing:-.02em;font-weight:600;overflow-wrap:anywhere}
    .mw-workbench{display:grid;grid-template-columns:206px minmax(0,1fr);min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--mw-line) transparent}
    .mw-overview{display:flex;flex-direction:column;justify-content:space-between;gap:32px;padding:28px 24px;background:radial-gradient(ellipse at 0 0,color-mix(in srgb,var(--mw-accent) 9%,transparent),transparent 70%),var(--mw-inset);border-right:1px solid var(--mw-line)}
    .mw-overview__glyph{display:inline-flex;color:var(--mw-accent);margin:0 0 18px}
    .mw-overview__title{font-size:21px;line-height:1.5;font-weight:550;letter-spacing:-.025em;margin:0 0 12px;text-wrap:balance}
    .mw-overview__description{margin:0;color:var(--mw-muted);font-size:12px;line-height:1.85}
    .mw-overview__summary{border-top:1px solid var(--mw-line);padding-top:18px}
    .mw-overview__label{margin:0;color:var(--mw-subtle);font-size:10px;letter-spacing:.07em}
    .mw-overview__count{display:flex;align-items:baseline;gap:10px;margin:8px 0 18px;color:var(--mw-muted);font-size:11px}
    .mw-overview__count strong{font-size:38px;line-height:1.2;font-weight:500;letter-spacing:-.04em;color:var(--mw-accent);font-variant-numeric:tabular-nums}
    .mw-overview__primary{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--mw-subtle);min-width:0}
    .mw-overview__primary strong{font-size:12px;color:var(--mw-muted);font-weight:500;overflow-wrap:anywhere}
    .mw-dialog__body{display:flex;flex-direction:column;gap:28px;min-height:0;padding:28px;min-width:0}
    .mw-dialog__footer{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:18px 26px;border-top:1px solid var(--mw-line);background:var(--mw-surface)}
    .mw-dialog__footnote{flex:1;min-width:0;font-size:11px;color:var(--mw-subtle);padding-right:12px}
    .mw-icon-button{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--mw-muted);cursor:pointer;line-height:1}
    .mw-icon-button:hover:not(:disabled){background:var(--mw-raised);color:var(--mw-text)}
    .mw-icon-button:disabled{cursor:default;opacity:.4}
    .mw-icon-button--danger:hover:not(:disabled){background:color-mix(in srgb,var(--mw-error) 10%,var(--mw-surface));color:var(--mw-error)}
    .mw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:7px 16px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--mw-muted);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s}
    .mw-btn:hover:not(:disabled){background:var(--mw-raised);color:var(--mw-text)}
    .mw-btn:active:not(:disabled){transform:translateY(1px)}
    .mw-btn:disabled{cursor:not-allowed;opacity:.4}
    .mw-btn--primary{background:var(--mw-fill);color:var(--mw-on-fill);border-color:var(--mw-fill);box-shadow:0 2px 4px #0001}
    .mw-btn--primary:hover:not(:disabled){background:color-mix(in srgb,var(--mw-fill) 88%,#000);border-color:transparent;color:var(--mw-on-fill)}
    .mw-btn--outline{border-color:var(--mw-line);color:var(--mw-text);background:var(--mw-surface)}
    .mw-btn--outline:hover:not(:disabled){border-color:var(--mw-accent);background:var(--mw-accent-soft)}
    .mw-btn--sm{min-height:30px;padding:4px 11px;font-size:12px}
    .mw-section{display:flex;flex-direction:column;gap:10px;min-width:0}
    .mw-section__heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .mw-section__label{display:flex;align-items:center;gap:10px;margin:0;color:var(--mw-text);font-size:13px;line-height:20px;font-weight:550}
    .mw-section__number{font:11px/20px Consolas,monospace;color:var(--mw-accent);letter-spacing:.04em}
    .mw-section__count{font-size:11px;color:var(--mw-subtle)}
    .mw-field__label{margin-top:6px;font-size:12px;color:var(--mw-muted)}
    .mw-field{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 13px;border:1px solid var(--mw-line);border-radius:9px;background:var(--mw-inset);transition:border-color .12s,box-shadow .12s}
    .mw-field:focus-within{border-color:var(--mw-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-accent) 12%,transparent)}
    .mw-field__icon{flex:none;color:var(--mw-subtle)}
    .mw-input{flex:1;min-width:0;height:42px;padding:0;border:0;background:transparent;color:var(--mw-text);font:inherit;font-size:13px;outline:none!important}
    .mw-input::placeholder{color:var(--mw-subtle)}
    .mw-field__hint{margin:0;color:var(--mw-subtle);font-size:11px;line-height:18px}
    .mw-source{display:flex;flex-direction:column;min-width:0;border:1px solid var(--mw-line);border-radius:11px;overflow:hidden;background:var(--mw-inset)}
    .mw-source__list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
    .mw-source__empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:210px;padding:26px 16px;text-align:center}
    .mw-source__empty-icon{display:grid;place-items:center;width:58px;height:58px;margin-bottom:5px;border:1px dashed color-mix(in srgb,var(--mw-accent) 50%,var(--mw-line));border-radius:15px;background:var(--mw-accent-soft);color:var(--mw-accent)}
    .mw-source__empty-title{margin:0;font-size:13px;font-weight:550;color:var(--mw-text)}
    .mw-source__status{margin:0;font-size:11px;line-height:18px;color:var(--mw-subtle)}
    .mw-source__empty .mw-btn{margin-top:8px}
    .mw-source__add-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border-top:1px solid var(--mw-line);background:var(--mw-surface)}
    .mw-source__hint{display:flex;align-items:flex-start;gap:6px;margin:0;color:var(--mw-subtle);font-size:11px;line-height:18px}
    .mw-source__hint svg{flex:none;margin-top:2px}
    .mw-folder{display:flex;align-items:center;gap:10px;min-height:76px;padding:14px 12px}
    .mw-folder + .mw-folder{border-top:1px solid var(--mw-line)}
    .mw-folder--draggable{cursor:grab}
    .mw-folder--draggable:active{cursor:grabbing}
    .mw-folder--dragging{opacity:.45}
    .mw-folder--dragover{box-shadow:inset 0 3px 0 var(--mw-accent);background:var(--mw-accent-soft)}
    .mw-folder__grip{flex:none;color:var(--mw-subtle);opacity:.65}
    .mw-folder__tile{display:grid;place-items:center;width:35px;height:35px;flex:none;border-radius:9px;border:1px solid var(--mw-line);background:var(--mw-surface);color:var(--mw-muted)}
    .mw-folder__tile--primary{color:var(--mw-accent);border-color:color-mix(in srgb,var(--mw-accent) 30%,var(--mw-line));background:var(--mw-accent-soft)}
    .mw-folder__details{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
    .mw-folder__name{font-size:13px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
    .mw-folder__path{font:11px/17px Consolas,'Microsoft YaHei UI',monospace;color:var(--mw-subtle);overflow-wrap:anywhere;word-break:break-word}
    .mw-folder__badge{flex:none;padding:2px 6px;border:1px solid color-mix(in srgb,var(--mw-accent) 25%,var(--mw-line));border-radius:5px;background:var(--mw-accent-soft);color:var(--mw-accent);font-size:10px;line-height:16px;white-space:nowrap}
    .mw-folder__lock{flex:none;color:var(--mw-subtle);margin:0 7px}
    .mw-alert{display:flex;flex-direction:column;gap:4px;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--mw-error) 35%,var(--mw-line));border-radius:8px;background:color-mix(in srgb,var(--mw-error) 7%,var(--mw-surface));list-style:none;color:var(--mw-error);font-size:12px;line-height:18px;overflow-wrap:anywhere}
    .mw-alert--inline{padding:0}
    .mw-spinner{display:inline-block;flex:none;width:14px;height:14px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mw-spin .8s linear infinite}
    .mw-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .mw-dialog--browser{width:min(680px,100%);height:min(580px,calc(100dvh - 48px))}
    .mw-browser{display:flex;flex-direction:column;min-height:0;flex:1}
    .mw-browser__nav{flex:none;display:flex;flex-direction:column;gap:10px;padding:18px 24px 12px}
    .mw-crumbs{display:flex;align-items:center;gap:2px;min-height:24px;overflow-x:auto;scrollbar-width:thin}
    .mw-crumb{flex:none;max-width:180px;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:var(--mw-muted);font:inherit;font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
    .mw-crumb:hover,.mw-crumb--current{color:var(--mw-accent)}
    .mw-crumb__sep{flex:none;color:var(--mw-subtle);display:inline-flex}
    .mw-pathbar{display:flex;align-items:center;gap:8px}
    .mw-pathbar .mw-icon-button{width:36px;height:36px;border-color:var(--mw-line)}
    .mw-path-input{flex:1;min-width:0;height:36px;padding:0 11px;border:1px solid var(--mw-line);border-radius:8px;background:var(--mw-inset);color:var(--mw-text);font:inherit;font-size:12px;line-height:20px;outline:none}
    .mw-browser__toolbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 24px 14px}
    .mw-browser__status{margin:0;font-size:11px;line-height:18px;color:var(--mw-muted)}
    .mw-browser__list{flex:1;min-height:0;display:flex;flex-direction:column;gap:3px;overflow-y:auto;padding:0 16px 12px;scrollbar-width:thin;scrollbar-color:var(--mw-line) transparent}
    .mw-browser__row{display:flex;align-items:center;gap:4px;min-height:42px;padding:3px 8px;border:1px solid transparent;border-radius:8px}
    .mw-browser__row:hover{background:var(--mw-raised)}
    .mw-browser__row--selected,.mw-browser__row--selected:hover{background:var(--mw-accent-soft);border-color:color-mix(in srgb,var(--mw-accent) 30%,var(--mw-line))}
    .mw-browser__select{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:5px 0;cursor:pointer;user-select:none}
    .mw-browser__checkbox{flex:none;width:15px;height:15px;margin:0;accent-color:var(--mw-fill);cursor:pointer}
    .mw-browser__icon{flex:none;color:var(--mw-accent)}
    .mw-browser__name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
    .mw-browser__enter{flex:none;width:28px;height:28px;color:var(--mw-subtle)}
    .mw-browser__empty{padding:36px 12px;text-align:center;font-size:12px;line-height:18px;color:var(--mw-subtle)}
    .mw-browser>.mw-alert{margin:0 24px 10px}
    .mw-browser__footer{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:16px 24px;border-top:1px solid var(--mw-line)}
    .mw-browser__hidden{display:inline-flex;align-items:center;gap:7px;font-size:12px;line-height:20px;color:var(--mw-muted);cursor:pointer;user-select:none}
    .mw-browser__hidden input{width:15px;height:15px;margin:0;accent-color:var(--mw-fill);cursor:pointer}
    .mw-browser__spacer{flex:1}
    .mw-newfolder{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 24px;border-block:1px solid var(--mw-line);background:var(--mw-inset)}
    .mw-newfolder .mw-path-input{min-width:100px}
    @keyframes mw-fade-in{from{opacity:0}to{opacity:1}}
    @keyframes mw-dialog-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes mw-spin{to{transform:rotate(360deg)}}
    @media (max-width:700px){.mw-workbench{grid-template-columns:160px minmax(0,1fr)}.mw-overview{padding:24px 18px}.mw-overview__title{font-size:18px}.mw-dialog__body{padding:24px 20px}.mw-folder{gap:8px;padding:12px 10px}.mw-folder__tile{width:30px;height:30px}.mw-folder__badge{font-size:9px}}
    @media (max-width:560px){.mw-overlay{padding:12px}.mw-dialog{border-radius:14px;max-height:calc(100dvh - 24px)}.mw-dialog__header{padding:16px 18px}.mw-dialog__title{font-size:18px}.mw-dialog__mark{width:38px;height:38px;border-radius:10px}.mw-workbench{display:flex;flex-direction:column}.mw-overview{padding:14px 18px;border-right:0;border-bottom:1px solid var(--mw-line)}.mw-overview__intro,.mw-overview__label,.mw-overview__primary{display:none}.mw-overview__summary{border:0;padding:0}.mw-overview__count{margin:0;gap:8px}.mw-overview__count strong{font-size:24px}.mw-dialog__body{padding:20px 18px;gap:24px;flex:none}.mw-dialog__footer{padding:14px 18px}.mw-dialog__footnote{font-size:10px;padding-right:4px}.mw-source__empty{min-height:190px}.mw-source__add-row{flex-wrap:wrap}.mw-browser__nav{padding:14px 18px 10px}.mw-browser__toolbar{padding:6px 18px 12px}.mw-browser__list{padding:0 10px 10px}.mw-browser__footer{padding:12px 18px}.mw-browser>.mw-alert{margin-inline:18px}.mw-newfolder{padding:10px 18px}.mw-folder{display:grid;grid-template-columns:12px 30px minmax(0,1fr) 26px;gap:5px 8px}.mw-folder__grip{grid-column:1;grid-row:1}.mw-folder__tile{grid-column:2;grid-row:1}.mw-folder__details{grid-column:3;grid-row:1;min-width:0}.mw-folder__badge{grid-column:3;grid-row:2;justify-self:start;margin:0}.mw-folder>.mw-icon-button,.mw-folder__lock{grid-column:4;grid-row:1;margin:0;width:26px}.mw-folder:not(.mw-folder--draggable){grid-template-columns:30px minmax(0,1fr) 26px}.mw-folder:not(.mw-folder--draggable) .mw-folder__tile{grid-column:1}.mw-folder:not(.mw-folder--draggable) .mw-folder__details,.mw-folder:not(.mw-folder--draggable) .mw-folder__badge{grid-column:2}.mw-folder:not(.mw-folder--draggable)>.mw-icon-button,.mw-folder:not(.mw-folder--draggable) .mw-folder__lock{grid-column:3}.mw-source__hint{font-size:10px}}
    @media (max-height:520px){.mw-overlay{padding:8px}.mw-dialog{max-height:calc(100dvh - 16px)}.mw-dialog__header{padding-block:12px}.mw-dialog__footer{padding-block:10px}.mw-browser__nav{padding-top:10px}}
    @media (prefers-reduced-motion:reduce){.mw-mask,.mw-dialog,.mw-spinner{animation:none!important}.mw-dialog *{transition:none!important}}
    @media (forced-colors:active){.mw-dialog,.mw-source,.mw-field,.mw-path-input,.mw-btn--outline,.mw-folder__badge{border-color:CanvasText}.mw-btn--primary{background:Highlight;color:HighlightText;border-color:Highlight}.mw-folder--dragover{outline:2px solid Highlight}.mw-browser__row--selected{border-color:Highlight}.mw-dialog :is(button,input):focus-visible{outline-color:Highlight}}
    `;
    //#endregion
    //#region src/client/30-browser.js
    /**
     * Stacked folder browser used by both workspace dialogs.
     *
     * The component is a pure consumer of the injected browse face:
     * `listDirectory(path, signal)`, `createDirectory(parentPath, name)`,
     * `onConfirm(paths)`, `onClose()` and the DSH translator `t`.
     *
     * Multi-select semantics: checkboxes accumulate absolute folder paths across
     * directory navigation; double-clicking (or the row chevron) descends into a
     * folder. Hidden entries are hidden unless the footer toggle is on. Every
     * failure renders an inline alert; nothing is thrown into the owner.
     */

    /** Case/normalised key used only to dedupe the local selection. */
    function mwBrowserKey(path) {
      if (typeof path !== 'string') return '';
      return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }

    /** Path separator for a Windows/POSIX path; the injected one wins. */
    function mwBrowserSeparator(path, injected) {
      if (injected === '\\' || injected === '/') return injected;
      return typeof path === 'string' && path.includes('\\') ? '\\' : '/';
    }

    /** Join a directory and a folder name without doubling the separator. */
    function mwBrowserJoin(directory, name, separator) {
      const sep = mwBrowserSeparator(directory, separator);
      const base = typeof directory === 'string' ? directory.replace(/[\\/]+$/, '') : '';
      const leaf = typeof name === 'string' ? name.replace(/^[\\/]+/, '') : '';
      if (!base) return leaf;
      return base + sep + leaf;
    }

    /** Parent directory path, or undefined when the path is a drive/root. */
    function mwBrowserParentPath(path, separator) {
      if (typeof path !== 'string') return undefined;
      const sep = mwBrowserSeparator(path, separator);
      const trimmed = path.replace(/[\\/]+$/, '');
      if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return undefined;
      const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
      if (at < 0) return undefined;
      const parent = trimmed.slice(0, at);
      if (!parent) return sep;
      if (parent === '\\' || parent === '/') return undefined;
      if (/^[A-Za-z]:$/.test(parent)) return parent + sep;
      return parent;
    }

    /** Breadcrumb segments for an absolute path (drive letter or POSIX root). */
    function mwBrowserSegments(path, separator) {
      if (typeof path !== 'string' || !path) return [];
      const sep = mwBrowserSeparator(path, separator);
      const trimmed = path.replace(/[\\/]+$/, '');
      if (!trimmed) return [{ label: path, path }];
      const drive = /^([A-Za-z]:)(?:[\\/]|$)/.exec(trimmed);
      if (drive) {
        const out = [{ label: drive[1], path: drive[1] + sep }];
        const rest = trimmed.slice(2).replace(/^[\\/]+/, '');
        let acc = drive[1] + sep;
        for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
          acc = acc.replace(/[\\/]+$/, '') + sep + part;
          out.push({ label: part, path: acc });
        }
        return out;
      }
      const absolute = /^[\\/]/.test(path);
      const parts = trimmed.split(/[\\/]+/).filter(Boolean);
      const out = [];
      let acc = absolute ? sep : '';
      for (const part of parts) {
        acc = acc === sep ? sep + part : acc ? acc.replace(/[\\/]+$/, '') + sep + part : part;
        out.push({ label: part, path: acc });
      }
      return out;
    }

    /** One checked row in the folder list. */
    function MwFolderRow(props) {
      const entry = props.entry || {};
      const path = typeof entry.path === 'string' ? entry.path : '';
      const name = typeof entry.name === 'string' && entry.name ? entry.name : path;
      const checked = props.checked === true;
      return h('div', {
        className: 'mw-browser__row' + (checked ? ' mw-browser__row--selected' : ''),
        'data-folder-path': path,
      },
        h('label', {
          className: 'mw-browser__select',
          onDoubleClick: (event) => {
            event.preventDefault();
            props.onEnter();
          },
        },
          h('input', {
            type: 'checkbox',
            className: 'mw-browser__checkbox',
            checked,
            onChange: props.onToggle,
            'aria-label': props.text('browser.selectFolder', { name }),
          }),
          h(Icon, { kind: 'folder', size: 18, className: 'mw-browser__icon' }),
          h('span', { className: 'mw-browser__name', title: path || name }, name)),
        h('button', {
          type: 'button',
          className: 'mw-icon-button mw-browser__enter',
          onClick: (event) => { event.stopPropagation(); props.onEnter(); },
          'aria-label': props.text('browser.openFolder', { name }),
          title: props.text('action.open'),
        }, h(Icon, { kind: 'chevron-right', size: 15 })));
    }

    /**
     * Folder browser dialog.
     *
     * @param props.open            - controlled visibility.
     * @param props.initialPath     - folder to list first (defaults to the home).
     * @param props.listDirectory   - `(path, signal) => Promise<{home,separator,entries,truncated}>`.
     * @param props.createDirectory - `(parentPath, name) => Promise<unknown>`.
     * @param props.onClose         - close only the browser layer.
     * @param props.onConfirm       - receives the selected absolute paths.
     * @param props.t               - DSH-bound translator.
     */
    function FolderBrowser(props) {
      const open = props.open === true;
      const initialPath = typeof props.initialPath === 'string' ? props.initialPath : '';
      const listDirectory = typeof props.listDirectory === 'function' ? props.listDirectory : null;
      const createDirectory = typeof props.createDirectory === 'function' ? props.createDirectory : null;
      const translate = React.useCallback((key, params) => mwUiText(props.t, key, params), [props.t]);

      const [current, setCurrent] = React.useState(initialPath);
      const [pathDraft, setPathDraft] = React.useState(initialPath);
      const [entries, setEntries] = React.useState([]);
      const [home, setHome] = React.useState('');
      const [separator, setSeparator] = React.useState(mwBrowserSeparator(initialPath, ''));
      const [truncated, setTruncated] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [loadedOnce, setLoadedOnce] = React.useState(false);
      const [error, setError] = React.useState('');
      const [selected, setSelected] = React.useState([]);
      const [showHidden, setShowHidden] = React.useState(false);
      const [creating, setCreating] = React.useState(false);
      const [newName, setNewName] = React.useState('');
      const [createBusy, setCreateBusy] = React.useState(false);
      const [createError, setCreateError] = React.useState('');
      const requestRef = React.useRef(null);
      const pathRef = React.useRef(null);
      const newNameRef = React.useRef(null);

      const load = React.useCallback((target) => {
        const previous = requestRef.current;
        requestRef.current = null;
        if (previous) {
          try { previous.abort(); } catch { /* already settled */ }
        }
        if (!listDirectory) {
          setLoading(false);
          setLoadedOnce(true);
          setError(translate('browser.error', { message: translate('error.noAction') }));
          return;
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        requestRef.current = controller;
        setLoading(true);
        setError('');
        let pending;
        try {
          pending = Promise.resolve(listDirectory(target || undefined, controller ? controller.signal : undefined));
        } catch (cause) {
          pending = Promise.reject(cause);
        }
        pending.then((result) => {
          if (controller && controller.signal.aborted) return;
          if (requestRef.current === controller) requestRef.current = null;
          const resolved = (result && typeof result.path === 'string' && result.path)
            || target
            || (result && typeof result.home === 'string' ? result.home : '')
            || '';
          const nextSeparator = mwBrowserSeparator(resolved || target || initialPath, result && result.separator);
          setEntries(result && Array.isArray(result.entries) ? result.entries : []);
          setHome(result && typeof result.home === 'string' ? result.home : '');
          setSeparator(nextSeparator);
          setTruncated(result && result.truncated === true);
          setCurrent(resolved);
          setPathDraft(resolved);
          setLoading(false);
          setLoadedOnce(true);
        }).catch((cause) => {
          if (controller && controller.signal.aborted) return;
          if (requestRef.current === controller) requestRef.current = null;
          setLoading(false);
          setLoadedOnce(true);
          setError(translate('browser.errorPath', { message: mwErrorMessage(cause) }));
        });
      }, [listDirectory, initialPath, translate]);

      React.useEffect(() => {
        if (!open) {
          const pending = requestRef.current;
          requestRef.current = null;
          if (pending) {
            try { pending.abort(); } catch { /* ignore */ }
          }
          return undefined;
        }
        setSelected([]);
        setShowHidden(false);
        setCreating(false);
        setNewName('');
        setCreateError('');
        setError('');
        setEntries([]);
        setLoadedOnce(false);
        setCurrent(initialPath);
        setPathDraft(initialPath);
        load(initialPath || undefined);
        return () => {
          const pending = requestRef.current;
          requestRef.current = null;
          if (pending) {
            try { pending.abort(); } catch { /* ignore */ }
          }
        };
      }, [open, initialPath, load]);

      const navigate = (target) => {
        const value = typeof target === 'string' ? target.trim() : '';
        load(value || undefined);
      };

      const enter = (entry) => {
        if (!entry || typeof entry.path !== 'string' || !entry.path) return;
        setCreating(false);
        setCreateError('');
        load(entry.path);
      };

      const toggle = (path) => {
        const key = mwBrowserKey(path);
        setSelected((previous) => {
          if (previous.some((item) => mwBrowserKey(item) === key)) {
            return previous.filter((item) => mwBrowserKey(item) !== key);
          }
          return [...previous, path];
        });
      };

      const beginCreate = () => {
        setCreating(true);
        setCreateError('');
        setNewName('');
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => { try { newNameRef.current?.focus?.(); } catch { /* ignore */ } });
        }
      };

      const cancelCreate = () => {
        setCreating(false);
        setNewName('');
        setCreateError('');
      };

      const submitCreate = () => {
        if (createBusy) return;
        const name = newName.trim();
        if (!name) {
          setCreateError(translate('browser.nameRequired'));
          return;
        }
        if (!createDirectory) {
          setCreateError(translate('browser.errorCreate', { message: translate('error.noAction') }));
          return;
        }
        setCreateBusy(true);
        setCreateError('');
        let pending;
        try {
          pending = Promise.resolve(createDirectory(current, name));
        } catch (cause) {
          pending = Promise.reject(cause);
        }
        pending.then((createdPath) => {
          const created = typeof createdPath === 'string' && createdPath
            ? createdPath
            : mwBrowserJoin(current, name, separator);
          setCreating(false);
          setNewName('');
          setCreateBusy(false);
          setSelected((previous) => previous.some((item) => mwBrowserKey(item) === mwBrowserKey(created))
            ? previous
            : [...previous, created]);
          load(current);
        }).catch((cause) => {
          setCreateBusy(false);
          setCreateError(translate('browser.errorCreate', { message: mwErrorMessage(cause) }));
        });
      };

      if (!open) return null;

      const parent = mwBrowserParentPath(current, separator);
      const crumbs = mwBrowserSegments(current || home, separator);
      const visible = (Array.isArray(entries) ? entries : []).filter((entry) => entry && (showHidden || entry.hidden !== true));
      const selectedKeys = new Set(selected.map((path) => mwBrowserKey(path)));
      const settling = loading || !loadedOnce;
      const statusText = settling
        ? translate('browser.loading')
        : (selected.length
          ? translate('browser.selectedCount', { n: selected.length })
          : translate('browser.noSelection'));

      return h(Modal, {
        title: translate('browser.title'),
        eyebrow: translate('dialog.eyebrow'),
        icon: 'folder-plus',
        className: 'mw-dialog--browser',
        layer: 1,
        onClose: props.onClose,
        closeLabel: translate('action.close'),
        initialFocusRef: pathRef,
      },
        h('div', { className: 'mw-browser' },
          h('div', { className: 'mw-browser__nav' },
            crumbs.length
              ? h('nav', { className: 'mw-crumbs', 'aria-label': translate('browser.crumbs') },
                crumbs.map((crumb, index) => h(React.Fragment, { key: crumb.path || String(index) },
                  index ? h('span', { className: 'mw-crumb__sep', 'aria-hidden': true }, h(Icon, { kind: 'chevron-right', size: 12 })) : null,
                  h('button', {
                    type: 'button',
                    className: 'mw-crumb' + (index === crumbs.length - 1 ? ' mw-crumb--current' : ''),
                    onClick: () => navigate(crumb.path),
                    title: crumb.path,
                    'aria-current': index === crumbs.length - 1 ? 'page' : undefined,
                  }, crumb.label)))) : null,
            h('div', { className: 'mw-pathbar' },
              h('button', {
                type: 'button',
                className: 'mw-icon-button',
                onClick: () => { if (parent) load(parent); },
                disabled: !parent,
                'aria-label': translate('browser.up'),
                title: translate('browser.up'),
              }, h(Icon, { kind: 'arrow-up', size: 16 })),
              h('input', {
                ref: pathRef,
                type: 'text',
                className: 'mw-path-input',
                value: pathDraft,
                onChange: (event) => setPathDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    navigate(pathDraft);
                  }
                },
                placeholder: translate('browser.path'),
                'aria-label': translate('browser.path'),
                spellCheck: false,
                autoComplete: 'off',
              }))),
          h('div', { className: 'mw-browser__toolbar' },
            h(Button, {
              size: 'sm',
              variant: 'outline',
              icon: h(Icon, { kind: 'folder-plus', size: 15 }),
              onClick: beginCreate,
              disabled: loading || !createDirectory,
            }, translate('browser.newFolder')),
            h('span', { className: 'mw-browser__status', role: 'status', 'aria-live': 'polite' }, statusText)),
          creating
            ? h('div', { className: 'mw-newfolder' },
              h('input', {
                ref: newNameRef,
                type: 'text',
                className: 'mw-path-input',
                value: newName,
                onChange: (event) => setNewName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') { event.preventDefault(); submitCreate(); }
                  if (event.key === 'Escape') { event.preventDefault(); cancelCreate(); }
                },
                placeholder: translate('browser.folderName'),
                'aria-label': translate('browser.folderName'),
                disabled: createBusy,
              }),
              h(Button, {
                size: 'sm',
                variant: 'primary',
                onClick: submitCreate,
                disabled: createBusy,
                icon: createBusy ? h('span', { className: 'mw-spinner' }) : null,
              }, translate('browser.createFolder')),
              h(Button, { size: 'sm', onClick: cancelCreate, disabled: createBusy }, translate('browser.cancelCreate')))
            : null,
          error
            ? h('ul', { className: 'mw-alert', role: 'alert' }, h('li', null, error))
            : null,
          createError
            ? h('ul', { className: 'mw-alert', role: 'alert' }, h('li', null, createError))
            : null,
          h('div', { className: 'mw-browser__list' },
            visible.length
              ? visible.map((entry, index) => {
                const path = typeof entry.path === 'string' ? entry.path : String(index);
                return h(MwFolderRow, {
                  key: mwBrowserKey(path) || String(index),
                  entry,
                  checked: selectedKeys.has(mwBrowserKey(path)),
                  onToggle: () => toggle(path),
                  onEnter: () => enter(entry),
                  text: translate,
                });
              })
              : h('div', { className: 'mw-browser__empty', role: 'status' },
                settling ? translate('browser.loading') : translate('browser.empty')),
            truncated
              ? h('p', { className: 'mw-browser__empty' }, translate('browser.truncated'))
              : null),
          h('div', { className: 'mw-browser__footer' },
            h('label', { className: 'mw-browser__hidden' },
              h('input', {
                type: 'checkbox',
                checked: showHidden,
                onChange: () => setShowHidden((value) => !value),
              }),
              translate('browser.showHidden')),
            h('span', { className: 'mw-browser__spacer' }),
            h(Button, { onClick: props.onClose }, translate('action.cancel')),
            h(Button, {
              variant: 'primary',
              disabled: selected.length === 0,
              onClick: () => props.onConfirm(selected.slice()),
            }, translate('action.addSelected')))));
    }
    //#endregion
    //#region src/client/40-dialogs.js
    /**
     * Create / edit workspace dialogs and the overlay host that owns them.
     *
     * The dialogs are presentational: they keep only local state (name, folder
     * list, busy, inline alerts) and delegate every side effect to the injected
     * `actions` object created by 90-apply.js:
     *
     *   actions.loadState()                                  -> Promise<state>
     *   actions.submitCreate({name, primaryPath, roots})     -> Promise<WorkspaceView>
     *   actions.submitModify({workspace, name, roots})       -> Promise<void>
     *   actions.cancelDialog() / closeDialogIfFlow(flow)
     *   actions.listDirectory(path, signal)
     *   actions.createDirectory(parentPath, name)
     *
     * OverlayHost subscribes to the shared store `{ dialog: null | DialogState }`
     * with useSyncExternalStore and portals the matching dialog to document.body.
     * Each dialog derives its own modal shell (20-ui-kit) so the folder browser can
     * stack above it with a higher layer.
     */

    /** Case-insensitive display key used to dedupe the local folder list. */
    function mwDlgKey(path) {
      if (typeof path !== 'string') return '';
      return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }

    /** Merge newly picked folders into the current list, preserving order. */
    function mwDlgMergeFolders(existing, incoming) {
      const out = Array.isArray(existing) ? existing.slice() : [];
      const seen = new Set(out.map((path) => mwDlgKey(path)));
      for (const value of Array.isArray(incoming) ? incoming : []) {
        if (typeof value !== 'string') continue;
        const path = value.trim();
        const key = mwDlgKey(path);
        if (!path || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(path);
      }
      return out;
    }

    /** Inline alert list; renders nothing when there is no message. */
    function MwDialogAlerts(props) {
      const messages = Array.isArray(props && props.messages) ? props.messages : [];
      if (messages.length === 0) return null;
      return h('ul', { className: 'mw-alert', role: 'alert' },
        messages.map((message, index) => h('li', { key: String(index) }, String(message))));
    }

    /** Bordered "source folders" box: selected rows, or the empty prompt. */
    function MwSourceFolders(props) {
      const folders = Array.isArray(props.folders) ? props.folders : [];
      const busy = props.busy === true;
      const text = props.text;
      const [dragIndex, setDragIndex] = React.useState(null);
      const [overIndex, setOverIndex] = React.useState(null);
      const canReorder = props.draggable === true && folders.length > 1 && !busy;
      const addRow = () => h('div', { className: 'mw-source__add-row' },
        h('span', { className: 'mw-source__status' }, text('source.addMore')),
        h(Button, {
          size: 'sm',
          variant: 'outline',
          icon: h(Icon, { kind: 'plus', size: 14 }),
          onClick: props.onAdd,
          disabled: busy,
        }, text('action.addFolder')));
      const moveFolder = (from, to) => {
        if (typeof from !== 'number' || typeof to !== 'number' || from === to) return;
        if (from < 0 || to < 0 || from >= folders.length || to >= folders.length) return;
        if (typeof props.onReorder === 'function') props.onReorder(from, to);
      };
      return h('div', { className: 'mw-source' },
        folders.length === 0
          ? h('div', { className: 'mw-source__empty' },
            h('span', { className: 'mw-source__empty-icon' }, h(Icon, { kind: 'folder-plus', size: 30 })),
            h('p', { className: 'mw-source__empty-title' }, text('source.emptyTitle')),
            h('p', { className: 'mw-source__status' }, text('source.addPrompt')),
            h(Button, {
              variant: 'primary',
              size: 'sm',
              icon: h(Icon, { kind: 'plus', size: 14 }),
              onClick: props.onAdd,
              disabled: busy,
            }, text('action.addFolder')))
          : h(React.Fragment, null,
            h('ul', { className: 'mw-source__list', role: 'list' },
              folders.map((path, index) => {
                const removePrimary = index === 0 && props.lockPrimary === true;
                const dragging = dragIndex === index;
                const over = overIndex === index && dragIndex !== null && dragIndex !== index;
                return h('li', {
                  className: 'mw-folder'
                    + (canReorder ? ' mw-folder--draggable' : '')
                    + (dragging ? ' mw-folder--dragging' : '')
                    + (over ? ' mw-folder--dragover' : ''),
                  key: mwDlgKey(path) || String(index),
                  title: canReorder ? text('action.dragFolder') : undefined,
                  draggable: canReorder,
                  onDragStart: canReorder ? (event) => {
                    setDragIndex(index);
                    setOverIndex(index);
                    try {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', String(index));
                    } catch { /* dataTransfer is best effort */ }
                  } : undefined,
                  onDragOver: canReorder ? (event) => {
                    event.preventDefault();
                    try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
                    if (overIndex !== index) setOverIndex(index);
                  } : undefined,
                  onDragLeave: canReorder ? () => {
                    if (overIndex === index) setOverIndex(null);
                  } : undefined,
                  onDrop: canReorder ? (event) => {
                    event.preventDefault();
                    const from = dragIndex;
                    setDragIndex(null);
                    setOverIndex(null);
                    if (typeof from === 'number') moveFolder(from, index);
                  } : undefined,
                  onDragEnd: canReorder ? () => {
                    setDragIndex(null);
                    setOverIndex(null);
                  } : undefined,
                },
                  canReorder ? h(Icon, { kind: 'grip', size: 14, className: 'mw-folder__grip' }) : null,
                  h('span', { className: 'mw-folder__tile' + (index === 0 ? ' mw-folder__tile--primary' : '') },
                    h(Icon, { kind: 'folder', size: 20, className: 'mw-folder__icon' })),
                  h('span', { className: 'mw-folder__details' },
                    h('span', { className: 'mw-folder__name', title: mwBasename(path) || path }, mwBasename(path) || path),
                    h('span', { className: 'mw-folder__path', title: path }, path)),
                  index === 0
                    ? h('span', {
                      className: 'mw-folder__badge',
                      title: text(props.lockPrimary === true ? 'source.removePrimaryHint' : 'source.primaryHint'),
                    }, text('badge.primary'))
                    : null,
                  removePrimary ? h(Icon, { kind: 'lock', size: 15, className: 'mw-folder__lock' }) : h('button', {
                    type: 'button',
                    className: 'mw-icon-button mw-icon-button--danger',
                    onClick: () => props.onRemove(index),
                    disabled: busy,
                    'aria-label': text('action.removeFolder.aria', { path }),
                    title: text('action.remove'),
                  }, h(Icon, { kind: 'close', size: 14 })));
              })),
            addRow()),
      );
    }

    /** Modal shell plus the two fields shared by create and edit. */
    function MwWorkspaceForm(props) {
      const text = props.text;
      const busy = props.busy === true;
      const folders = Array.isArray(props.folders) ? props.folders : [];
      const nameId = 'mw-name-' + React.useId();
      return h(Modal, {
        title: props.title,
        onClose: props.onCancel,
        closeLabel: text('action.close'),
        initialFocusRef: props.nameRef,
        className: 'mw-dialog--workspace',
        eyebrow: text('dialog.eyebrow'),
      },
        h('div', { className: 'mw-workbench' },
          h('aside', { className: 'mw-overview' },
            h('div', { className: 'mw-overview__intro' },
              h('span', { className: 'mw-overview__glyph' }, h(Icon, { kind: 'workspace', size: 34 })),
              h('h3', { className: 'mw-overview__title' }, text('overview.title')),
              h('p', { className: 'mw-overview__description' }, text('overview.description'))),
            h('div', { className: 'mw-overview__summary' },
              h('p', { className: 'mw-overview__label' }, text('overview.summary')),
              h('p', { className: 'mw-overview__count', role: 'status', 'aria-live': 'polite' },
                h('strong', null, String(folders.length).padStart(2, '0')),
                h('span', null, text('overview.folders'))),
              h('div', { className: 'mw-overview__primary' },
                h('span', null, text('badge.primary')),
                h('strong', { title: folders[0] || '' }, folders.length ? (mwBasename(folders[0]) || folders[0]) : text('source.noSelection'))))),
        h('div', { className: 'mw-dialog__body' },
          h(MwDialogAlerts, { messages: props.errors }),
          h('section', { className: 'mw-section' },
            h('h3', { className: 'mw-section__label' },
              h('span', { className: 'mw-section__number', 'aria-hidden': true }, '01'), text('section.workspace')),
            h('label', { className: 'mw-field__label', htmlFor: nameId }, text('field.name.label')),
            h('div', { className: 'mw-field' },
            h(Icon, { kind: 'folder', size: 18, className: 'mw-field__icon' }),
            h('input', {
              ref: props.nameRef,
              id: nameId,
              type: 'text',
              className: 'mw-input',
              value: props.name,
              placeholder: text('field.name.placeholder'),
              'aria-label': text('field.name.label'),
              maxLength: 200,
              autoComplete: 'off',
              spellCheck: false,
              disabled: busy,
              onChange: (event) => props.onNameChange(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !busy && !props.submitDisabled) {
                  event.preventDefault();
                  props.onSubmit();
                }
              },
            })),
            h('p', { className: 'mw-field__hint' }, text(props.lockPrimary ? 'field.name.modifyHint' : 'field.name.hint'))),
          h('section', { className: 'mw-section' },
            h('div', { className: 'mw-section__heading' },
              h('h3', { className: 'mw-section__label' },
                h('span', { className: 'mw-section__number', 'aria-hidden': true }, '02'), text('section.sourceFolder')),
              h('span', { className: 'mw-section__count' }, text('source.count', { n: folders.length }))),
            h(MwSourceFolders, {
              folders,
              onAdd: props.onAdd,
              onRemove: props.onRemove,
              onReorder: props.onReorder,
              lockPrimary: props.lockPrimary === true,
              draggable: props.draggable === true,
              busy,
              text,
            }),
            h('p', { className: 'mw-source__hint' },
              h(Icon, { kind: props.lockPrimary ? 'lock' : 'grip', size: 14 }),
              text(props.lockPrimary ? 'source.lockedHint' : 'source.reorderHint'))))),
        h('div', { className: 'mw-dialog__footer' },
          h('span', { className: 'mw-dialog__footnote' }, text('dialog.footnote')),
          h(Button, { onClick: props.onCancel, disabled: busy }, text('action.cancel')),
          h(Button, {
            variant: 'primary',
            onClick: props.onSubmit,
            disabled: busy || props.submitDisabled,
            icon: busy ? h('span', { className: 'mw-spinner' }) : null,
          }, busy ? props.busyLabel : props.submitLabel)));
    }

    /** Read one workspace record from the Host state document. */
    function mwDlgRecord(state, workspaceId) {
      if (!state || typeof state !== 'object' || !state.workspaces || typeof workspaceId !== 'string') return undefined;
      const record = state.workspaces[workspaceId];
      return record && typeof record === 'object' ? record : undefined;
    }

    /** Invoke the owner close path, tolerating either 90-apply naming. */
    function mwDlgClose(actions, busy) {
      if (busy) return;
      const api = actions || {};
      if (typeof api.cancelDialog === 'function') { api.cancelDialog(); return; }
      if (typeof api.closeDialog === 'function') api.closeDialog();
    }

    /**
     * Ask for one folder through the composed directory picker. DSH Desktop composes
     * the native OS chooser, which serves `pick` but not `list`; a browse-based Web
     * composition serves `list` but not `pick`. Resolve which interaction is
     * available: `picked` adds the chosen folder, `browse` opens the in-app browser,
     * and `cancelled` leaves the dialog unchanged.
     */
    function mwRequestFolderPick(actions) {
      if (!actions || typeof actions.pickDirectory !== 'function') return Promise.resolve({ kind: 'browse' });
      let pending;
      try { pending = Promise.resolve(actions.pickDirectory()); }
      catch { return Promise.resolve({ kind: 'browse' }); }
      return pending.then((path) => {
        if (typeof path === 'string' && path.trim()) return { kind: 'picked', paths: [path.trim()] };
        return { kind: 'cancelled' };
      }).catch(() => ({ kind: 'browse' }));
    }

    /** Dialog state owned by 90-apply: {mode, workspace, flow}. */
    function CreateWorkspaceDialog(props) {
      const actions = props.actions || {};
      const translate = React.useCallback((key, params) => mwUiText(props.t, key, params), [props.t]);
      const [name, setName] = React.useState('');
      const [folders, setFolders] = React.useState([]);
      const [browserOpen, setBrowserOpen] = React.useState(false);
      const [picking, setPicking] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [errors, setErrors] = React.useState([]);
      const nameRef = React.useRef(null);

      const addFolders = (paths) => {
        setFolders((previous) => mwDlgMergeFolders(previous, paths));
        setErrors([]);
      };

      const addViaPicker = () => {
        if (picking || busy) return;
        setPicking(true);
        mwRequestFolderPick(actions).then((result) => {
          setPicking(false);
          if (result.kind === 'picked') addFolders(result.paths);
          else if (result.kind === 'browse') setBrowserOpen(true);
        });
      };

      const removeFolder = (index) => {
        if (typeof index !== 'number' || index < 0) return;
        setFolders((previous) => previous.filter((_, at) => at !== index));
      };

      const reorderFolders = (from, to) => {
        setFolders((previous) => {
          if (from === to || from < 0 || to < 0 || from >= previous.length || to >= previous.length) return previous;
          const next = previous.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return next;
        });
      };

      const submit = () => {
        if (busy) return;
        if (folders.length === 0) {
          setErrors([translate('error.noFolder')]);
          return;
        }
        if (typeof actions.submitCreate !== 'function') {
          setErrors([translate('error.noAction')]);
          return;
        }
        const primaryPath = folders[0];
        const finalName = name.trim() || mwBasename(primaryPath);
        setBusy(true);
        setErrors([]);
        let pending;
        try {
          pending = Promise.resolve(actions.submitCreate({ name: finalName, primaryPath, roots: folders.slice(1) }));
        } catch (cause) {
          pending = Promise.reject(cause);
        }
        pending.then(() => {
          // 90-apply closes the dialog after adopting the created workspace.
          setBusy(false);
        }).catch((cause) => {
          const message = mwErrorMessage(cause) || translate('error.submit');
          setBusy(false);
          setErrors([message]);
          const flow = props.dialog && props.dialog.flow;
          if (flow && typeof flow.onError === 'function') {
            try { flow.onError(message); } catch { /* the owner's error surface must not break us */ }
          }
        });
      };

      return h(React.Fragment, null,
        h(MwWorkspaceForm, {
          title: translate('dialog.create.title'),
          name,
          nameRef,
          onNameChange: setName,
          folders,
          onAdd: addViaPicker,
          onRemove: removeFolder,
          onReorder: reorderFolders,
          lockPrimary: false,
          draggable: true,
          busy,
          busyLabel: translate('action.creating'),
          submitLabel: translate('action.create'),
          submitDisabled: folders.length === 0,
          errors,
          onSubmit: submit,
          onCancel: () => mwDlgClose(actions, busy),
          text: translate,
        }),
        h(FolderBrowser, {
          open: browserOpen,
          initialPath: folders.length ? folders[folders.length - 1] : '',
          listDirectory: actions.listDirectory,
          createDirectory: actions.createDirectory,
          onClose: () => setBrowserOpen(false),
          onConfirm: (paths) => {
            addFolders(paths);
            setBrowserOpen(false);
          },
          t: props.t,
        }));
    }

    /** Edit dialog: prefills from the Host record, primary folder is fixed. */
    function ModifyWorkspaceDialog(props) {
      const actions = props.actions || {};
      const translate = React.useCallback((key, params) => mwUiText(props.t, key, params), [props.t]);
      const workspace = props.dialog && props.dialog.workspace ? props.dialog.workspace : null;
      const workspaceId = workspace && typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '';
      const workspacePrimary = workspace && typeof workspace.path === 'string' ? workspace.path : '';
      const [name, setName] = React.useState(workspace && typeof workspace.title === 'string' ? workspace.title : '');
      const [folders, setFolders] = React.useState(workspacePrimary ? [workspacePrimary] : []);
      const [browserOpen, setBrowserOpen] = React.useState(false);
      const [picking, setPicking] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [errors, setErrors] = React.useState([]);
      const nameRef = React.useRef(null);
      const nameTouched = React.useRef(false);
      const foldersTouched = React.useRef(false);

      React.useEffect(() => {
        let live = true;
        if (!workspaceId) {
          setErrors([translate('error.noWorkspace')]);
          return () => { live = false; };
        }
        if (typeof actions.loadState !== 'function') return () => { live = false; };
        let pending;
        try {
          pending = Promise.resolve(actions.loadState());
        } catch (cause) {
          pending = Promise.reject(cause);
        }
        pending.then((state) => {
          if (!live) return;
          const record = mwDlgRecord(state, workspaceId);
          const primary = (record && typeof record.path === 'string' && record.path) || workspacePrimary;
          const roots = record && Array.isArray(record.roots) ? record.roots : [];
          if (primary) {
            const discovered = mwDlgMergeFolders([], [primary].concat(roots));
            setFolders((previous) => {
              if (!foldersTouched.current) return discovered;
              const base = previous.length ? previous[0] : primary;
              return mwDlgMergeFolders([base], previous.slice(1).concat(discovered.slice(1)));
            });
          }
          if (record && typeof record.name === 'string' && record.name && !nameTouched.current) {
            setName(record.name);
          }
        }).catch((cause) => {
          if (!live) return;
          setErrors([translate('error.load', { message: mwErrorMessage(cause) })]);
        });
        return () => { live = false; };
        // Read the Host record once per opened workspace; the refs guard user edits.
      }, [workspaceId]);

      const addFolders = (paths) => {
        foldersTouched.current = true;
        setFolders((previous) => mwDlgMergeFolders(previous, paths));
        setErrors([]);
      };

      const removeFolder = (index) => {
        if (index <= 0) return;
        foldersTouched.current = true;
        setFolders((previous) => previous.filter((_, at) => at !== index));
      };

      const addViaPicker = () => {
        if (picking || busy) return;
        setPicking(true);
        mwRequestFolderPick(actions).then((result) => {
          setPicking(false);
          if (result.kind === 'picked') addFolders(result.paths);
          else if (result.kind === 'browse') setBrowserOpen(true);
        });
      };

      const changeName = (value) => {
        nameTouched.current = true;
        setName(value);
      };

      const submit = () => {
        if (busy) return;
        if (!workspace) {
          setErrors([translate('error.noWorkspace')]);
          return;
        }
        if (folders.length === 0) {
          setErrors([translate('error.noFolder')]);
          return;
        }
        if (typeof actions.submitModify !== 'function') {
          setErrors([translate('error.noAction')]);
          return;
        }
        setBusy(true);
        setErrors([]);
        let pending;
        try {
          pending = Promise.resolve(actions.submitModify({
            workspace,
            name: name.trim(),
            roots: folders.slice(1),
          }));
        } catch (cause) {
          pending = Promise.reject(cause);
        }
        pending.then(() => {
          // 90-apply closes the dialog and persists the record.
          setBusy(false);
        }).catch((cause) => {
          setBusy(false);
          setErrors([mwErrorMessage(cause) || translate('error.save')]);
        });
      };

      return h(React.Fragment, null,
        h(MwWorkspaceForm, {
          title: translate('dialog.modify.title'),
          name,
          nameRef,
          onNameChange: changeName,
          folders,
          onAdd: addViaPicker,
          onRemove: removeFolder,
          lockPrimary: true,
          busy,
          busyLabel: translate('action.saving'),
          submitLabel: translate('action.save'),
          submitDisabled: folders.length === 0,
          errors,
          onSubmit: submit,
          onCancel: () => mwDlgClose(actions, busy),
          text: translate,
        }),
        h(FolderBrowser, {
          open: browserOpen,
          initialPath: folders.length ? folders[folders.length - 1] : workspacePrimary,
          listDirectory: actions.listDirectory,
          createDirectory: actions.createDirectory,
          onClose: () => setBrowserOpen(false),
          onConfirm: (paths) => {
            addFolders(paths);
            setBrowserOpen(false);
          },
          t: props.t,
        }));
    }

    /** Fallback store snapshot so OverlayHost stays renderable without a store. */
    const MW_EMPTY_OVERLAY_STATE = Object.freeze({ dialog: null });

    /**
     * Persistent overlay host registered into `shell.overlay`.
     * Accepts the direct slot props and (defensively) an `inject` alias object.
     */
    function OverlayHost(props) {
      const face = props && props.inject ? props.inject : (props || {});
      const store = face.store;
      const actions = face.actions || {};
      const subscribe = store && typeof store.subscribe === 'function' ? store.subscribe : () => () => {};
      const getSnapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot : () => MW_EMPTY_OVERLAY_STATE;
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const dialog = state && state.dialog ? state.dialog : null;
      const flow = dialog && dialog.flow ? dialog.flow : null;

      React.useEffect(() => {
        if (!flow || flow.open !== false) return;
        const api = actions || {};
        if (typeof api.closeDialogIfFlow === 'function') { api.closeDialogIfFlow(flow); return; }
        if (typeof api.closeDialog === 'function') { api.closeDialog(); return; }
        if (typeof api.cancelDialog === 'function') api.cancelDialog();
      }, [flow, actions]);

      if (!dialog) return null;
      const shared = { dialog, actions, t: face.t, logger: face.logger };
      if (dialog.mode === 'modify') return h(ModifyWorkspaceDialog, shared);
      return h(CreateWorkspaceDialog, shared);
    }
    //#endregion
    //#region src/client/50-menu.js
    /*
     * 50-menu.js — 工作区行“...”菜单 DOM 增强：在原生菜单里插入“修改工作区”。
     *
     * 这是共享闭包里的普通脚本片段：不 import / 不 export / 无顶层副作用，只定义一个函数。
     * 由 90-apply.js 调用：
     *
     *   const dispose = installWorkspaceMenuAction({
     *     t,                    // (key) => string；t('menu.modifyWorkspace') 返回“修改工作区”
     *     logger,               // 可选：{ warn(message) }；只用于异常告警，绝不影响原生菜单
     *     resolveWorkspace,     // (label) => workspace | undefined；按标题快照精确匹配
     *     onOpen,               // (workspace) => void；打开“修改工作区”对话框
     *   });
     *   // dispose() 幂等：断开 observer、移除 document 监听、移除克隆菜单项。
     *
     * 兼容别名：options.resolveWorkspaceByLabel 与 options.resolveWorkspace 等价。
     *
     * 已核对的 DSH 0.2.1-rc.2 DOM 结构（源码：@deepseek-ai/dsh-client-ui-workspace 的
     * ProjectRowItem，以及 @deepseek-ai/dsh-web-frontend 内 Menu 实现）：
     *
     *   工作区行： <div data-row-key="workspace:<key>" role="treeitem">
     *                <span class="…slot…">文件夹图标</span>
     *                <span class="…slot…">箭头</span>
     *                <span class="…projectText"><span class="…title">工作区显示名</span></span>
     *                <span class="…rowActions">
     *                  <span>  <button type="button" aria-label='工作区“{name}”的操作' />  ← “...”按钮
     *                </span>
     *
     *   菜单 portal 到 document.body：
     *     <div role="menu" data-menu-material="translucent" class="…list…">
     *       <div aria-hidden="true" class="…material…"></div>
     *       <div role="presentation" class="…viewport…">
     *         <div class="…itemWrap…">
     *           <button type="button" role="menuitem">
     *             <span class="…itemIcon"><svg/></span>
     *             <span class="…itemLabel">重命名</span>
     *             （可选）<span aria-hidden="true" class="…shortcut…">…</span>
     *           </button>
     *         </div>
     *         <div class="…itemWrap…"> …删除工作区… </div>
     *       </div>
     *     </div>
     *
     *   关键点：菜单项按钮外面还有一层 itemWrap（viewport 的直接子节点），所以克隆的是
     *   “包含第一个 menuitem 按钮的 itemWrap”，插到第一个 itemWrap 之后；不能只克隆 button
     *   （否则会把两个按钮塞进同一个 itemWrap，样式/语义都错）。
     *
     * 原生 aria-label 模板（ui-workspace locale）：
     *   zh: 工作区“{name}”的操作
     *   en: Workspace actions for {name}
     *
     * 原生菜单关闭：Menu 在 document 捕获阶段监听 keydown，Escape（!shiftKey）时调用 onClose。
     * 所以克隆项点击后向菜单元素派发一个合成 keydown(Escape) 即可关闭，再同步 onOpen(workspace)。
     */
    function installWorkspaceMenuAction(options) {
      'use strict';

      const opts = options && typeof options === 'object' ? options : {};
      const logger = opts.logger;
      const t = typeof opts.t === 'function' ? opts.t : null;
      const resolveWorkspace = typeof opts.resolveWorkspace === 'function'
        ? opts.resolveWorkspace
        : (typeof opts.resolveWorkspaceByLabel === 'function' ? opts.resolveWorkspaceByLabel : null);
      const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;

      const ROW_KEY_ATTR = 'data-row-key';
      const ROW_KEY_PREFIX = 'workspace:';
      const MENU_SELECTOR = '[role="menu"]';
      const ITEM_SELECTOR = 'button[role="menuitem"]';
      const ACTION_ATTR = 'data-mw-menu-action';
      const ENHANCED_ATTR = 'data-mw-menu-enhanced';
      const ACTION_VALUE = 'modify-workspace';
      const CLICK_WINDOW_MS = 6000;
      const FALLBACK_LABEL = '修改工作区';

      let disposed = false;
      let observer = null;
      let lastRowClick = null;
      const enhancedMenus = new WeakSet();
      const clones = new Map(); // clone element -> click handler
      const retries = new Set(); // { cancel(): void }
      const retriedMenus = new WeakSet();

      /** 只允许 warn 级别的非侵入日志；logger 自身报错也必须吞掉。 */
      function warn(message, error) {
        try {
          if (!logger || typeof logger.warn !== 'function') return;
          if (error === undefined) logger.warn('[multi-workspace] ' + message);
          else logger.warn('[multi-workspace] ' + message + ': ' + stringifyError(error));
        } catch (ignored) { /* 日志失败绝不能影响原生菜单 */ }
      }

      function stringifyError(error) {
        try {
          if (error && typeof error.message === 'string') return error.message;
          return String(error);
        } catch (ignored) {
          return 'unknown error';
        }
      }

      function isElement(node) {
        return !!node && node.nodeType === 1 && typeof node.getAttribute === 'function';
      }

      function matches(element, selector) {
        try {
          return !!element && typeof element.matches === 'function' && element.matches(selector);
        } catch (ignored) {
          return false;
        }
      }

      function attr(element, name) {
        try {
          return element && typeof element.getAttribute === 'function' ? element.getAttribute(name) : null;
        } catch (ignored) {
          return null;
        }
      }

      function textOf(node) {
        try {
          return node && typeof node.textContent === 'string' ? node.textContent : '';
        } catch (ignored) {
          return '';
        }
      }

      function cleanText(value) {
        return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      }

      function now() {
        try {
          return Date.now();
        } catch (ignored) {
          return 0;
        }
      }

      function queryAll(root, selector) {
        try {
          if (!root || typeof root.querySelectorAll !== 'function') return [];
          return root.querySelectorAll(selector);
        } catch (ignored) {
          return [];
        }
      }

      /* ------------------------------------------------------------------ */
      /* 1. 记录“最近一次点击是否落在工作区行内”，并抓取行/按钮                    */
      /* ------------------------------------------------------------------ */

      function recordRowClick(event) {
        if (disposed) return;
        try {
          const target = event ? event.target : null;
          let element = isElement(target) ? target
            : (target && isElement(target.parentElement) ? target.parentElement : null);
          if (!element || typeof element.closest !== 'function') {
            lastRowClick = null;
            return;
          }

          const row = element.closest('[' + ROW_KEY_ATTR + ']');
          if (!row) {
            lastRowClick = null;
            return;
          }
          const rowKey = attr(row, ROW_KEY_ATTR) || '';
          if (rowKey.slice(0, ROW_KEY_PREFIX.length) !== ROW_KEY_PREFIX) {
            lastRowClick = null;
            return;
          }

          // “...”按钮的 aria-label 含工作区显示名；点击行内空白/标题时找不到按钮 → 不记录。
          const labelButton = element.closest('button[aria-label]');
          const ariaLabel = cleanText(attr(labelButton, 'aria-label'));
          if (!ariaLabel) {
            lastRowClick = null;
            return;
          }

          lastRowClick = {
            at: now(),
            row: row,
            rowKey: rowKey,
            ariaLabel: ariaLabel,
          };
        } catch (error) {
          lastRowClick = null;
          warn('failed to record workspace row click', error);
        }
      }

      /* ------------------------------------------------------------------ */
      /* 2. 观察 menu 出现（body, childList + subtree）                         */
      /* ------------------------------------------------------------------ */

      function menuOf(node) {
        try {
          let element = isElement(node) ? node
            : (node && isElement(node.parentElement) ? node.parentElement : null);
          if (!element || typeof element.closest !== 'function') return null;
          return element.closest(MENU_SELECTOR);
        } catch (ignored) {
          return null;
        }
      }

      function scanAddedNode(node) {
        if (!isElement(node)) return;
        if (matches(node, MENU_SELECTOR)) processMenu(node);
        const nested = queryAll(node, MENU_SELECTOR);
        for (let i = 0; i < nested.length; i += 1) processMenu(nested[i]);
      }

      function onMutations(records) {
        if (disposed) return;
        try {
          for (let i = 0; i < records.length; i += 1) {
            const record = records[i];
            // 已存在菜单内部发生子节点变化（例如我们的克隆插入、label 文本替换）。
            const ownerMenu = menuOf(record.target);
            if (ownerMenu) processMenu(ownerMenu);
            const added = record.addedNodes;
            if (!added) continue;
            for (let j = 0; j < added.length; j += 1) scanAddedNode(added[j]);
          }
        } catch (error) {
          warn('menu mutation scan failed', error);
        }
      }

      /* ------------------------------------------------------------------ */
      /* 3. 工作区菜单识别 + 增强                                              */
      /* ------------------------------------------------------------------ */

      function processMenu(menu) {
        if (disposed || !isElement(menu)) return;
        if (attr(menu, ENHANCED_ATTR) === '1' || enhancedMenus.has(menu)) return;
        if (menu.isConnected === false) return;

        const items = queryAll(menu, ITEM_SELECTOR);
        const count = items.length;
        if (count === 0) {
          // 极端情况下 React 可能分两次提交；只重试一帧，避免死循环。
          scheduleRetry(menu);
          return;
        }
        if (count !== 2) return; // 结构不符合预期（不是 2 项工作区菜单）→ 静默跳过

        const click = lastRowClick;
        if (!click || (now() - click.at) > CLICK_WINDOW_MS) return;

        let workspace;
        try {
          workspace = resolveFromClick(click);
        } catch (error) {
          warn('resolveWorkspace failed', error);
          return;
        }
        if (workspace === undefined || workspace === null) return;

        enhanceMenu(menu, items[0], workspace);
      }

      function scheduleRetry(menu) {
        if (retriedMenus.has(menu)) return;
        retriedMenus.add(menu);
        let timer = null;
        const entry = {
          cancel: function cancelRetry() {
            if (timer === null) return;
            try {
              if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(timer);
              else clearTimeout(timer);
            } catch (ignored) { /* noop */ }
            timer = null;
          },
        };
        const run = function runRetry() {
          timer = null;
          retries.delete(entry);
          if (!disposed) processMenu(menu);
        };
        try {
          if (typeof requestAnimationFrame === 'function') timer = requestAnimationFrame(run);
          else timer = setTimeout(run, 16);
        } catch (ignored) {
          retriedMenus.delete(menu);
          return;
        }
        retries.add(entry);
      }

      /** 从最近点击快照里恢复 workspace；候选标签按可靠性排序，取第一个能解析的。 */
      function resolveFromClick(click) {
        const candidates = collectLabelCandidates(click.ariaLabel, click.row);
        for (let i = 0; i < candidates.length; i += 1) {
          const workspace = resolveWorkspace(candidates[i]);
          if (workspace !== undefined && workspace !== null) return workspace;
        }
        return undefined;
      }

      function collectLabelCandidates(ariaLabel, row) {
        const out = [];
        const seen = Object.create(null);

        function addExact(value) {
          const text = cleanText(value);
          if (!text || seen[text]) return;
          seen[text] = true;
          out.push(text);
        }

        function push(value) {
          const text = cleanText(value);
          if (!text) return;
          addExact(text);
          const stripped = stripWrappers(text);
          if (stripped && stripped !== text) addExact(stripped);
        }

        // 3.1 行内标题文本最可靠：ProjectRowItem 的 title span 就是 workspace title。
        const rowTexts = collectLeafTexts(row, 8);
        for (let i = 0; i < rowTexts.length; i += 1) push(rowTexts[i]);

        // 3.2 aria-label 中引号包裹的标题（zh 模板：工作区“{name}”的操作）。
        const quoted = /[“"「『]([^”"」』]+)[”"」』]/.exec(ariaLabel);
        if (quoted) push(quoted[1]);

        // 3.3 已知模板（en：Workspace actions for {name}；zh 无引号兜底）。
        const en = /^workspace actions for (.+)$/i.exec(ariaLabel);
        if (en) push(en[1]);
        const zh = /^工作区(.*)的操作$/.exec(ariaLabel);
        if (zh) push(zh[1]);

        // 3.4 冒号/破折号等分隔符两侧（其它语言/未来模板的容错）。
        const separators = ['：', ':', '|', '—', '–', '-', '»', '›', '>', '，', ','];
        for (let i = 0; i < separators.length; i += 1) {
          const sep = separators[i];
          const first = ariaLabel.indexOf(sep);
          if (first >= 0) {
            push(ariaLabel.slice(0, first));
            push(ariaLabel.slice(first + sep.length));
          }
          const last = ariaLabel.lastIndexOf(sep);
          if (last >= 0 && last !== first) {
            push(ariaLabel.slice(0, last));
            push(ariaLabel.slice(last + sep.length));
          }
        }

        // 3.5 原样兜底。
        push(ariaLabel);
        return out;
      }

      /** 行内叶子元素文本（行标题 span 是叶子），用于精确匹配工作区标题。 */
      function collectLeafTexts(root, limit) {
        const out = [];
        if (!isElement(root)) return out;
        const nodes = queryAll(root, '*');
        for (let i = 0; i < nodes.length && out.length < limit; i += 1) {
          const element = nodes[i];
          if (element.children && element.children.length > 0) continue;
          const text = cleanText(textOf(element));
          if (!text || text.length > 200) continue;
          out.push(text);
        }
        return out;
      }

      function stripWrappers(value) {
        let text = value;
        for (let i = 0; i < 3; i += 1) {
          const before = text;
          text = text.replace(/^[\s“”"'‘’「」『』【】\[\]()（）<>《》]+/, '');
          text = text.replace(/[\s“”"'‘’「」『』【】\[\]()（）<>《》]+$/, '');
          if (text === before) break;
        }
        return text.trim();
      }

      /** 从菜单项按钮向上找“只包含这一个菜单项”的容器：一般是 div.itemWrap。 */
      function itemHost(menu, button) {
        let host = button;
        let guard = 0;
        while (host && host.parentElement && host.parentElement !== menu && guard < 8) {
          const parent = host.parentElement;
          const count = queryAll(parent, ITEM_SELECTOR).length;
          if (count > 1) break; // parent 已经包含多个菜单项 → host 就是本项的容器
          host = parent;
          guard += 1;
        }
        return host;
      }

      function enhanceMenu(menu, sourceButton, workspace) {
        try {
          const host = itemHost(menu, sourceButton);
          if (!host || !host.parentNode) return;

          const clone = host.cloneNode(true);
          if (!isElement(clone)) return;

          const clonedButton = matches(clone, ITEM_SELECTOR)
            ? clone
            : queryAll(clone, ITEM_SELECTOR)[0];
          if (!clonedButton) return;

          const label = resolveActionLabel();
          if (!applyActionLabel(clone, clonedButton, label)) return;

          stripIdsAndSemantics(clone);
          if (clonedButton.hasAttribute && clonedButton.hasAttribute('aria-label')) {
            clonedButton.setAttribute('aria-label', label);
          }
          clone.setAttribute(ACTION_ATTR, ACTION_VALUE);

          // 先标记再插入，避免观察者把自身的插入误判成新的候选菜单。
          enhancedMenus.add(menu);
          menu.setAttribute(ENHANCED_ATTR, '1');

          const handler = function onActionClick(event) {
            handleActionClick(event, menu, workspace, clone);
          };

          try {
            clone.addEventListener('click', handler);
            clones.set(clone, handler);
            host.parentNode.insertBefore(clone, host.nextSibling);
          } catch (error) {
            warn('failed to insert menu item', error);
            cleanupClone(clone);
            enhancedMenus.delete(menu);
            try { menu.removeAttribute(ENHANCED_ATTR); } catch (ignored) { /* noop */ }
          }
        } catch (error) {
          warn('menu enhancement failed', error);
        }
      }

      function resolveActionLabel() {
        let label = '';
        try {
          if (t) label = t('menu.modifyWorkspace');
        } catch (error) {
          warn('t(menu.modifyWorkspace) failed', error);
        }
        if (typeof label !== 'string') return FALLBACK_LABEL;
        const text = label.trim();
        if (!text || text === 'menu.modifyWorkspace') return FALLBACK_LABEL;
        return text;
      }

      /** 改写克隆项文案：只替换 itemLabel 文本节点，保留图标和样式。 */
      function applyActionLabel(host, button, label) {
        const spans = queryAll(button, 'span');
        for (let i = 0; i < spans.length; i += 1) {
          const span = spans[i];
          if (attr(span, 'aria-hidden') === 'true') continue;
          if (span.children && span.children.length > 0) continue;
          if (!cleanText(textOf(span))) continue;
          span.textContent = label;
          return true;
        }

        let replaced = false;
        walkTextNodes(host, function visitText(node) {
          if (replaced) return;
          if (!cleanText(node.nodeValue || node.data || '')) return;
          try {
            node.nodeValue = label;
            if ('data' in node) node.data = label;
          } catch (ignored) {
            return;
          }
          replaced = true;
        });
        if (replaced) return true;

        // 最后兜底：结构完全未知时直接设置按钮文本（会丢图标，但仍可用）。
        button.textContent = label;
        return true;
      }

      function walkTextNodes(root, visit) {
        if (!root || !root.childNodes) return;
        for (let i = 0; i < root.childNodes.length; i += 1) {
          const child = root.childNodes[i];
          if (!child) continue;
          if (child.nodeType === 3) {
            visit(child);
          } else if (child.nodeType === 1) {
            if (attr(child, 'aria-hidden') === 'true') continue;
            walkTextNodes(child, visit);
          }
        }
      }

      function stripIdsAndSemantics(node) {
        _stripOn(node);
        const marked = queryAll(node, '[id],[aria-checked],[aria-selected],[aria-haspopup],[aria-expanded],[aria-keyshortcuts],[data-state]');
        for (let i = 0; i < marked.length; i += 1) _stripOn(marked[i]);
      }

      function _stripOn(node) {
        const attrs = ['id', 'aria-checked', 'aria-selected', 'aria-haspopup', 'aria-expanded', 'aria-keyshortcuts', 'data-state'];
        for (let i = 0; i < attrs.length; i += 1) {
          try {
            if (node.hasAttribute && node.hasAttribute(attrs[i])) node.removeAttribute(attrs[i]);
          } catch (ignored) { /* noop */ }
        }
      }

      /* ------------------------------------------------------------------ */
      /* 4. 克隆项点击：先关原生菜单，再打开“修改工作区”对话框                     */
      /* ------------------------------------------------------------------ */

      function handleActionClick(event, menu, workspace, clone) {
        try {
          if (event) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
          }
          closeNativeMenu(menu);
          cleanupClone(clone);
          try {
            onOpen(workspace);
          } catch (error) {
            warn('onOpen(workspace) failed', error);
          }
        } catch (error) {
          warn('menu action click failed', error);
        }
      }

      /** 原生 Menu 在 document 捕获阶段监听 Escape；菜单元素派发即可命中其关闭逻辑。 */
      function closeNativeMenu(menu) {
        try {
          if (typeof KeyboardEvent !== 'function') return;
          const documentRef = (menu && menu.ownerDocument) || document;
          const event = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          const target = (menu && typeof menu.dispatchEvent === 'function' && menu.isConnected !== false)
            ? menu
            : documentRef;
          target.dispatchEvent(event);
          if (!event.defaultPrevented && target !== documentRef) {
            const fallback = new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              keyCode: 27,
              which: 27,
              bubbles: true,
              cancelable: true,
              composed: true,
            });
            documentRef.dispatchEvent(fallback);
          }
        } catch (error) {
          warn('failed to close native menu', error);
        }
      }

      function cleanupClone(clone) {
        const handler = clones.get(clone);
        try {
          if (handler) clone.removeEventListener('click', handler);
        } catch (ignored) { /* noop */ }
        clones.delete(clone);
        try {
          if (clone.parentNode) clone.parentNode.removeChild(clone);
        } catch (ignored) { /* noop */ }
      }

      /* ------------------------------------------------------------------ */
      /* 5. install / dispose                                                 */
      /* ------------------------------------------------------------------ */

      const canInstall = typeof document !== 'undefined'
        && !!document.body
        && typeof MutationObserver === 'function'
        && !!resolveWorkspace
        && !!onOpen;

      if (!canInstall) {
        return function disposeMenuActionNoop() { /* nothing installed */ };
      }

      function dispose() {
        if (disposed) return;
        disposed = true;

        try {
          if (observer) observer.disconnect();
        } catch (ignored) { /* noop */ }
        observer = null;

        try {
          document.removeEventListener('click', recordRowClick, true);
        } catch (ignored) { /* noop */ }

        retries.forEach(function cancelEntry(entry) {
          try { entry.cancel(); } catch (ignored) { /* noop */ }
        });
        retries.clear();

        clones.forEach(function removeClone(handler, node) {
          try { node.removeEventListener('click', handler); } catch (ignored) { /* noop */ }
          try { if (node.parentNode) node.parentNode.removeChild(node); } catch (ignored) { /* noop */ }
        });
        clones.clear();

        // 清扫可能失去跟踪的克隆节点/标记（例如菜单在 dispose 前被 React 重建）。
        try {
          const staleClones = queryAll(document, '[' + ACTION_ATTR + ']');
          for (let i = 0; i < staleClones.length; i += 1) {
            const node = staleClones[i];
            if (node.parentNode) node.parentNode.removeChild(node);
          }
          const markedMenus = queryAll(document, '[' + ENHANCED_ATTR + ']');
          for (let i = 0; i < markedMenus.length; i += 1) markedMenus[i].removeAttribute(ENHANCED_ATTR);
        } catch (ignored) { /* noop */ }

        lastRowClick = null;
      }

      try {
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('click', recordRowClick, true);
      } catch (error) {
        warn('failed to install workspace menu observer', error);
        try {
          if (observer) observer.disconnect();
        } catch (ignored) { /* noop */ }
        observer = null;
        try { document.removeEventListener('click', recordRowClick, true); } catch (ignored) { /* noop */ }
        disposed = true;
        return function disposeMenuActionFailed() { /* nothing installed */ };
      }

      return dispose;
    }
    //#endregion
    //#region src/client/90-apply.js
    /**
     * Plugin wiring for dsh-multi-workspace.
     *
     * Registers the client locale dictionaries, the overlay host that owns the
     * dialogs, the two directory-flow occupants (shadowing the native picker so the
     * create flow can collect several folders before creating anything), and the
     * workspace row menu augmentation.
     */

    /** Locale namespace used by every string in this plugin. */
    const MW_LOCALE_NS = 'multi-workspace';

    /** Resolve one localized string from the registered dictionary. */
    function mwTranslate(ctx, key, params) {
      let locale = '';
      try {
        const snapshot = ctx.locale.getLocale();
        if (snapshot && typeof snapshot === 'object') locale = snapshot.active || snapshot.locale || snapshot.id || snapshot.lang || '';
        else if (typeof snapshot === 'string') locale = snapshot;
      } catch { /* locale is optional for rendering a fallback */ }
      const table = typeof MW_DICTS === 'object' && MW_DICTS !== null ? MW_DICTS : {};
      const dict = (/^en\b/i.test(String(locale)) ? table.en : table.zh) || table.zh || table.en || {};
      let text = dict[key];
      if (typeof text !== 'string') text = key;
      if (params && typeof params === 'object') {
        for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
      }
      return text;
    }

    /** Build every side effect the UI needs from the Cordis client services. */
    function createMwActions(ctx, store, t, logger) {
      const warn = (message) => {
        try { logger?.warn?.('[multi-workspace] ' + message); } catch { /* logging is best effort */ }
      };
      const getWorkspaces = () => {
        try {
          const snapshot = ctx.workspaces.list.getSnapshot();
          return snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        } catch (error) {
          warn('workspace snapshot failed: ' + mwErrorMessage(error));
          return [];
        }
      };

      const actions = {
        getWorkspaces,
        listDirectory(path, signal) {
          return ctx.uiWorkspace.listDirectory(path, signal);
        },
        createDirectory(parentPath, name) {
          return ctx.uiWorkspace.createDirectory(parentPath, name);
        },
        pickDirectory() {
          return ctx.uiWorkspace.pickDirectory();
        },
        loadState() {
          return mwLoadState();
        },
        openCreate(flow) {
          store.setState({ dialog: { mode: 'create', workspace: null, flow: flow || null } });
        },
        openModify(workspace) {
          if (!workspace || typeof workspace.workspaceId !== 'string') return;
          store.setState({ dialog: { mode: 'modify', workspace, flow: null } });
        },
        closeDialogIfFlow(flow) {
          const dialog = store.getSnapshot().dialog;
          if (dialog && dialog.flow === flow) store.setState({ dialog: null });
        },
        cancelDialog() {
          const dialog = store.getSnapshot().dialog;
          store.setState({ dialog: null });
          const flow = dialog && dialog.flow;
          if (flow && typeof flow.onCancel === 'function') {
            try { flow.onCancel(); } catch (error) { warn('flow cancel failed: ' + mwErrorMessage(error)); }
          }
        },
        async submitCreate(input) {
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const primaryPath = typeof input.primaryPath === 'string' ? input.primaryPath.trim() : '';
          if (!primaryPath) throw new Error(t('error.noFolder'));
          let view = await ctx.workspaces.create({ path: primaryPath });
          const finalName = name || mwBasename(primaryPath) || view.title || '';
          if (finalName && view.title !== finalName) {
            try { view = await ctx.workspaces.rename(view.workspaceId, finalName); }
            catch (error) { warn('rename after create failed: ' + mwErrorMessage(error)); }
          }
          const roots = mwNormalizeSelection(input.roots, view.path || primaryPath);
          await mwSaveWorkspace({ id: view.workspaceId, name: finalName, path: view.path || primaryPath, roots });
          const dialog = store.getSnapshot().dialog;
          store.setState({ dialog: null });
          const flow = dialog && dialog.flow;
          if (flow && typeof flow.onPicked === 'function') {
            try { flow.onPicked(view.path || primaryPath); }
            catch (error) { warn('adopting picked folder failed: ' + mwErrorMessage(error)); }
          } else {
            try { ctx.uiWorkspace.openWorkspace(view.workspaceId); }
            catch (error) { warn('opening created workspace failed: ' + mwErrorMessage(error)); }
          }
          return view;
        },
        async submitModify(input) {
          const workspace = input.workspace || {};
          if (typeof workspace.workspaceId !== 'string') throw new Error(t('error.noWorkspace'));
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          let current = workspace;
          if (name && workspace.title !== name) current = await ctx.workspaces.rename(workspace.workspaceId, name);
          const state = await mwLoadState();
          const primaryPath = mwRecordPrimaryPath(state, current) || '';
          const roots = mwNormalizeSelection(input.roots, primaryPath);
          await mwSaveWorkspace({ id: current.workspaceId, name: name || current.title || '', path: primaryPath, roots });
          store.setState({ dialog: null });
          return current;
        },
        notifyUiError(error) {
          warn('ui error: ' + mwErrorMessage(error));
        },
      };
      return actions;
    }

    /**
     * Occupant of a directory-flow hole. It never picks a folder itself: it opens
     * the multi-folder create dialog once per owner `open`, and closes that dialog
     * when the owner withdraws or the flow is superseded.
     */
    function MultiWorkspaceFlow(props) {
      const open = props.open === true;
      const actions = props.actions;
      const ownerRef = React.useRef(null);
      const actionsRef = React.useRef(actions);
      actionsRef.current = actions;
      React.useEffect(() => {
        const api = actionsRef.current;
        if (!api) return undefined;
        if (open) {
          if (ownerRef.current) return undefined;
          const owner = {
            open: true,
            busy: false,
            onPicked: props.onPicked,
            onCancel: props.onCancel,
            onError: props.onError,
          };
          ownerRef.current = owner;
          api.openCreate(owner);
          return undefined;
        }
        const owner = ownerRef.current;
        ownerRef.current = null;
        if (owner) api.closeDialogIfFlow(owner);
        return undefined;
      }, [open]);
      React.useEffect(() => () => {
        const owner = ownerRef.current;
        ownerRef.current = null;
        if (owner) actionsRef.current?.closeDialogIfFlow(owner);
      }, []);
      return null;
    }

    /** Overlay occupant: passes the injected face to the dialog host. */
    function MultiWorkspaceOverlayHost(props) {
      const inject = { store: props.store, actions: props.actions, t: props.t, logger: props.logger };
      return h(OverlayHost, { ...inject, inject });
    }

    /** Register locales, styles, slots and the menu augmentation; all effects dispose. */
    function apply(ctx) {
      const logger = ctx.logger;
      const store = createMwStore({ dialog: null });
      const t = (key, params) => mwTranslate(ctx, key, params);
      const actions = createMwActions(ctx, store, t, logger);
      const pluginId = 'dsh-multi-workspace';

      // Locale dictionaries (one registration per locale; disposed with the plugin).
      ctx.effect(() => {
        const table = typeof MW_DICTS === 'object' && MW_DICTS !== null ? MW_DICTS : {};
        const disposers = [];
        for (const locale of Object.keys(table)) {
          try {
            const dispose = ctx.locale.register(MW_LOCALE_NS, locale, table[locale]);
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch (error) {
            try { logger?.warn?.('[multi-workspace] locale registration failed: ' + mwErrorMessage(error)); } catch { /* ignore */ }
          }
        }
        return () => {
          for (const dispose of disposers) {
            try { dispose(); } catch { /* ignore */ }
          }
        };
      });

      // One style tag owns every rule; removing the tag removes the plugin's CSS.
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = pluginId;
        tag.textContent = typeof MW_CSS === 'string' ? MW_CSS : '';
        document.head.appendChild(tag);
        return () => { try { tag.remove(); } catch { /* ignore */ } };
      });

      // The single overlay host renders every dialog above the application shell.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'multi-workspace-overlay',
        order: 60,
        inject: () => ({ store, actions, t, logger }),
      }, MultiWorkspaceOverlayHost));

      // Shadow the composed native picker (priority 0) so the create flow can build
      // a multi-folder selection before anything is created. `single` slots render
      // the lowest priority, so -100 wins.
      for (const slot of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']) {
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          id: 'multi-workspace-flow',
          priority: -100,
          inject: () => ({ actions, t, logger }),
        }, MultiWorkspaceFlow));
      }

      // Augment the native workspace row menu with "修改工作区".
      ctx.effect(() => {
        if (typeof installWorkspaceMenuAction !== 'function') return () => {};
        try {
          return installWorkspaceMenuAction({
            t: (key) => t(key),
            logger,
            resolveWorkspace: (label) => mwFindWorkspaceByLabel(actions.getWorkspaces(), label),
            onOpen: (workspace) => actions.openModify(workspace),
          });
        } catch (error) {
          try { logger?.warn?.('[multi-workspace] menu augmentation failed: ' + mwErrorMessage(error)); } catch { /* ignore */ }
          return () => {};
        }
      });

      return undefined;
    }
    //#endregion
    return { inject: ['slots', 'workspaces', 'uiWorkspace', 'locale'], apply };
  },
});
