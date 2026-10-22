# dsh-multi-workspace 客户端 UI 报告（client-ui · task-2）

> 维护者：client-ui。本文记录 4 个 UI 片段的实现契约、i18n key 清单、交互细节、
> smoke 自测命令与实际输出，以及 Lead 在 90-apply 中需要确认的接线点。
> 所有命令在 `F:\AIwork\DSH custom plugin\multi-workspace` 下执行。

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `src/client/15-i18n.js` | `MW_I18N_NS`、`MW_DICTS {zh,en}`、`MW_I18N_KEYS`、`mwI18nFormat` / `mwI18nDictionary` / `mwI18nTranslator` |
| `src/client/20-ui-kit.js` | `Icon`（16 种自绘 SVG）、`Button`（ghost/primary/outline + sm）、`Modal`（portal/遮罩/Esc/focus trap/aria）、`MW_CSS`（全部 `mw-` 类 + `--dsw-*` token） |
| `src/client/30-browser.js` | `FolderBrowser` 层叠文件夹浏览器与路径纯函数 |
| `src/client/40-dialogs.js` | `CreateWorkspaceDialog`、`ModifyWorkspaceDialog`、`OverlayHost` 与本地状态纯函数 |
| `dev/ui-smoke.mjs` | 无浏览器、无网络的 vm + React stub 冒烟自测 |
| `dev/ui-report.md` | 本报告 |

约束遵守情况：

- 四个片段都是“共享闭包里的普通脚本”：无 `import/export`、无 `window` 顶层副作用、只使用 wrapper 提供的
  `React` / `createPortal` / `h` / `Fragment`；未 require 除 react / react-dom 之外的包。
- 只由 `90-apply.js` 注入 `<style>`（`MW_CSS`）；UI 片段自己不建 `<style>`、不访问 `ctx`。
- 颜色全部走 `--dsw-*` 主题 token（smoke 会扫描 `MW_CSS`，禁止 hex/rgb/hsl 与非法 `var()`）；
  支持 light/dark、`prefers-reduced-motion`、`forced-colors`。
- CSS 全部 `mw-` 前缀；Modal 用 `createPortal(..., document.body)`，带 `role="dialog"`、
  `aria-modal="true"`、`aria-labelledby`、Esc/遮罩关闭、焦点环、焦点陷阱与焦点归还。

## 2. 组件签名与 props / inject 契约

### 2.1 OverlayHost（`shell.overlay` 常驻宿主）

```js
OverlayHost({ store, actions, t, logger })            // 直接 props（90-apply 的 inject 面展开）
OverlayHost({ inject: { store, actions, t, logger } }) // 兼容旧契约；两者都传时以 inject 为准
```

- `React.useSyncExternalStore(store.subscribe, store.getSnapshot)` 订阅 `{ dialog: null | DialogState }`。
- `dialog === null` → 渲染 `null`。
- `dialog.mode === 'modify'` → `ModifyWorkspaceDialog`；其他 → `CreateWorkspaceDialog`。
- 若 `dialog.flow && dialog.flow.open === false`：依次尝试
  `actions.closeDialogIfFlow(flow)` → `actions.closeDialog()` → `actions.cancelDialog()`（`useEffect` 内）。
- `DialogState = { mode:'create'|'modify', workspace?: WorkspaceView, flow?: Flow|null }`，
  `Flow = { open, busy, onPicked(path), onCancel(), onError(message) }`。

### 2.2 CreateWorkspaceDialog / ModifyWorkspaceDialog

```js
CreateWorkspaceDialog({ dialog, actions, t, logger })
ModifyWorkspaceDialog({ dialog, actions, t, logger })
```

只使用以下 `actions`（全部由 90-apply 注入，组件从不直接调 `ctx`）：

| actions 方法 | 用途 | 失败处理 |
| --- | --- | --- |
| `submitCreate({ name, primaryPath, roots })` | 创建：`roots` 不含主文件夹；`name` 已按“空则 basename(primaryPath)”补齐 | Promise reject → 对话框内 `ul[role=alert]`；create flow 时追加调用 `flow.onError(message)` |
| `submitModify({ workspace, name, roots })` | 修改：`roots` 不含主文件夹；名称仅在用户填写时提交 | Promise reject → 对话框内 `ul[role=alert]` |
| `cancelDialog()`（或 `closeDialog()`） | 取消/关闭 X | 期间 busy 时忽略 |
| `loadState()` | 修改模式读取 `{ workspaces: { id: record } }` 预填 `path`/`roots`/`name` | reject → `error.load` 提示，表单仍可操作 |
| `listDirectory(path, signal)` / `createDirectory(parentPath, name)` | 透传给 `FolderBrowser` | 浏览器内 `role=alert` |

- 创建模式：`folders` 首项为主文件夹；`name.trim() || mwBasename(folders[0])`；至少 1 个文件夹才启用
  “创建”（按钮 `disabled`，提交函数二次校验）；成功后由 90-apply 关闭并收养/打开，组件不自行关闭。
- 修改模式：初始 `folders = [workspace.path]`（异步 `loadState` 到达后合并记录中的 `roots`）；
  主文件夹不可移除；`name` 初始取 `workspace.title`；用户已编辑（ref 标记）时异步加载不覆盖输入。
- 防重复提交：提交期间 `busy=true`，主按钮显示“正在创建…/正在保存…”且带 spinner，输入/添加/移除全部禁用。

### 2.3 FolderBrowser（层叠，由对话框内部管理 open）

```js
FolderBrowser({ open, initialPath, listDirectory, createDirectory, onClose, onConfirm, t })
```

- `initialPath` 为空时调用 `listDirectory(undefined, signal)` 列出 Host home；
  真实 browse 返回 `{ path, home, crumbs, entries:[{name,path,hidden}], truncated }`（已核对
  `dsh-host-directory-picker-browse` 源码），本组件用 `path`/`home` 校正绝对路径与分隔符，
  自行生成面包屑（`D:\` / `C:\Users\...` / POSIX 根都能处理）。
- `onConfirm(paths)` 回传跨目录累积的绝对路径数组（去重、保持勾选顺序）；`onClose()` 只关浏览层。
- 交互：面包屑跳转、路径输入（Enter 跳转）、上一级、多选 checkbox、双击行进入、行尾 chevron 进入、
  “显示隐藏文件夹”开关（默认关，`hidden:true` 不显示）、“添加所选”（0 个时禁用）、“取消”、
  新建文件夹（调用 `createDirectory(current, name)`，成功后刷新并自动勾选新文件夹）。
- 错误：`role=alert` 内联显示；加载中显示“正在加载…”，`truncated` 时显示截断提示。
- 每次打开重置选择/隐藏开关/新建状态；AbortController 取消上一次列目录请求，卸载时 abort。

### 2.4 纯函数（smoke 直接断言）

- `mwBrowserParentPath(path, separator)`：Windows 盘根 / POSIX 根边界。
- `mwBrowserSegments(path, separator)`：面包屑 label + 绝对 path。
- `mwBrowserJoin(dir, name, separator)`、`mwBrowserKey(path)`：不重复分隔符；大小写/斜杠归一化去重。
- `mwDlgMergeFolders(existing, incoming)`、`mwDlgKey(path)`：文件夹列表去重、保序、主文件夹置首。
- `mwI18nTranslator(locale)`：无注入 `t` 时的兜底翻译；`mwUiText(t, key, params)`：优先注入 `t`，
  捕获 translator 异常后回退 `MW_DICTS.zh`。

## 3. 与截图的布局对齐

对话框（宽 `min(480px, 100%)`、圆角 `--dsw-radius-panel`、卡片 `--dsw-alias-bg-layer-2`）：

```
┌──────────────────────────────────────────────┐
│ 创建工作区 / 修改工作区                  [X]  │  ← header 22px 14px 12px 24px，标题 16/24 500
├──────────────────────────────────────────────┤
│ [文件夹图标]  工作区名称（占位）              │  ← .mw-field：48px 高、0.5px border-l4、radius-lg
│                                              │
│ 源文件夹                                       │  ← .mw-section__label（13/20 500 secondary）
│ ┌──────────────────────────────────────────┐ │  ← .mw-source：0.5px border-l3、radius-lg
│ │ 在此电脑上添加文件夹 ⌄        [ 添加 ]     │ │  ← 空：居中 prompt + 添加按钮
│ ├──────────────────────────────────────────┤ │
│ │ [图标] D:\Work\Demo   [主文件夹]           │ │  ← 主文件夹行：无移除按钮
│ │ [图标] E:\Assets                     [X]  │ │  ← 成员行：移除图标按钮
│ │ 在此电脑上添加文件夹 ⌄        [ 添加 ]     │ │  ← 非空：容器底部 add-row
│ └──────────────────────────────────────────┘ │
│ [取消]                            [创建/保存]  │  ← footer 右对齐，主按钮 button-primary-fill
└──────────────────────────────────────────────┘
```

- 标题行含右上 X（`aria-label` 本地化“关闭”）。
- 名称输入行：文件夹图标 + 占位“工作区名称”，聚焦时边框变 `--dsw-alias-brand-primary`。
- 主按钮文案：创建模式“创建”（busy“正在创建…”），修改模式“保存”（busy“正在保存…”）。
- 浏览器（宽 `min(620px,100%)`、高 `min(540px,100dvh-48px)`，`layer: 1` 层叠在创建/修改对话框之上）：
  面包屑 → 返回上级 + 路径输入 → 新建文件夹 + 状态 → 文件夹列表 → 显示隐藏文件夹 + 取消/添加所选。

## 4. i18n key 清单（54 个，zh = en 键集）

命名空间 `multi-workspace`；90-apply 通过 `ctx.locale.register('multi-workspace', locale, MW_DICTS[locale])`
注册，并将绑定后的 `t(key, params)` 传给组件（插值语法 `{name}` / `{n}`）。**组件内部不创建 t。**

| 分组 | keys |
| --- | --- |
| 对话框 | `dialog.create.title` 创建工作区 / `dialog.modify.title` 修改工作区 / `dialog.loading` |
| 字段 | `field.name.label`、`field.name.placeholder`（工作区名称） |
| 源文件夹 | `section.sourceFolder` 源文件夹、`badge.primary` 主文件夹、`source.addPrompt` 在此电脑上添加文件夹、`source.noSelection` 未选择文件夹、`source.removePrimaryHint` |
| 动作 | `action.add` 添加、`action.addFolder`、`action.addSelected` 添加所选、`action.cancel` 取消、`action.close` 关闭、`action.create` 创建、`action.creating` 正在创建…、`action.open` 打开、`action.remove` 移除、`action.removeFolder`、`action.removeFolder.aria` 移除文件夹“{path}”、`action.retry`、`action.save` 保存、`action.saving` 正在保存… |
| 浏览器 | `browser.title` 添加文件夹、`browser.path` 路径、`browser.up` 上一级、`browser.loading` 正在加载…、`browser.empty`、`browser.truncated`、`browser.showHidden` 显示隐藏文件夹、`browser.selectedCount` 已选择 {n} 个文件夹、`browser.noSelection` 未选择文件夹、`browser.selectFolder`、`browser.openFolder`、`browser.crumbs`、`browser.newFolder` 新建文件夹、`browser.folderName` 文件夹名称、`browser.createFolder` 创建文件夹、`browser.cancelCreate`、`browser.error`、`browser.errorPath`、`browser.errorCreate`、`browser.nameRequired` |
| 错误（对话框内 role=alert） | `error.noFolder` 请至少添加一个文件夹、`error.noWorkspace`、`error.submit`、`error.save`、`error.load`、`error.noAction` |
| 工作区行菜单（50-menu 使用） | `menu.modify`、`menu.modify.aria`、`menu.modifyWorkspace`（50-menu 实际调用）、`menu.modifyWorkspace.aria` |

- 90-apply 的 `submitCreate`/`submitModify` 会调用 `t('error.noFolder')`、`t('error.noWorkspace')`，
  已包含，避免显示成裸 key。
- 复数在 DSH locale 运行时不自动解析：计数文案使用单 key + `{n}`（“已选择 {n} 个文件夹” / “Selected {n} folder(s)”）。

## 5. Smoke 自测

命令（任务指定的 Node）：

```powershell
cd "F:\AIwork\DSH custom plugin\multi-workspace"
& "C:\Program Files\nodejs\node.exe" dev\ui-smoke.mjs
& "C:\Program Files\nodejs\node.exe" tools\build-client.mjs --check
```

`dev/ui-smoke.mjs` 做的事（不需要浏览器、不写任何产物）：

1. 按 `tools/build-client.mjs` 相同顺序拼接**全部 7 个片段**（含 Lead 的 10/90 与 menu 的 50），
   在 `vm` 上下文中以 stub React 求值，等价于做一次“共享闭包 + 无重复声明”的运行时校验。
2. 断言无 `import/export`、无顶层 `window` 访问、必需导出符号齐全、`apply` 可调用。
3. 断言 `MW_DICTS.zh`/`MW_DICTS.en` 键集一致、关键文案、`{n}` 插值、片段中引用的每个 key 都已定义。
4. 扫描 `MW_CSS`：所有 class 带 `mw-`、所有 `var()` 都是 `--dsw-*`、无 hex/rgb/hsl、含
   reduced-motion 与 forced-colors 分支。
5. 纯函数断言：父目录/面包屑/拼接/去重、`mwBasename`。
6. 结构渲染断言：创建/修改对话框字段与按钮 disabled、主文件夹徽标与不可移除、浏览器 open/false、
   面包屑 `aria-current`、路径输入 value、`role=dialog` + `aria-modal`、OverlayHost 随 store 切换。

实际输出（2026-10-21，Node v24.19.0）：

```text
== dsh-multi-workspace UI smoke ==
node v24.19.0 | fragments: 10-api.js, 15-i18n.js, 20-ui-kit.js, 30-browser.js, 40-dialogs.js, 50-menu.js, 90-apply.js
[PASS] all client fragments parse and evaluate as one closure — 7 fragments
[PASS] fragments are plain script bodies (no import/export, no window access) — import/export none, window none
[PASS] required symbols are exported by the fragments — MW_DICTS, MW_CSS, Icon, Button, Modal, FolderBrowser, CreateWorkspaceDialog, ModifyWorkspaceDialog, OverlayHost, mwBrowserParentPath, mwBrowserJoin, mwBrowserSegments, mwI18nTranslator, mwUiText, mwDlgMergeFolders
[PASS] MW_DICTS.zh and MW_DICTS.en have identical key sets — 54 keys
[PASS] localized wording matches the product copy — zh/en copy verified
[PASS] every localization key used in the fragments exists in MW_DICTS — 34 keys referenced
[PASS] MW_CSS uses only mw- classes and --dsw-* theme tokens — 59 classes, 30 tokens
[PASS] browser path helpers cover Windows and POSIX roots — parent/join/segments/key
[PASS] dialog folder merge dedupes case-insensitively and keeps order — merge + basename
[PASS] CreateWorkspaceDialog renders the screenshot layout — title, name field, source box, empty prompt, disabled submit
[PASS] ModifyWorkspaceDialog prefills name and primary folder — prefilled name, fixed primary folder, Save enabled
[PASS] FolderBrowser is closed without an open flag and renders when opened — closed null, opened layout, breadcrumb, labelled path input
[PASS] OverlayHost reacts to the shared store snapshot — null snapshot, create mode, modify mode
[PASS] 90-apply and 50-menu exports are reachable from the bundle — apply + menu augmentation present

14 passed, 0 failed
```

附加静态检查：

```text
node --check src/client/15-i18n.js   exit 0
node --check src/client/20-ui-kit.js exit 0
node --check src/client/30-browser.js exit 0
node --check src/client/40-dialogs.js exit 0
node tools/build-client.mjs --check   → build-client: syntax OK (7 fragments)
```

## 6. 需要 Lead 在 90-apply / 集成时确认的点

1. **最终 bundle 需重建**：`lib/client.js` 上次构建（20:20:21）早于本次 20-ui-kit 的
   最后两处 CSS/Button 小修；请在所有片段定稿后执行一次
   `& "C:\Program Files\nodejs\node.exe" tools/build-client.mjs`，再跑 verifier 的
   `node --test test/client.test.mjs`。
2. **`mwTranslate` 的 locale 解析（90-apply.js 第 14–19 行）**：`ctx.locale.getLocale()` 返回
   `{ active, locales, revision }`，代码取的是 `snapshot.locale || snapshot.id || snapshot.lang`，
   三者都不存在 → 永远空串 → 永远回退 `MW_DICTS.zh`。建议改为优先 `snapshot.active`，
   否则界面切到 English 时本插件文案仍是中文（`MW_DICTS.en` 已完整）。组件已全部走注入的 `t`，
   Lead 修好后英文立即生效，无需改 UI 片段。
3. **actions 命名**：Lead 消息里是 `closeDialog()`，当前 90-apply 实际提供
   `cancelDialog()` / `closeDialogIfFlow(flow)`。UI 已兼容三种命名（优先 `cancelDialog`），
   两者并存不会冲突。
4. **取消语义**：创建流程中取消会经 `cancelDialog()` → `flow.onCancel()`，原生宿主自行收尾；
   修改模式 `cancelDialog()` 无 flow，直接关弹窗。
5. **失败通知**：90-apply 的 `submitCreate` 失败只 throw，未调用 `flow.onError`。UI 在收到 reject 后
   会先内联显示错误，再防御性调用一次 `flow.onError(message)`（try/catch）。若 Lead 希望
   由 90-apply 统一调用，可在其内部调用后告知，UI 侧会因 owner 幂等而重复一次 toast 的风险很低；
   若不需要，也可保留现状。
6. **props 传递**：OverlayHost 同时接受直接 props 与 `props.inject`；创建/修改对话框从 OverlayHost
   收到 `{ dialog, actions, t, logger }`；FolderBrowser 从对话框收到
   `{ open, initialPath, listDirectory, createDirectory, onClose, onConfirm, t }`。
7. **无 CSS 注入就无样式**：90-apply 已从 `MW_CSS` 注入 `<style data-plugin="dsh-multi-workspace">`，
   UI 片段不会再注入任何 style；若日志里看不到该标签，说明 apply 未执行到 style effect。

## 7. 人工验收清单（本机无浏览器自动化，无法截图/点击）

1. 深色/浅色主题各打开一次“创建工作区”：卡片背景、边框、圆角输入行、源文件夹容器、
   主文件夹徽标、按钮 hover/focus ring 是否与 DSH 其他弹窗协调。
2. 打开创建流程（Ctrl+O 或“添加工作区”）：不选文件夹时“创建”禁用；添加 1 个后“创建”可用；
   名称留空 → 创建后工作区标题 = 文件夹 basename；填名称 → 使用填写值。
3. 浏览器层：面包屑跳转、路径输入 Enter、上一级、勾选多个跨目录文件夹、双击进入、
   “显示隐藏文件夹”前后隐藏项显隐、“添加所选”回填、“取消”只关浏览层。
4. 修改流程（工作区行“...”→“修改工作区”）：标题/主文件夹预填、主文件夹无移除按钮、
   添加/移除成员、保存后重开确认；Esc 与遮罩点击关闭；Tab 焦点被限制在弹窗内，关闭后焦点回到触发按钮。
5. 创建/修改失败（如 Host 401/500）时 `role=alert` 文案出现且弹窗不关闭、可重试。
6. 用浏览器 DevTools 检查 `document.body` 下 portal 容器、`role="dialog"`、`aria-modal="true"`、
   `aria-labelledby` 指向标题，`prefers-reduced-motion: reduce` 下无弹入动画。

## 8. 已知限制与风险

1. 无真实浏览器渲染器：smoke 只覆盖结构、契约、纯函数与 CSS 静态规则，真实布局/焦点行为需人工验收。
2. 依赖 DSH 0.2.1-rc.2 的 `listDirectory` 返回结构与 `--dsw-*` token；升级 DSH 需重跑 smoke 并人工确认。
3. `listDirectory` 的 `truncated` 仅提示，不做分页/搜索（与原生 browse 的 1000 项上限一致）。
4. 文件夹浏览器用自绘面包屑而非 Host 的 `crumbs` 字段（兼容 DESIGN 4.2 声明的
   `{home, separator, entries}` 简化契约，同时对真实返回的 `path/home` 也能自适配）；若未来
   Host 面包屑语义变化（如驱动器根显示名），以本组件规则为准。
5. 主文件夹不可移除是产品约束：修改模式只能改名/增删成员文件夹；换主文件夹需新建工作区。
