# 交付与打包报告（packager / task-4）

日期：2026-10-21
插件：dsh-multi-workspace（版本取 `multi-workspace/package.json`，当前 1.0.0）
参照源：`D:\DeepSeek Harness\deployment\plugins\dsh-plugin-hub\`（只读，未修改）

## 1. 交付文件清单

| 文件 | 说明 | 编码/格式 |
| --- | --- | --- |
| `multi-workspace/tools/portable.ps1` | 离线安装器（Check/Install/Uninstall） | 纯 ASCII，LF |
| `multi-workspace/tools/package.ps1` | 打 zip、SHA256、结构校验 | 纯 ASCII（中文文件名用码点构造），LF |
| `multi-workspace/tools/test-portable.ps1` | 隔离夹具安装器自测 | 纯 ASCII，LF |
| `multi-workspace/delivery/安装.cmd` | 双击安装（调用 `tools\portable.ps1 -Mode Install`） | ASCII + CRLF，284 字节 |
| `multi-workspace/delivery/卸载.cmd` | 双击卸载（`-Mode Uninstall`） | ASCII + CRLF，281 字节 |
| `multi-workspace/delivery/检查环境.cmd` | 双击检查（`-Mode Check`） | ASCII + CRLF，206 字节 |
| `multi-workspace/delivery/使用说明.txt` | 中文使用说明（全部必需章节） | UTF-8 无 BOM，CRLF，8160 字节 |

未改动多文件夹插件的实现文件（`lib/`、`src/`、`test/`、`package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`、`DESIGN.md`）。

## 2. portable.ps1 行为（保留口袋插件全部安全语义）

- 参数：`-Mode Check|Install|Uninstall`、`-DshPath`、`-DshHome`、`-Profile`（默认 desktop）、`-PluginSource`、`-Library`（供其它脚本 dot-source）。
- 安装目标：`<DSH_HOME>\custom-plugins\dsh-multi-workspace\<profile>`；DSH_HOME 默认 `%USERPROFILE%\.dsh`。
- 离线安装：`plugin add link:<安装目录> --offline --ignore-scripts`，并注入 `npm_config_offline/ignore_scripts`；不接受静默联网。
- 备份：`<DSH_HOME>\backups\dsh-multi-workspace\<时间戳>-<随机>`，含 profile 元数据（package.json、pnpm-lock.yaml、pnpm-workspace.yaml、cordis.patch.yml、cordis.yml、compatibility.json）、原插件目录/链接副本、transaction.json。
- 失败自动回滚（恢复元数据字节、原插件、node_modules 链接）；回滚也失败时输出备份路径。
- 有 DSH Desktop 进程时 Install/Uninstall 直接拒绝（Check 只报告数量），不结束进程。
- 只改本插件相关项：安装前后比对“去掉本插件后的 profile 状态”，其他插件/设置被改动即回滚；数组顺序敏感、对象键顺序不敏感。
- 必需文件校验：`package.json`、`cordis.patch.yml`、`lib\index.js`、`lib\client.js`；包名必须为 `dsh-multi-workspace`；禁止外部运行时依赖；源目录/安装目录互不包含；拒绝重解析点（链接）与路径穿越。

## 3. package.ps1 行为

- 默认输出目录 `F:\AIwork\DSH custom plugin`；zip 名 `dsh-multi-workspace-<version>-win-x64.zip`（当前应为 `dsh-multi-workspace-1.0.0-win-x64.zip`）。
- 同名 zip 已存在 → 报错退出，不覆盖（先 `Test-Path`，再以 `FileMode.CreateNew` 打开）。
- 固定 zip 结构：`使用说明.txt`、`安装.cmd`、`卸载.cmd`、`检查环境.cmd`、`tools/portable.ps1`、`plugin/{package.json,cordis.patch.yml,lib/**,locale/**,icon.svg,README.md,LICENSE}`、`SHA256SUMS.txt`。
- 插件白名单只有 `package.json`、`cordis.patch.yml`、`lib`、`locale`、`icon.svg`、`README.md`、`LICENSE`；`package.json.files` 允许 `locale/*.json` 这类通配（按首段校验），但不在白名单内的声明会报错；`dev/`、`src/`、`test/`、构建脚本不会进包。
- delivery 目录必须恰好 4 个文件（3 个 `.cmd` + 1 个 `.txt`），多余文件报错。
- `.cmd` 校验：内容非 ASCII 直接报错；统一转 CRLF 后再次校验 ASCII 与“每个 LF 前有 CR”。
- `SHA256SUMS.txt`：包内逐文件 `<sha256>  <相对路径>`（正斜杠、UTF-8 无 BOM、LF），14 项；zip 旁生成 `<zip>.sha256.txt`（整包 SHA256）。
- zip 条目全部用正斜杠，并与暂存文件集合完全一致（缺项/多项都报错）；`使用说明.txt` 按 UTF-8 原样复制。
- 暂存目录在 `<PackageRoot>\tools\out\release-<guid>`，结束后删除。
- 编码注意：脚本自身为纯 ASCII，因此 Windows PowerShell 5.1 以 ANSI 读取也不会损坏中文文件名（中文名用 `[char]0x....` 构造）。

## 4. 验证命令与结果

### 4.1 安装器自测（真实执行的命令）

```
cd F:\AIwork\DSH custom plugin\multi-workspace
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\test-portable.ps1
```

结果：**通过**，`Portable installer: 10 meaningful fixture checks passed. No real DSH profile was changed.`（退出码 0）

| # | 检查 |
| --- | --- |
| 1 | Check 只读：不改 profile、不建 backups/custom-plugins |
| 2 | 离线安装（中文+空格路径）成功，且恢复进程环境变量（DSH_HOME/npm_config_*） |
| 3 | 失败升级回滚：profile 字节与 pnpm-lock 字节精确恢复，旧插件/链接恢复 |
| 4 | 其他 profile 设置被意外改动 → 拒绝并回滚 |
| 5 | 重复安装幂等：只保留一个 bundle，版本可升级 |
| 6 | 对象键顺序重写被接受（非语义差异） |
| 7 | 数组顺序变化被识别为语义差异并回滚 |
| 8 | 卸载保留安装后新增的其他插件设置，并删除稳定目录 |
| 9 | profile 路径穿越（`..\escape`）与跨根删除被拒绝 |
| 10 | DSH 运行中拒绝且不修改元数据 |

夹具在 `tools/test-work/<guid>`，成功时自动清理；未接触真实 `C:\Users\曹智皓\.dsh`。

### 4.2 package.ps1 隔离夹具验证

因为仓库此刻还在集成（`lib/client.js` 未生成），在系统临时目录复制 `tools/` + `delivery/` 并合成最小插件（含 `locale/en.json`、`locale/zh.json`、`icon.svg` 等）后执行：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <temp>\tools\package.ps1 -PackageRoot <temp>\package-root -OutputDirectory <temp>\output
```

结果：**30/30 通过**，包括：

- zip 名/位置正确，条目全部正斜杠；
- 固定 15 个条目齐全（含 `plugin/locale/en.json`、`plugin/locale/zh.json`），且没有意外条目；`dev/` 不进包；
- 包内 `安装.cmd` 为 ASCII 且 CRLF；
- `SHA256SUMS.txt` 列出 14 个文件且逐项哈希匹配；
- `.sha256.txt` 与整包 SHA256 一致；
- 第二次运行报 `already exists` 且不覆盖、原 zip 哈希不变；
- 非 ASCII CMD 被拒绝；
- `package.json.files` 越界声明（`src`）被拒绝。

临时夹具已删除，未在真实输出目录生成任何 zip。

### 4.3 真实目录预检（只读失败，不产物）

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\package.ps1
```

当前结果：退出码 1，报 `Missing release file: lib\client.js`；未创建 zip，也未创建 `tools/out`。这是预期的“等待集成”。

### 4.4 使用说明内容检查

18 项必需主题全部命中：功能、适用版本/Windows x64、安装、卸载、检查、Ctrl+O、创建工作区流程、修改工作区、跨文件夹写提权审批、读免费、已知限制、@file 补全/文件树只看主文件夹、版本锁定 0.2.1-rc.2、不动 app.asar、备份/回滚位置、自定义路径命令示例、-Profile、交付文件清单。

## 5. 当前状态与阻塞

- 已就绪：`package.json`（1.0.0）、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE`、`locale/en.json`、`locale/zh.json`、`lib/index.js`。
- 仍缺：**`lib/client.js`**（`src/client/30-browser.js`、`40-dialogs.js` 尚未产出，`tools/build-client.mjs` 待构建）。
- 未提前打包：zip 必须等 Lead 发“开始打包”后生成（避免打进半成品 lib）。

## 6. 打包执行步骤（收到“开始打包”后）

```
cd F:\AIwork\DSH custom plugin\multi-workspace
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\package.ps1
```

预期输出：
- `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`
- `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip.sha256.txt`
- 控制台打印 Bytes 与 SHA256；随后报告 zip 路径、大小、SHA256、条目清单。

## 7. 已知风险 / 说明

1. `package.ps1` 要求 `lib/client.js`、`icon.svg`、`README.md`、`LICENSE`、`locale/*.json` 都存在；缺任何一个会快速失败并列出缺失项（不产生半成品 zip）。
2. 使用说明为 UTF-8 无 BOM + CRLF，与参考包一致；Win10+ 记事本可直接打开。若后续用只认 ANSI 的老编辑器修改，需保持 UTF-8。
3. `portable.ps1`/`package.ps1`/`test-portable.ps1` 保持纯 ASCII，避免 Windows PowerShell 5.1 对 BOM-less 脚本按 ANSI 解码导致中文路径/文件名损坏。
4. 安装器通过进程名 `DeepSeek Harness` 判断运行中；若 DSH 更改进程名，需要更新 `Get-MwsDshProcesses`。
5. `-Mode Check` 也会校验源码包完整性，因此解压包内缺少 lib 文件时会直接报错（不会静默通过）。
6. zip 旁 `.sha256.txt` 在 zip 生成后写入；同名 zip 存在时根本不会走到写 sidecar。

## 8. 第二轮视觉/交互反馈同步（打包前更新）

用户第一轮视觉/交互反馈已在打包前实现（Lead 确认 39 pass，`lib/client.js` 已重建为 118,350 B），本轮同步内容：

1. 创建对话框：主文件夹不再“不可移除”，可点该行右侧的“×”删除；删除后下一项自动成为主文件夹。
2. 创建对话框：文件夹列表支持拖动重排，默认第一项是主文件夹；拖动改变顺序后，新的第一项自动成为主文件夹。
3. 修改工作区对话框：主文件夹仍固定（DSH 工作区目录不可改，也不能在对话框中删除），与创建模式区分清楚。
4. 对话框外观：矩形极光渐变描边（四角加粗、与侧边栏极光边框同色，跟随浅色/深色主题）。——第二轮用户反馈后已去除“四角加粗”，见第 10 节。
5. `使用说明.txt` 对应更新：第六节第 3–8 步（主文件夹可删、可拖拽重排、原生选择器优先、Web 浏览器回退、极光描边说明），第七节第 3–4 步（修改模式主文件夹固定）；仍为 UTF-8 无 BOM + CRLF（9,xxx B）。
6. 打包前用“真实目录隔离副本”复跑 package.ps1：EXIT 0，15 条目、SHA256SUMS 14 项 0 不匹配、sidecar 匹配、包内 client.js 与源码哈希一致，真实输出目录无产物。
7. `使用说明.txt` 最终为 9,248 字节（104 行），UTF-8 无 BOM + CRLF。

## 9. 正式打包结果（2026-10-21）

Lead 通知“测试通过，开始打包”（测试 39 pass；lib/client.js 已重建含本轮 UI 改动）后执行：

```
cd F:\AIwork\DSH custom plugin\multi-workspace
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\package.ps1
```

- 输出：`F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`
- 大小：55,571 字节
- SHA256：`2c321735626cff66d876bca0d2bf3279c1bc47f22bf237438f5d341a477111ec`
- 旁路校验：`dsh-multi-workspace-1.0.0-win-x64.zip.sha256.txt`（内容与整包哈希一致）
- 15 个条目：
  - `plugin/cordis.patch.yml` 335 B、`plugin/icon.svg` 757 B、`plugin/lib/client.js` 118,350 B、`plugin/lib/index.js` 31,517 B、`plugin/LICENSE` 1,089 B、`plugin/locale/en.json` 336 B、`plugin/locale/zh.json` 361 B、`plugin/package.json` 1,102 B、`plugin/README.md` 3,827 B
  - `tools/portable.ps1` 22,586 B、`使用说明.txt` 9,248 B、`安装.cmd` 284 B、`卸载.cmd` 281 B、`检查环境.cmd` 206 B、`SHA256SUMS.txt` 1,176 B
- 校验：SHA256SUMS 14 行逐项匹配、0 不匹配；包内 `client.js`/`index.js`/`使用说明.txt` 与源码哈希一致；三个 cmd 全 ASCII+CRLF；`plugin/package.json` 由 node 正常解析（name=dsh-multi-workspace、version=1.0.0、engines.dsh=0.2.1-rc.2）。
- 同名 zip 存在时重复运行会被拒绝，不覆盖、不修改既有产物。

## 10. 第三轮：去除“四角加粗”并重打包（2026-10-21）

用户第二轮反馈：对话框“四角加粗”样式不理想。Lead 已修改 `src/client/20-ui-kit.js`，删除 `.mw-dialog::before` 的四角 L 形装饰，保留 2px 矩形极光渐变描边 + 柔光；重建 `lib/client.js`（117,445 B），测试 **41/41 全绿**。

本轮打包侧操作：

1. `delivery/使用说明.txt` 外观说明改为“矩形极光渐变描边（与侧边栏极光同色，跟随深浅色主题）”，删除“四角加粗”；仍为 UTF-8 无 BOM + CRLF（9,223 B，104 行）。
2. 删除旧产物（删除前逐项核验绝对路径与文件名，确认是本插件文件；未触碰 `dsh-plugin-hub` 的任何文件）：
   - `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`
   - `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip.sha256.txt`
3. 重新运行 `tools/package.ps1`：EXIT 0。

新产物：

- 路径：`F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`
- 大小：**55,379 字节**
- SHA256：`834af46b45a28f168e6b92f74ca1828a7a236e724d74605cf820c25415904614`
- 旁路：`...zip.sha256.txt`，内容与整包哈希一致（单行）
- 15 个条目：`plugin/cordis.patch.yml` 335、`plugin/icon.svg` 757、`plugin/lib/client.js` 117,445、`plugin/lib/index.js` 31,517、`plugin/LICENSE` 1,089、`plugin/locale/en.json` 336、`plugin/locale/zh.json` 361、`plugin/package.json` 1,102、`plugin/README.md` 3,827、`tools/portable.ps1` 22,586、`使用说明.txt` 9,223、`安装.cmd` 284、`卸载.cmd` 281、`检查环境.cmd` 206、`SHA256SUMS.txt` 1,176
- 包内 `lib/client.js` SHA256 = `ce36ee648fa9dd1f41aff5ab69eb6ed26f6762c65190d6629bb1c8f146a8f10a`，与工作树**完全一致**（117,445 B）；`lib/index.js` 与 `使用说明.txt` 也与工作树一致
- SHA256SUMS 14 行逐项 0 不匹配；三个 cmd 仍 ASCII+CRLF；`plugin/package.json` 解析正常（1.0.0 / 0.2.1-rc.2）；使用说明中已无“四角加粗”
- 旧产物（55,571 B，SHA256 `2c3217…`）已作废删除，避免误交付；verifier 需对新 zip 跑 `test/package-check.ps1`。

## 11. verifier 验收结果（2026-10-21）

verifier 对新 zip 执行 `test/package-check.ps1 -ZipPath F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`：

- **PACKAGE CHECK PASSED: 126 checks / 0 fail**（目录 43 + ZIP 83），EXIT=0，无失败项、无需修复。
- 覆盖：15 条目均正斜杠/无重复/仅允许布局、必需条目齐全、`plugin/package.json` name/version/engines.dsh 正确、SHA256SUMS 14 行全量自校验 0 不匹配、3 个 cmd ASCII+CRLF、解包后 `lib/client.js` 通过 `node --check`、旁路 `.sha256.txt` 哈希正确。
- 包内 `plugin/lib/client.js` 117,445 B / `ce36ee64…` 与工作树一致；另比对 `lib/index.js`、`package.json`、`cordis.patch.yml`、`使用说明.txt` 也与工作树一致。
- 使用说明 9,223 B：无“四角加粗”，含“矩形极光渐变描边”。
- verifier 重跑测试会重建 bundle，结果仍为 117,445 B / `ce36ee64…`（可复现），zip 未被改动；41/41 测试通过。
- 打包侧复核：zip 仍 55,379 B / `834af46b…`，旁路一致，mtime 未变；`dsh-plugin-hub` 的文件未受影响。

结论：本轮交付包通过 verifier 验收，可作为最终交付物。后续若再次重打包，把新 zip 的 SHA256 发给 verifier 即可复跑。

