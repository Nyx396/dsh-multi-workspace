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
