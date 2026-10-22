# 工作区“...”菜单 DOM 增强探测报告（50-menu.js）

任务：task-3。目标是在 DSH 原生工作区行的“...”菜单里加入“修改工作区”入口。
官方没有可用的 menu slot，所以 50-menu.js 采用 **DOM 增强**：只观察、克隆、插入一个菜单项，
不修改原生项、不改 React 状态、不常驻挂载节点。

- 实现文件：`src/client/50-menu.js`（共享闭包脚本片段，无 import/export，只定义
  `installWorkspaceMenuAction(options)`）。
- 调用方：`90-apply.js`：
  ```js
  const disposeMenu = installWorkspaceMenuAction({
    t,                 // (key) => string；t('menu.modifyWorkspace') → “修改工作区”
    logger,            // 可选 { warn(msg) }
    resolveWorkspace,  // (label) => workspace | undefined（按标题快照匹配）
    onOpen,            // (workspace) => void（打开“修改工作区”对话框）
  });
  // 插件 dispose 时调用 disposeMenu()（幂等）
  ```
- 兼容别名：`options.resolveWorkspaceByLabel`（与 `resolveWorkspace` 等价）。

## 1. 证据来源（已核对 DSH 0.2.1-rc.2 包内源码）

DSH 安装目录 `resources/app.asar` 内的两个文件（asar 为普通打包，可用 asar header 偏移直接读取）：

1. `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
   - `ProjectRowItem`（工作区行，约第 1950 行）：
     - 行元素：`<div class="…projectRow…" data-row-key={\`workspace:${group.key}\`} role="treeitem" aria-expanded=… onClick={onToggle}>`
     - 标题：`<span class="…projectText…"><span class="…title…">{label}</span></span>`
     - “...”按钮（`Menu` 的 `anchor`）：
       ```jsx
       <button type="button" className="…iconButton…"
         aria-label={t("actions.workspace.aria", { name: label })}
         onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}>
         <IconEllipsisOutlineRegular />
       </button>
       ```
     - 菜单 items 固定两项且**没有扩展 slot**：
       `[{ id:"rename", label:t("rename"), icon:<IconEditOutlineRegular/> },
         { id:"delete", label:t("delete.workspace"), icon:<IconTrashOutlineRegular/>, danger:true }]`
     - `Menu` 使用 `portal: true`、`closeOnPointerLeave: true`；`onSelect` 收到 `rename`/`delete`。
   - locale：`"actions.workspace.aria": "工作区“{name}”的操作"`（zh）、
     `"actions.workspace.aria": "Workspace actions for {name}"`（en）。

2. `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`
   - `Menu`（`k_`）/ 菜单项组件：
     - 菜单根（portal 到 `document.body`）：
       ```html
       <div role="menu" data-menu-material="translucent" class="…list…">
         <div aria-hidden="true" class="…material…"></div>
         <div role="presentation" class="…viewport…">
           <div class="…itemWrap…"> …菜单项… </div>
           <div class="…itemWrap…"> …菜单项… </div>
         </div>
       </div>
       ```
     - 每个菜单项（`tA` / 子项）：
       ```html
       <div class="…itemWrap…">                     <!-- ← 真正的“项”容器，viewport 的直接子节点 -->
         <button type="button" role="menuitem" class="…item…">
           <span class="…itemIcon…"><svg/></span>
           <span class="…itemLabel…">重命名</span>
           <span aria-hidden="true" class="…shortcut…">…</span>  <!-- 可选 -->
         </button>
       </div>
       ```
     - 关闭逻辑（关键）：
       - 菜单打开时在 **document 捕获阶段**注册 `keydown`：`ne.key === "Escape" && !ne.shiftKey`
         → `preventDefault()` → `onClose()`（关闭菜单并把焦点还给触发按钮）。
       - 同时监听 document `pointerdown`（点到菜单/锚点外关闭）和菜单根 `onClick`（stopPropagation，
         子项点击后做焦点恢复）。
     - 键盘导航只枚举 `button:not(:disabled)`，所以克隆出的按钮天然可被方向键/Tab 选中并触发 click。

结论：增强点 = **克隆第一个 `itemWrap`**（而非只克隆 button，否则同一 `itemWrap` 里会出现两个按钮，
样式和语义都会坏），插到第一个 `itemWrap` 之后；把克隆里的 `itemLabel` 文本改成
`t('menu.modifyWorkspace')`。

## 2. 选择器与 DOM 假设

| 用途 | 选择器 / 属性 | 说明 |
| --- | --- | --- |
| 工作区行 | `[data-row-key]`，值以 `workspace:` 开头 | 行上另有 `role="treeitem"`；session 行是 `session:<id>`，用前缀排除 |
| 行内标题 | 行内叶子元素文本（`querySelectorAll('*')` 中无子元素者） | `title` span 是叶子，文本 = workspace title |
| “...”按钮 | 行内 `closest('button[aria-label]')` | aria-label 模板见上；也用于排除点击行空白/标题的情况 |
| 菜单根 | `[role="menu"]`（body 子树新增节点或既有菜单内部变化） | portal 到 `document.body` |
| 菜单项 | `button[role="menuitem"]`，工作区菜单恰好 2 个 | 数量不是 2 就静默跳过 |
| 项容器 | 从按钮向上，找到“父级已含 >1 个 menuitem”之前的那一层 | 正常是 `div.itemWrap`；直接子节点是 button 时退化为 button 本身 |
| 插入位置 | 第一个 itemWrap / 第一个 menuitem 的 `parentNode.insertBefore(clone, host.nextSibling)` | 紧跟在“重命名”之后 |
| 幂等标记 | 菜单根 `data-mw-menu-enhanced="1"`，克隆项 `data-mw-menu-action="modify-workspace"` | 双保险；另用 WeakSet 记录已增强菜单 |

DOM 假设（若 DSH 升级后不满足，增强会静默不生效，但不影响原生菜单）：

1. 菜单根仍是 `[role="menu"]`，portal 到 `document.body`。
2. 工作区菜单仍恰好有 2 个 `button[role="menuitem"]`（rename + delete）。
3. 工作区行仍有 `data-row-key="workspace:<key>"`，行内“...”按钮仍有含工作区名的 `aria-label`。
4. 菜单项按钮外包一层容器（`itemWrap`），且按钮内有文本叶子 span（`itemLabel`）。
5. 原生菜单仍用 document 捕获阶段 `keydown` 的 Escape 关闭。

## 3. 增强算法（50-menu.js 内部）

1. `installWorkspaceMenuAction(options)` 校验环境：无 `document`/`body`/`MutationObserver`、
   缺 `resolveWorkspace` 或 `onOpen` 时直接返回 noop dispose。
2. 安装：
   - `document.addEventListener('click', recordRowClick, true)`（捕获阶段，早于 React 的 onClick）。
   - `new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true })`。
3. `recordRowClick`：
   - `event.target.closest('[data-row-key]')`，要求 key 以 `workspace:` 开头；
   - 在其中 `closest('button[aria-label]')` 取 aria-label；拿不到（点击行空白/标题）就清空快照；
   - 记录 `{ at, row, rowKey, ariaLabel }`。**任何一次不在工作区行内的点击都会清空快照**，
     避免之后碰巧出现 2 项菜单时误增强。
4. `onMutations`：对每条 mutation
   - `record.target.closest('[role="menu"]')` 命中（菜单内部变化）→ 检查该菜单；
   - 遍历 `addedNodes`：自身或子树里有 `[role="menu"]` → 检查。
5. `processMenu(menu)`（所有判断失败都静默返回）：
   - 已标记/已增强/已断开 → 跳过；
   - 取 `button[role="menuitem"]`；0 个 → 用 `requestAnimationFrame` 只重试一帧（防 React 分次提交）；
     不是恰好 2 个 → 跳过；
   - 最近点击快照须在 6000ms 内，否则跳过；
   - 解析工作区：按候选标签顺序调用 `resolveWorkspace(label)`，取第一个返回非空的结果；
     全部失败 → 不增强（兜底，符合“匹配不到不改菜单”）。
6. `enhanceMenu`：
   - 从第一个 menuitem 向上定位 itemWrap，`cloneNode(true)`；
   - 改文案：优先找按钮内非 `aria-hidden` 的叶子 span（即 `itemLabel`）设置文本；找不到则替换第一个
     非空文本节点；再兜底设置按钮 textContent（仅极端未知结构，会丢图标）；
   - 清理克隆里的 `id`、`aria-checked/selected/haspopup/expanded/keyshortcuts`、`data-state`，
     避免重复 id / 语义错乱；若克隆按钮带 `aria-label` 就同步改成新文案；
   - 克隆项加 `data-mw-menu-action`；菜单根加 `data-mw-menu-enhanced`（**先标记再插入**，防观察者自触发）；
   - 给克隆项挂 click 监听后插入到第一个 itemWrap 之后。
7. 克隆项 click：
   - `preventDefault()` + `stopPropagation()`（阻止冒泡到菜单根的 React onClick，避免焦点被抢/重复关闭逻辑）；
   - 向菜单元素派发合成 `KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true, cancelable:true })`，
     命中原生 document 捕获监听 → 原生 `onClose()` 关闭菜单；若事件未被 preventDefault 再向 document 补发一次；
   - 移除克隆项，然后同步 `onOpen(workspace)`。
8. `dispose()`（幂等）：
   - 断开 observer、移除 document click 捕获监听、取消一次 rAF 重试；
   - 移除所有克隆项（含监听）并清扫 `[data-mw-menu-action]`；
   - 移除所有菜单上的 `data-mw-menu-enhanced`；清空点击快照；之后所有回调 no-op。
9. 异常策略：每个回调、每步 DOM 操作都包 `try/catch`；只调用 `logger.warn('[multi-workspace] …')`，
   日志本身失败也被吞掉。任何结构不符/解析失败都只是“本次不增强”，绝不抛错、不影响原生菜单。

### 3.1 工作区名候选提取（为什么需要多候选）

`resolveWorkspace(label)` 按 workspace title 精确匹配，所以传入的必须是**纯标题**，
不能是整条 aria-label。`collectLabelCandidates` 按可靠性排序，逐个尝试：

1. **行内叶子文本**：workspace 行里叶子元素（`projectText > title` span）文本就是 title，
   对任何语言都成立，最可靠；
2. **引号提取**：zh 模板 `工作区“{name}”的操作` → 取 `“…”` 内文本（也兼容 `"…"`/`「…」`）；
3. **已知模板**：en `Workspace actions for {name}`、zh 去引号版 `工作区{name}的操作`；
4. **分隔符两侧**：`： : | — – - » › > ， ,` 的前/后片段（其它语言、未来模板兜底）；
5. **原样 aria-label**：最后兜底（若 title 本身含分隔符也能命中）。

每个候选还会追加去掉首尾引号/括号的变体；去重后最多尝试若干次（行内文本限 8 条）。
每次调用 `resolveWorkspace` 都同步、无副作用；全部返回 `undefined` 时本次不增强。

## 4. 失败兜底与已知风险

兜底：

- 没有 `document`/`body`/`MutationObserver`、或 `90-apply` 未提供 `resolveWorkspace`/`onOpen`
  → 返回 noop dispose，不报错。
- 菜单不是 2 项 / 不是工作区菜单 / 标题匹配失败 → 不增强，原生菜单照常工作。
- 文案 `t('menu.modifyWorkspace')` 缺失（返回 key 或空）→ 使用内置“修改工作区”。
- Escape 关闭失败（上游改了关闭机制）→ 克隆项仍可点击并打开对话框；菜单可能残留到下一次点击
  （点击外部/再次点“...”即可关闭），原生项不受影响。
- 未知菜单项结构 → 文本兜底为直接设置按钮文本（会丢图标），仍保持可点击。

风险（升级 DSH 后需复测）：

1. **上游 DOM 变更**：`role="menu"`/`menuitem`、`itemWrap` 层级、`data-row-key`、
   aria-label 模板任一变化都会让增强静默失效（不是崩溃）。复测点见第 5 节。
2. **React 协调**：克隆节点插在 React 管理的 `viewport` 里，属于“计划外节点”。菜单打开期间如果
   父组件重渲染重排 itemWrap，克隆可能被移动/移除；菜单通常在点击后立即关闭，实际影响很小。
   若未来出现菜单内异步更新，可改为“每次观察都确认克隆仍紧跟在第一项后，否则重建”。
3. **键盘打开菜单**：若菜单不是由 click 打开（例如纯键盘快捷键直接打开菜单、没有 click 事件），
   点击快照为空 → 不增强。目前工作区菜单只能点“...”按钮（Enter/Space 在按钮上也会合成 click），
   所以正常可用；纯脚本派发 `menuOpen` 的场景不覆盖。
4. **点击快照时效 6 秒**：窗口内若又出现另一个 2 项菜单（非工作区菜单且无新 click 覆盖）理论上
   可能误判；实际菜单都随 click 打开，风险低。任何其它 click 会立即清空快照。
5. **aria-label 依赖工作区名**：工作区改名后 aria-label 与 title 同步更新；行内标题候选也能兜底。
6. **locale**：只确认了 zh/en 模板；其它语言靠引号/分隔符/行内标题兜底（行内标题最通用）。
7. **无浏览器自动化**：本环境无法点真实 UI（Web UI 需登录且不能自动截图/点击），
   所以以上为“源码 + 假 DOM 行为验证”；真机视觉/交互需人工验收（第 6 节清单）。

## 5. DSH 升级后的快速复测点（DevTools Console）

1. 打开工作区行菜单，检查：
   ```js
   document.querySelector('[role="menu"]')?.outerHTML.slice(0, 800)
   ```
   应看到 `role="menu"`、两个 `div.itemWrap > button[role="menuitem"]`。
2. 检查工作区行：
   ```js
   document.querySelector('[data-row-key^="workspace:"]')?.outerHTML.slice(0, 500)
   ```
   应有 `data-row-key="workspace:…"` 与 `button[aria-label^="工作区"]`（中文界面）。
3. 增强后菜单应有 3 个 menuitem，第二个文本为“修改工作区”且带
   `data-mw-menu-action="modify-workspace"`；原生两项文本/图标不变。
4. 点“修改工作区”后：原生菜单应关闭，插件“修改工作区”对话框打开。
5. 插件被禁用/卸载后菜单恢复 2 项、无残留 `[data-mw-menu-action]` 节点。

## 6. 已执行的验证

1. `"C:\Program Files\nodejs\node.exe" --check src/client/50-menu.js` → 通过。
2. 假 DOM 冒烟（临时 harness `%TEMP%\mw-probe\menu-smoke.cjs`，不参与打包）：
   用 `new Function('document','MutationObserver','KeyboardEvent','requestAnimationFrame','cancelAnimationFrame', src + ';return installWorkspaceMenuAction;')`
   注入，构造与真实标记一致的 DOM（`data-row-key` 行、`role=menu` + `material` + `viewport` +
   `itemWrap` + `button[menuitem]` + `itemLabel`/`itemIcon`），并模拟 document 捕获阶段 Escape 监听。
   覆盖 12 个场景、30+ 断言，全部通过：
   - 基础增强：克隆项插入第一项之后、文案为“修改工作区”、原生两项文本/图标不变、克隆项保留图标、
     `id` 已清理、无警告；
   - 幂等：菜单内再次发生 mutation 仍只有 1 个克隆项；
   - 克隆项点击：派发 1 次 Escape（被原生监听 `preventDefault`）、`onOpen` 收到 workspace、
     克隆项被移除、click 未冒泡到菜单根；
   - dispose：移除克隆/标记/监听，dispose 后再开菜单不增强，重复 dispose 不抛错；
   - 未点击工作区行 / 点击 session 行 / 3 项菜单 / 标题匹配失败 → 均不增强且无警告；
   - en aria-label 模板、空菜单分两次提交（rAF 重试）、`t()` 缺 key 回退、无 DOM 环境 noop。
3. 未执行：真实 DSH Web UI 点击验证（无浏览器自动化能力，且 GUI 需登录态）。
