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
