# dsh-multi-workspace 验证报告（verifier · task-5）

> 维护者：verifier。本文件记录自动化验证的矩阵、命令与**实际结果**；最终全量结果在
> Lead 发出“集成完成”后补齐（见 §4）。所有命令在 `F:\AIwork\DSH custom plugin\multi-workspace`
> 下执行。

## 1. 环境

| 项 | 值 |
| --- | --- |
| DSH | 0.2.1-rc.2，profile `desktop`，`DSH_HOME=C:\Users\%USERPROFILE%\.dsh`，Web `http://127.0.0.1:64620` |
| Node | `C:\Program Files\nodejs\node.exe`（v24.19.0） |
| PowerShell | Windows PowerShell 5.1（`package-check.ps1` 的目标兼容版本，已实测） |
| 浏览器自动化 | **无**。本机无 CDP/Puppeteer 控制通道，视觉/点击只能人工验收（见 §5） |

## 2. 交付物与职责边界

| 文件 | 内容 | 写权限 |
| --- | --- | --- |
| `test/client.test.mjs` | 客户端 bundle 的自动化测试（构建 → vm 载入 → fake ctx 断言 → 组件渲染 → dispose → 纯函数/菜单行为） | verifier 独占 |
| `test/package-check.ps1` | 交付目录与 zip 的打包契约校验 | verifier 独占 |
| `dev/verify.md` | 本报告 | verifier 独占 |

不修改插件实现或其它成员文件；发现 bug 通过 `send_message` 报给 Lead（或对应 owner）。

## 3. 验证矩阵

| # | 层级 | 检查项 | 自动化 | 命令 | 期望 |
| --- | --- | --- | --- | --- | --- |
| 1 | 构建 | 7 个 `src/client/*.js` 片段齐全；`tools/build-client.mjs` 可重复生成 `lib/client.js` | 是 | `node --test test/client.test.mjs` | 片段齐全、构建 exit 0、bundle 含 7 个 `//#region` |
| 2 | Bundle 静态 | `window.__ModuleLoader__.load`、`id:'dsh-multi-workspace'`、`factory(require)`；只 require react/react-dom；无 ESM import/export | 是 | 同上 | 全部通过 |
| 3 | Bundle 样式/i18n | CSS 使用 `mw-` 前缀与 `--dsw-alias-*` token；出现 `multi-workspace` 命名空间 | 是 | 同上 | 通过 |
| 4 | 模块契约 | vm 中 stub `window.__ModuleLoader__.load` 截获 `{id,factory}`；factory 不抛错，返回 `inject`/`apply` | 是 | 同上 | `inject` = slots/workspaces/uiWorkspace/locale |
| 5 | Slot 注册 | apply 后 `sidebar.workspaces.directoryFlow`、`conversation.hero.workspace.directoryFlow` 各一个 `priority: -100`、id `multi-workspace-flow`；`shell.overlay` 有宿主注册（id `multi-workspace-overlay`）；`slots.inject` 覆盖三个槽 | 是 | 同上 | 通过 |
| 6 | Locale | `ctx.locale.register('multi-workspace', 'zh'/'en', dict)` ≥2 条且非空 | 是 | 同上 | 通过 |
| 7 | 渲染冒烟 | 每个注册组件以注入 props 渲染一次不抛错（OverlayHost、两处 Flow） | 是 | 同上 | 通过 |
| 8 | Dispose | 每个 `ctx.effect` 返回 disposer；dispose 后 `<style>` 从 `document.head` 移除、MutationObserver disconnect、二次 dispose 幂等、清理不抛错 | 是 | 同上 | 通过 |
| 9 | 纯函数 `10-api.js` | basename/dirname/pathKey、normalizeSelection 去重/去主文件夹/拒绝相对路径、store 订阅与监听异常隔离、fetch bridge GET/POST/错误折叠、record/标签解析 | 是 | 同上 | 通过 |
| 10 | i18n 一致性 `15-i18n.js` | `MW_DICTS.zh` / `.en` key 集合一致且非空 | 是 | 同上 | 通过 |
| 11 | 菜单增强 `50-menu.js` | install 返回 disposer、dispose 幂等并断开 observer；**行为**：工作区行点击 + 原生 2 项菜单出现 → 插入“修改工作区”克隆项并改写标签 → 点击克隆项先关菜单再 `onOpen(workspace)` → dispose 清理标记 | 是 | 同上 | 通过 |
| 12 | 打包目录 | 必需文件、package.json name/version/engines.dsh/dsh 清单、cordis patch、locale JSON、cmd ASCII+CRLF、说明 UTF-8、icon、`lib/client.js` node --check | 是 | `powershell -NoProfile -ExecutionPolicy Bypass -File test/package-check.ps1` | exit 0 |
| 13 | 打包 ZIP | zip 条目正斜杠/无重复/仅允许布局；必需条目；plugin/package.json；SHA256SUMS 全量一致；cmd ASCII+CRLF；客户端 `node --check`；旁路 `.sha256.txt` | 是 | 同上（zip 生成后自动发现，或 `-ZipPath`） | exit 0 |
| 14 | Host 单测 | `lib/index.js` 的 Fetch 路由/system prompt/持久化 | 是（host-bridge 交付） | `node --test test/host.test.mjs` | 全绿（见 dev/host-report.md） |
| 15 | 安装后 live | Config 条目、Slots occupant、未认证 API 非 404 | 半自动（Lead 安装后 `cordis_inspect_query` + HTTP 探测） | 见 §6 清单 | 见 §6 |
| 16 | Actions `submitCreate` | `workspaces.create` → `workspaces.rename`（名称非空/回退首文件夹 basename）→ `POST /api/multi-workspace/state {op:'save'}` → `flow.onPicked(primaryPath)`，不重复 `openWorkspace`，最后清空 dialog | 是 | `node --test test/client.test.mjs`（integration harness：拼接 7 片段、stub fetch 记录请求） | 通过 |
| 17 | Actions `submitModify` | `rename` 后 `GET state` 取主文件夹，roots 去重/去主文件夹，再 `POST save`，清空 dialog | 是 | 同上 | 通过 |
| 18 | Actions `pickDirectory` | `actions.pickDirectory()` 委托 `ctx.uiWorkspace.pickDirectory()` | 是 | 同上 | 通过 |
| 19 | `mwRequestFolderPick` 回退 | 原生返回路径 → `picked`；返回 null/空 → `cancelled`（不报错）；异步 reject / 同步 throw / 无 pickDirectory → `browse`（打开 FolderBrowser） | 是 | 同上 | 通过 |
| 20 | 弹窗“添加”接线 | `CreateWorkspaceDialog` 的 `onAdd` 调原生 picker；取消不抛错、picker 失败回退浏览器、错误不冒泡到 UI | 是 | 同上 | 通过 |
| 21 | 视觉资源（极光描边） | bundle 中出现 `conic-gradient` / `border-image` / `--mw-aurora-*`，以及 `prefers-reduced-motion`、`forced-colors` 兜底 | 是 | `node --test test/client.test.mjs` | 通过 |
| 22 | 源文件夹行（拖拽/主文件夹可删） | 渲染 `MwSourceFolders` 断言：创建模式主文件夹有“×”，修改模式主文件夹锁定且无“×”，≥2 项才 `draggable`，dragstart 写入 `text/plain` 索引、dragover preventDefault、单文件夹不可拖；徽标 title 分别为 `source.primaryHint` / `source.removePrimaryHint` | 是 | 同上 | 通过 |
| 23 | i18n 新增键 | `source.primaryHint`、`action.dragFolder`、`source.removePrimaryHint`、`action.removeFolder.aria` 在 zh/en 均存在且非空 | 是 | 同上 | 通过 |

补充说明：

- 测试顺序固定：先在测试进程启动时运行 `node tools/build-client.mjs`（7 个片段齐全时才执行，避免用半成品覆盖 `lib/client.js`），再 `vm` 载入 bundle。
- Bundle 用 `vm.createContext` + `window === sandbox` 还原 DSH 浏览器模块系统；`require('react')` 为可运行 stub（`createElement` 返回 vnode、hooks 可调用、`useSyncExternalStore` 读取 getSnapshot），`require('react-dom')` 提供 `createPortal`。
- `lib/client.js` 是 Lead 的构建产物；测试只读取，不手改。

## 4. 实际执行结果

### 4.1 阶段性结果（集成收尾中，2026-10-21 20:2x）

命令：

```powershell
& "C:\Program Files\nodejs\node.exe" --test test/client.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File test\package-check.ps1
```

| 命令 | 结果 |
| --- | --- |
| `node --test test/client.test.mjs` | **16 pass / 0 fail / 0 skip**（构建、bundle、slots、locale、渲染、dispose、API 纯函数、i18n、菜单行为） |
| `package-check.ps1`（目录模式） | **PACKAGE CHECK PASSED: 43 checks**；`[zip] SKIP`（zip 尚未打包，等 packager 运行） |
| `package-check.ps1 -ZipPath dsh-plugin-hub-...zip`（对照样例，验证 zip 分支可用） | zip 分支正常执行 108 项检查，0 异常；差异项均为对照包与本包的预期不同（name/icon/locale/说明） |

集成边界（当时已具备）：`10-api.js`、`15-i18n.js`、`20-ui-kit.js`、`30-browser.js`、`40-dialogs.js`、`50-menu.js`、`90-apply.js`、`lib/index.js`、`lib/client.js`（由构建脚本生成）。

### 4.2 集成完成阶段结果（UI 迭代前，2026-10-21 20:35 左右）

> 本节是 UI 迭代（极光描边/拖拽重排）**之前**的阶段结果，最终数字以 §4.3 为准。

Lead 在集成完成后更新了 `90-apply.js`（locale 读取 `snapshot.active`；`actions` 新增 `pickDirectory`）与
`40-dialogs.js`（“添加”优先原生 `pickDirectory`，失败回退 `FolderBrowser`，新增 `picking` 状态）。
verifier 重新构建并跑全量：

```powershell
& "C:\Program Files\nodejs\node.exe" --test test/host.test.mjs test/client.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File test\package-check.ps1
```

| 命令 | 结果 |
| --- | --- |
| `node --test test/host.test.mjs test/client.test.mjs` | **39 pass / 0 fail / 0 skip**（host 18 + client 21） |
| `node --test test/client.test.mjs`（单独） | **21 pass / 0 fail**（原 16 项 + 新增 5 项 actions 层） |
| `package-check.ps1`（目录模式） | **PACKAGE CHECK PASSED: 43 checks**；`[zip] SKIP`（zip 仍未打包，见 §8） |
| `node --check lib/client.js`（由 package-check 执行） | 通过（bundle 由 7 片段重建，含全部 `//#region src/client/`） |

安装后 live 检查（verifier 实际执行，只读）：

| 检查 | 结果 |
| --- | --- |
| Host Config：`cordis_inspect_query host/Config.listConfigs name=dsh-multi-workspace` | ✅ 有条目 `include:dsh-multi-workspace`，patchId/name 均 `dsh-multi-workspace`，status `absent`（本插件按设计不导出 Config schema，`absent` 即“无可配置项”，非加载失败） |
| 未认证 `GET /api/multi-workspace/state` | ✅ **401**（exact Fetch 路由已注册且鉴权生效，不是 404） |
| Client Slots：`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` / `shell.overlay` | ⚠️ verifier 会话的 Client Inspect 查询超时（`Slots.listSubTree` 10s timeout，提示需打开/重连 Harness 页面）。**未由 verifier 复验**；Lead 已在 live 环境确认三个槽的 occupant（id `multi-workspace-flow` priority `-100` active、`multi-workspace-overlay` active）。 |
| `GET /plugins/dsh-multi-workspace/client.js` | ⚠️ **404**。经核对本机 DSH 源码（`@deepseek-ai/dsh-client-modules`）：0.2.1-rc.2 的 client bundle 只通过 **combo URL**（`/plugins/??<ids>/client.js&rev=<12hex>`，或带 `?rev=` 的包内 chunk）提供，combo URL 由启动期模块图生成；**不存在** DESIGN §6 假设的裸 `/plugins/<id>/client.js` 路由。故 404 是该版本路由的正常表现，不能作为“bundle 未加载”的证据；判定 bundle 是否加载应以 Slots occupant 为准（Lead 已验证）。 |

结论：自动化全绿；host 侧已由 verifier 现场确认；客户端 live 槽位由 Lead 现场确认（verifier 会话无法连到页面）。
未发现插件实现 bug；发现 1 处 DESIGN 文档与 0.2.1-rc.2 实际路由不符（见 §8）。

### 4.3 UI 迭代（极光描边 / 主文件夹可删 / 拖拽重排）与正式 ZIP —— 最终结果

后续 UI 迭代（`20-ui-kit.js` 矩形极光渐变描边、`40-dialogs.js` 创建对话框主文件夹可删除 + HTML5 拖拽重排、
`15-i18n.js` 新增 `source.primaryHint` / `action.dragFolder` 等）完成后，重新构建并跑全量；正式 ZIP 已生成。
用户第二轮反馈后去掉了“四角加粗”，保留矩形极光渐变描边（与侧边栏极光同色、跟随深浅色主题），
`delivery/使用说明.txt` 外观说明同步更新；以下为**重新打包后的最终交付物**数字。

```powershell
# 重建由 client.test.mjs 启动时自动执行：node tools/build-client.mjs
& "C:\Program Files\nodejs\node.exe" --test test/host.test.mjs test/client.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File test\package-check.ps1 -ZipPath "F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip"
```

| 检查 | 结果 |
| --- | --- |
| `node --test test/host.test.mjs test/client.test.mjs` | ✅ **41 pass / 0 fail / 0 skip**（host 18 + client 23） |
| `node --test test/client.test.mjs`（单独） | ✅ **23 pass / 0 fail**（原 21 + 新增 2 项源文件夹行 UI 行为；i18n 与 CSS 断言同步扩展） |
| `lib/client.js` | 117,445 B，SHA256 `ce36ee648fa9dd1f41aff5ab69eb6ed26f6762c65190d6629bb1c8f146a8f10a`（7 片段重建；去四角加粗后的矩形极光描边 + 可删主文件夹 + 拖拽重排；测试重建后哈希可复现） |
| `package-check.ps1 -ZipPath <正式 zip>`（目录 + ZIP 全量） | ✅ **PACKAGE CHECK PASSED: 126 checks，0 fail**（目录 43 项 + ZIP 83 项） |
| 正式 ZIP（重新打包） | `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`，**55,379 B**，SHA256 `834af46b45a28f168e6b92f74ca1828a7a236e724d74605cf820c25415904614`（与 Lead/packager 提供值、旁路 `.sha256.txt` 三者一致） |
| ZIP 内 `plugin/lib/client.js` | SHA256 `ce36ee64…8f10a`、117,445 B，与工作树 `lib/client.js` **完全一致**（证明 zip 打包的就是含最新 UI 的 bundle）；`lib/index.js`、`package.json`、`cordis.patch.yml`、`使用说明.txt` 亦逐一与工作树一致 |

ZIP 分支实际覆盖：条目全正斜杠、无重复、无布局外条目；必需条目（说明/3 个 cmd/tools/portable.ps1/
SHA256SUMS/plugin 清单+lib+locale+icon）；`plugin/package.json` 的 name/version/engines.dsh/dsh 清单；
`SHA256SUMS.txt` 覆盖除自身外**每一个**条目且逐字节哈希匹配；3 个 CMD 为 ASCII+CRLF 且调用 `portable.ps1`；
说明 UTF-8 且指名插件；`lib/client.js` 解包后 `node --check` 通过；旁路 `.sha256.txt` 哈希/文件名正确。

> 注：Lead 说明当前 live 安装是 `link:` 到 `multi-workspace` 源码目录，其 `lib/client.js` 与 zip 内
> 同名文件哈希一致（`ce36ee64…`），即 live 版本 = 交付 zip 版本。

## 5. 安装后可用 `cordis_inspect_query` 做的检查清单

先 `cordis_inspect_list` 取得当前 provider（host 与 client 各一），再按 provider 的只读方法查询：

| # | 检查 | 查询 | 期望 |
| --- | --- | --- | --- |
| 1 | Host 插件条目 | Host provider 的 Config / plugin 列表方法（见 Inspect manifest 名称，如 `listConfigs`） | 出现 `dsh-multi-workspace` 且无加载错误 |
| 2 | 客户端 Slots（sidebar） | Client provider 的 slot entries 方法，key `sidebar.workspaces.directoryFlow` | 存在 occupant：id `multi-workspace-flow`、priority `-100`、component 为函数 |
| 3 | 客户端 Slots（conversation hero） | 同上，key `conversation.hero.workspace.directoryFlow` | 同上 |
| 4 | 客户端 Slots（overlay） | 同上，key `shell.overlay` | 存在 occupant：id `multi-workspace-overlay`、order 60 |
| 5 | Locale | Client provider 的 locale 方法（若暴露） | `multi-workspace` 命名空间有 `zh`/`en` 字典 |
| 6 | 客户端 bundle 已加载 | **不要**用裸 `GET /plugins/dsh-multi-workspace/client.js` 判定（本机 0.2.1-rc.2 走 combo URL，该路径必然 404）。以第 2/3/4 项 Slots occupant 为准；浏览器 DevTools Network 可见 `/plugins/??…client.js&rev=…` 200 | Slots 有本插件 occupant |
| 7 | Host Fetch 路由已注册 | `GET /api/multi-workspace/state`（无凭据探测） | **401/403**（已注册且鉴权生效），不是 404 |
| 8 | Fetch 正常路径 | 已登录浏览器会话内 `GET /api/multi-workspace/state` | `{ ok:true, value:{ version:1, workspaces:{...} } }` |
| 9 | 服务依赖 | Client inspector 可见 `slots`/`workspaces`/`uiWorkspace`/`locale` 服务 | 与 `inject` 声明一致 |
| 10 | Config 语义 | `host/Config.listConfigs name=dsh-multi-workspace` | 条目存在；`status: absent` 是“无 Config schema”，符合 DESIGN“不需要 Config” |

> 注：Inspect 方法名以 `cordis_inspect_list` 返回的 manifest 为准，不要凭记忆调用不存在的
> 方法；本清单只定义“要查什么”，具体 provider/method 由 manifest 决定。
> Client Inspect 查询需要 Harness 页面处于打开/已连接状态；从无页面的 agent 会话调用会
> `timed out after 10000ms`（verifier 实测），此时请改用后台 Lead 或带页面的会话查询。

## 7. 已知限制与风险

1. 客户端测试用 vm + React stub，不是真实 React 渲染器：hooks 语义（依赖数组、并发渲染）与浏览器 CSS 不覆盖；用真实 DSH 手工验收兜底。
2. `50-menu.js` 依赖 DSH 0.2.1-rc.2 的 DOM 结构（`[data-row-key^="workspace:"]`、`[role="menu"]`、2 个 `menuitem`）；升级 DSH 需重跑 `node --test test/client.test.mjs` 并人工确认。
3. `package-check.ps1` 的 ZIP 分支要求 packager 已生成 `dsh-multi-workspace-1.0.0-win-x64.zip` 与旁路 `.sha256.txt`；打包前该分支显示 `SKIP`（不是失败）。
4. `lib/client.js` 必须在所有 `src/client/*.js` 定稿后重建；若 bundle 过期，测试的构建步骤会自动重建（7 片段齐全时），但 Lead 打包前应确认最终产物。
5. ZIP 分支已在正式交付物上验证通过：`package-check.ps1 -ZipPath dsh-multi-workspace-1.0.0-win-x64.zip`
   → 126 checks / 0 fail（ZIP 83 项）。该脚本仍要求 zip 与旁路 `.sha256.txt` 同时存在，打包前运行会显示 `SKIP`。

## 8. 发现的问题 / 差异（供 Lead 处理）

1. **DESIGN.md §6 的客户端 bundle 检查项已过时（文档差异，非实现 bug）**：文档写
   “`GET /plugins/dsh-multi-workspace/client.js` 返回 200”，但本机 DSH 0.2.1-rc.2 的
   `@deepseek-ai/dsh-client-modules` 只提供 rev 化的 combo URL
   （`/plugins/??<id>/client.js&rev=<12hex>`）与包内 chunk，裸路径按设计返回 404。
   建议把该验收项改成“Client Slots occupant 存在”（或 DevTools 观察 combo URL 200），避免后续误判。
2. ~~**ZIP 交付物尚未生成**~~ —— **已解决（重新打包后的最终版）**：正式 ZIP
   `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`（**55,379 B**，
   SHA256 `834af46b45a28f168e6b92f74ca1828a7a236e724d74605cf820c25415904614`）已生成并通过
   `package-check.ps1 -ZipPath` 全量校验：**126 checks / 0 fail**；ZIP 内 `plugin/lib/client.js`
   （117,445 B，`ce36ee64…`）与工作树一致，即交付物包含去四角加粗后的最新 UI。
3. 未发现插件实现 bug：**41 项单测全绿（host 18 + client 23）**，host 路由/持久化/prompt 与 client
   slot/dispose/actions/源文件夹行（拖拽重排、主文件夹可删/锁定）行为均符合 DESIGN 契约。
   `90-apply.js` 的 `snapshot.active` 与 `pickDirectory`、`40-dialogs.js` 的原生 picker 回退、
   `20-ui-kit.js` 极光描边资源、`15-i18n.js` 新增键均已被新增用例覆盖。
