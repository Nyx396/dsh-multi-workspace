# dsh-multi-workspace 设计与协作说明（Lead 维护，所有成员必读）

## 1. 目标与语义

为 DeepSeek Harness Desktop 0.2.1-rc.2 提供“多文件夹工作区”：

- 创建工作区时可一次选择多个文件夹；第一个为主文件夹（= DSH 原生工作区目录，会话 cwd / 沙箱根），其余为成员文件夹。
- 已有工作区可通过工作区行“...”菜单新增的“修改工作区”入口，改名、添加/移除成员文件夹。
- 工作区下所有会话（含子任务）都能访问全部成员文件夹：
  - 读：DSH 读不受沙箱限制，直接可用。
  - 写/改：DSH 0.2.1-rc.2 沙箱只有单一可写根（会话 header.cwd），跨文件夹写入由 DSH 原生 `sandbox_permissions` 提权审批（用户逐次批准）。**不要**自动改会话 sandbox mode、不要改 `sandboxPolicy.resolve`。
- Host 侧通过 system prompt 段落把成员文件夹绝对路径告诉模型（否则模型不知道这些文件夹存在）。

不做的：不改 app.asar；不注册新 session event；不改工作区注册表；不做文件系统符号链接映射；不自动提升 danger-full-access。

## 2. 目录与文件所有权（互不越界）

```
F:\AIwork\DSH custom plugin\multi-workspace\
  DESIGN.md                     Lead
  package.json                  Lead（清单/打包入口；packager 只读）
  cordis.patch.yml              Lead
  icon.svg                      Lead
  LICENSE                       Lead
  locale/en.json, locale/zh.json Lead（插件管理器显示元数据）
  lib/index.js                  host-bridge（host 插件，构建产物=源码，纯 node 内置模块）
  lib/client.js                 tools/build-client.mjs 生成（勿手改）
  src/client/10-api.js          Lead：Host HTTP API 客户端 + 内存 store + 纯工具函数
  src/client/15-i18n.js         client-ui：locale 命名空间、字典、t
  src/client/20-ui-kit.js       client-ui：图标、按钮、Modal 外壳、CSS 字符串
  src/client/30-browser.js      client-ui：文件夹浏览组件（多选）
  src/client/40-dialogs.js      client-ui：创建工作区 / 修改工作区两个对话框
  src/client/50-menu.js         menu-inject：工作区“...”菜单 DOM 增强
  src/client/90-apply.js        Lead：inject/apply、slot 注册、overlay 宿主、组装
  tools/build-client.mjs        Lead
  tools/package.ps1             packager（从口袋插件复制改名为 dsh-multi-workspace）
  tools/portable.ps1            packager（同上）
  tools/test-portable.ps1       packager
  delivery/使用说明.txt          packager
  delivery/安装.cmd 卸载.cmd 检查环境.cmd  packager（ASCII，CRLF）
  test/host.test.mjs            host-bridge
  test/client.test.mjs          verifier
  test/package-check.ps1        verifier
  README.md                     Lead
  dev/                          研究草稿，不参与打包
```

规则：只写自己负责的文件；需要共享改动时给 Lead 发消息。所有中文文本集中在 15-i18n.js / locale/*.json。

## 3. Host 插件（lib/index.js）

- 形态：`export const name='dsh-multi-workspace'; export const inject=['connection','systemPrompt']; export function apply(ctx) {...}`
- 仅 `node:` 内置模块；不要 import `@deepseek-ai/*`（profile 插件无法可靠解析）。
- 数据文件：`<DSH_HOME>/multi-workspace/state.json`，DSH_HOME=`process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh')`。启动读取，写入用原子写（临时文件+rename）。
- snake 结构：
```json
{ "version": 1,
  "workspaces": {
    "<workspaceId>": {
      "id": "<workspaceId>",
      "path": "D:\\主文件夹",           // 规范化后的主文件夹绝对路径
      "roots": ["E:\\副文件夹"],        // 成员文件夹（不含主文件夹），规范化绝对路径，保持添加顺序
      "updatedAt": "2026-10-21T12:00:00.000Z"
    }
  }
}
```
- 精确 Fetch 路由（已确认 0.2.1-rc.2 API）：`ctx.connection.fetch.register({ path:'/api/multi-workspace/state', methods:['GET','POST'], requestBody:'buffered', fetch(request){...} })`。返回 `Response`。该注册自动走浏览器 cookie 认证（非 owner 会 403/401）。
- `GET`：返回 `{ ok:true, value: <state> }`，同时用 `ctx.workspaceRegistry.list()` 清理已删除工作区记录（若 service 可用；用 `ctx.get('workspaceRegistry')` 可选获取）。
- `POST` body 操作（JSON）：
  - `{ "op":"save", "id":"<workspaceId>", "name":"显示名（可空）", "path":"<主文件夹>", "roots":["..."] }` → 校验 path 非空绝对路径；roots 去重、去掉与主文件夹相同的项；写盘；返回 `{ ok:true, value: <record> }`。`name` 只记录不落盘（改名由 client 调 workspaces.rename）。
  - `{ "op":"remove", "id":"<workspaceId>" }` → 删除记录。
  - 其它 → 400 `{ ok:false, error:{ code, message } }`。
- 路径比较：Windows 下大小写不敏感；记录时用 `fs.realpath` 成功则用之，失败保留原样；同时内存里维护 `lower-case(path) -> id` 索引。
- systemPrompt 段落：`ctx.systemPrompt.section({ name:'multi-workspace:roots', order: 8000, interpolate:false, text: (context) => ... })`。
  - 取 `context.agent?.session?.header?.cwd`，大小写不敏感匹配记录；未命中返回 `''`（空段会被丢弃）。
  - 文案（英文，DSH 系统提示是英文；可含路径原样）：
    ```
    This Session belongs to a multi-folder Workspace. Member folders (absolute paths):
    - <主文件夹> (primary folder of this Session)
    - <成员文件夹>...
    You may read and search files in every member folder with absolute paths. The Session workspace root is the primary folder; writing or editing outside it is allowed only through the normal sandbox escalation (`sandbox_permissions`), which asks the user for approval. Do not treat the other folders as missing or outside the project.
    ```
  - 空/无记录时不输出；不得抛错（整段包 try/catch）。
- 卸载/重装要幂等：注册全部走 `ctx.effect` 并在 disposer 中保存/清理。
- Config：不需要（不要写 `export const Config`）。

## 4. Client 插件

### 4.1 构建与模块格式

`tools/build-client.mjs` 读取 `src/client/*.js`（按文件名排序）并生成 `lib/client.js`：

```js
window.__ModuleLoader__.load({
  id: 'dsh-multi-workspace',
  factory(require) {
    'use strict';
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    // ... src/client/*.js 拼接内容（共享同一闭包作用域）
    return { inject: ['slots', 'workspaces', 'uiWorkspace', 'locale'], apply };
  },
});
```

- src 文件是“共享闭包里的普通脚本片段”：不要 `import/export`、不要 `window` 顶层副作用；只定义函数/常量。
- 只允许 `require('react')`、`require('react-dom')`。不要 require 其他 DSH client 包（避免基线漂移）。
- 目标浏览器：Chromium（DSH Web UI）。

### 4.2 客户端可用服务（通过 ctx 或注册 inject 面）

- `ctx.slots`：`inject(key, cb)` / `register(options, component)` / `entriesOfSlot(key)`。
- `ctx.workspaces`：`create({path})`→WorkspaceView、`rename(id,title)`、`delete(id)`、`list.getSnapshot()`→`{items:[{workspaceId,title,path,sessionIds,updatedAt,...}]}`。
- `ctx.uiWorkspace`：`listDirectory(path, signal)`→`{home, separator, entries:[{name,path,hidden}], truncated?}`；`createDirectory(path,name)`；`openWorkspace(id)`。
- `ctx.locale`：`register(ns, locale, dict)`、`bind(ns)`；`namespace` 用 `multi-workspace`。
- Host HTTP：同源 `fetch('/api/multi-workspace/state', {credentials:'same-origin', headers:{'content-type':'application/json'}})`。GET 返回 `{ok,value}`；POST body 同 Host 契约。

### 4.3 Slot 注册

- `sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow`：single 槽；注册优先级 `priority: -100`（原生 picker 是 0；single 槽“priority 最低者渲染”，因此阴影原生选择器）。组件接收 owner props：`{open, busy, onPicked(path), onCancel(), onError(message)}`。
  - 用 `ctx.slots.inject(slot, () => ctx.slots.register({name:slot, id:'multi-workspace-flow', priority:-100, inject: () => ({...})}, MultiWorkspaceFlow), )`。
  - MultiWorkspaceFlow 在 `open` 变为 true 时打开“创建/修改”入口（默认创建模式），关闭时调用 `onCancel()`；创建成功后调用 `onPicked(primaryPath)` 让原生宿主收养并打开工作区/会话；失败调用 `onError(msg)`。
- `shell.overlay`（list，root）：常驻宿主组件 `h(OverlayHost, ...)`，读取内存 store 渲染创建/修改弹窗（portal + 自绘遮罩）。不要用 document.body 手写 DOM，除了菜单增强（见 4.5）。
- `ctx.effect` 持有 style 注入与 disposer。
- 客户端 store：简单 `createStore()`（getSnapshot/subscribe/setState），用 `React.useSyncExternalStore` 订阅。`90-apply.js` 建 store，注入给 overlay 和各对话框。

### 4.4 UI 规格（独立 DSH 蓝青色工作台）

采用独立 DSH 视觉：简洁工作台、蓝青色点缀、清晰的信息分区。创建/修改对话框将工作区信息与文件夹区域分开展示；文件夹区域显示目录数量，目录行以名称与完整路径分两行展示，第一行主文件夹附徽标。目录浏览器延续相同视觉，支持深浅主题与窄窗。

本插件文案保持 DSH 术语“工作区”：标题“创建工作区”/“修改工作区”；输入占位“工作区名称”；“工作区信息”和文件夹小节明确分组；底部“取消”/“创建”，修改模式底部“取消”/“保存”。添加入口、空态和目录数量使用中英文字典，避免业务文案直接写在组件中。

行为：
- 至少 1 个文件夹才能提交；未填名称时用第一个文件夹的名字（`basename`）。
- 已选列表：每行文件夹图标 + 文件夹名称/完整路径两行 + “主文件夹”徽标（第一行）+ 移除按钮；创建时任意一行均可移除或拖动，修改时主文件夹锁定。
- “添加”打开层叠的文件夹浏览弹窗：面包屑 + 路径输入 + 返回上级 + 目录列表（文件夹图标）；支持勾选多个当前目录下的子文件夹后“添加所选”；双击文件夹进入；隐藏项默认隐藏，底部“显示隐藏文件夹”开关。
- 创建流程（90-apply 注入的 `onCreate(record)` 负责）：`create` → `rename`（名称非空时）→ POST save → 调 `owner.onPicked(primaryPath)`。若 owner 为 null（从菜单“修改工作区”进入）则用 `ctx.uiWorkspace.openWorkspace(id)`。
- 创建对话框的文件夹列表：任意一行（含第一项/主文件夹）都可点“×”删除；删除主文件夹后下一项自动成为主文件夹。列表支持拖动重排，第一项即主文件夹。
- 修改对话框：主文件夹对应 DSH 工作区目录（会话 cwd，不可变更），保持锁定；成员文件夹可移除。
- “添加文件夹”优先调用 `ctx.uiWorkspace.pickDirectory()`（Desktop 组合原生 OS 选择器，一次一个文件夹，可反复点“添加”）；仅当 pick 不可用/抛错（Web browse 组合）时回退到内置 FolderBrowser（`listDirectory`/`createDirectory`）。
- 外观：蓝青色强调、细边框和有层次的区域背景。输入、目录列表、操作按钮采用一致的圆角与间距，窄窗下调整区域布局和按钮排列，长路径可完整查看。
- 样式：CSS 前缀 `mw-`，使用插件语义变量组织独立蓝青调色板并衔接 `--dsw-alias-*` 宿主主题 token；支持 light/dark、reduced-motion、forced-colors；Esc 关闭、键盘焦点清晰；保留 `aria-modal`、`role="dialog"`。

### 4.5 工作区行“...”菜单增强（50-menu.js）

原生菜单无法通过 slot 扩展（已确认源码：ProjectRowItem 内部 items=[rename,delete]）。采用 **DOM 增强**：

- 安装一个 `MutationObserver`（document.body, childList/subtree）监听 `[role="menu"]` 出现；同时用 document 捕获阶段 click 记录“最近一次点击的按钮是否位于工作区行”（`event.target.closest('[data-row-key]')` 的 key 以 `workspace:` 开头）。
- 当新出现的 menu 满足：包含 2 个 `button[role="menuitem"]`、且其文本含重命名/删除语义或数量为 2，且最近点击属于工作区行 → 克隆其中一个菜单项按钮，改为“修改工作区”，插到第一项之后（或克隆重命名项后改文本）。克隆按钮点击：
  1. 用 `Escape` KeyboardEvent 派发让原生菜单关闭；2. 调 `openModify(workspace)`。
- 识别 workspace：从最近点击按钮的 `aria-label`（`actions.workspace.aria`，含工作区显示名）中取出名称；用 `ctx.workspaces.list.getSnapshot().items` 按 `title` 匹配（工作区标题唯一），匹配不到时用工作区行内的 `data-row-key` 编号兜底失败则不增强。
- 增强必须幂等、可 dispose（断开 observer、移除监听、移除克隆节点）；结构不符合预期时静默跳过（不能抛错、不能影响原生菜单）。
- 不要改原生项文本、不要改 React 状态、不要在菜单外 append 常驻节点。

## 5. 打包（与口袋插件同构）

- 包名 `dsh-multi-workspace`，版本 `1.0.0`；engines.dsh `0.2.1-rc.2`。
- zip 名 `dsh-multi-workspace-1.0.0-win-x64.zip`，输出到 `F:\AIwork\DSH custom plugin`（与口袋 zip 同级）；同名存在则报错不覆盖。
- zip 结构：`使用说明.txt`、`安装.cmd`、`卸载.cmd`、`检查环境.cmd`、`tools/portable.ps1`、`plugin/{package.json,cordis.patch.yml,lib/**,locale/**,icon.svg,README.md,LICENSE}`、`SHA256SUMS.txt`，zip 旁 `.sha256.txt`。
- portable.ps1 以口袋版为基础，只改插件名/必需文件校验/README 文案；保持离线安装（复制到 `<DSH_HOME>/custom-plugins/dsh-multi-workspace/<profile>` + profile `link:` 注册 + bundles 追加）、备份、失败回滚、运行中拒绝等行为。
- 使用说明.txt 必须写清：功能、安装、卸载、如何使用（Ctrl+O/添加工作区 → 多选；工作区“...”→修改工作区）、权限与审批行为、已知限制、备份/回滚位置、自定义 DSH_HOME/profile 命令。

## 6. 验证

- 本机 DSH：profile `desktop`，`DSH_HOME=C:\Users\曹智皓\.dsh`，Web URL http://127.0.0.1:64620，版本 0.2.1-rc.2。
- 安装：`plugin_manager install_bundle` target = 本目录绝对路径（Lead 执行）。
- 安装后检查：
  - `cordis_inspect_query` Config `listConfigs` name `dsh-multi-workspace` 有条目；
  - 客户端 Slots：`sidebar.workspaces.directoryFlow`、`conversation.hero.workspace.directoryFlow`、`shell.overlay` 出现本插件 occupant；
  - 未认证 `GET /api/multi-workspace/state` 返回 401（注册成功）而不是 404；
  - 客户端 bundle 不能通过裸路径 `/plugins/dsh-multi-workspace/client.js` 验证（0.2.1-rc.2 只提供 rev 化 combo URL）；以 Slots occupant / 页面控制台无加载错误为准；
  - 单元测试全部通过。
- 交付前核查创建空态、多文件夹列表、修改主文件夹锁定、目录浏览器、深浅主题、窄窗和键盘焦点；单元测试与结构 smoke 不替代实际布局检查。
- `test/package-check.ps1` 从源码 `package.json` 读取期望版本，验证目录和 ZIP 内清单一致；打包前构建客户端，打包后验证包内逐文件校验与整包旁路校验。

## 7. 已知限制（写入使用说明）

- 沙箱仍是单可写根；跨文件夹写/改需要 DSH 提权审批（逐次）。
- `@file` 补全、右侧文件树、变更面板仍只看主文件夹；模型可用绝对路径工具访问其他文件夹。
- 依赖 DSH 0.2.1-rc.2 的 slot 名、CSS 类与 DOM 结构；升级 DSH 可能需要重新适配。
- 工作区改名不会改变文件夹；删除工作区不会删除任何文件夹或文件（成员记录随工作区删除清理）。
