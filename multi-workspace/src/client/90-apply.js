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
