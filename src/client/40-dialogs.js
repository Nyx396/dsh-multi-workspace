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
