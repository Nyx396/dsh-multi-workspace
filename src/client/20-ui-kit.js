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
