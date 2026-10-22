# dsh-multi-workspace

DSH（DeepSeek Harness Desktop）0.2.1-rc.2 的多文件夹工作区插件。版本 **1.0.0**。

创建、修改和目录浏览界面采用独立的 DSH 蓝青色工作台：工作区信息与文件夹分区清晰，显示目录数量，目录行以名称和完整路径分两行展示，主文件夹带有徽标。界面适配深浅主题与窄窗，支持多目录选择、创建时拖动排序和修改时主文件夹锁定。

## 功能

- **创建工作区时可多选文件夹**：`Ctrl+O`（Windows 桌面版也可点侧边栏“添加工作区”）不再直接打开系统文件夹选择器，而是打开“创建工作区”对话框：填写工作区名称、反复添加文件夹、最后点“创建”。列表第一项是主文件夹（DSH 原生工作区目录），其余是成员文件夹；任意一项都可删除，删除首项后下一项自动成为主文件夹；也可拖动文件夹行调整顺序（第一项即主文件夹）。
- **给已有工作区添加文件夹**：工作区行右侧“...”菜单里新增“修改工作区”，可改名、添加/移除成员文件夹。修改时主文件夹对应 DSH 工作区目录（会话 cwd，DSH 不可变更），因此保持固定，成员文件夹可移除。
- **工作区下的所有会话都能访问成员文件夹**：Host 插件把成员文件夹的绝对路径写入该会话的 system prompt，模型知道它们存在，可用绝对路径 `read`/`glob`/`grep` 等读取。
- **写入保持 DSH 原生安全模型**：DSH 0.2.1-rc.2 的文件沙箱只有单一可写根（会话原始工作目录）。主文件夹之外的文件写入/修改不会绕过沙箱，而是走 DSH 自带的 `sandbox_permissions` 提权审批：模型发起、用户在 DSH 里逐次批准。插件不修改 sandbox 模式、不修改 `sandboxPolicy`、不修改 app.asar。

## 组成

| 部分 | 文件 | 职责 |
| --- | --- | --- |
| Host 插件 | `lib/index.js` | `<DSH_HOME>/multi-workspace/state.json` 持久化；注册精确 Fetch 路由 `/api/multi-workspace/state`；为该工作区的会话注入成员文件夹 system prompt 段落。仅使用 Node 内置模块。 |
| Client 插件 | `lib/client.js`（由 `tools/build-client.mjs` 从 `src/client/*.js` 生成） | 蓝青色工作台风格的创建/修改对话框、文件夹浏览、阴影原生目录选择器（优先原生 `pickDirectory`）、`shell.overlay` 宿主、工作区“...”菜单 DOM 增强。只依赖 React/ReactDOM。 |
| 交付 | `delivery/`、`tools/portable.ps1`、`tools/package.ps1` | 与 `dsh-plugin-hub`（口袋插件）同构的安装/卸载/检查/打包框架。 |

## 数据

```json
{
  "version": 1,
  "workspaces": {
    "<workspaceId>": {
      "id": "<workspaceId>",
      "path": "D:\\主文件夹",
      "roots": ["E:\\成员文件夹"],
      "updatedAt": "2026-10-21T12:00:00.000Z"
    }
  }
}
```

只保存插件自己的元数据；不复制、不移动、不删除任何用户文件。删除工作区或移除成员文件夹都不会删除磁盘内容。

## 已知限制

- `@file` 补全索引、右侧文件树、变更统计仍只覆盖主文件夹；模型可用绝对路径工具访问其他文件夹。
- 跨文件夹写/改需要 DSH 提权审批（逐次），这是用户明确选择的安全模型。
- 装饰依赖 DSH 0.2.1-rc.2 的 slot 名、CSS token 与原生工作区行菜单 DOM；升级 DSH 后需要重新适配。
- 工作区行“修改工作区”菜单项通过 DOM 增强实现（DSH 没有工作区行菜单扩展 slot）；结构不匹配时静默跳过，不影响原生菜单。

## 开发

```powershell
node tools/build-client.mjs          # 生成 lib/client.js
node --test test/host.test.mjs
node --test test/client.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-portable.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File test/package-check.ps1 -ZipPath "F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip"
```

安装到本机 profile 使用 `plugin_manager install_bundle`（目标为本目录的绝对路径），或使用交付包里的 `安装.cmd`。卸载使用 `卸载.cmd`；开发期也可用 `plugin_manager remove_bundle`。

便携包输出为 `F:\AIwork\DSH custom plugin\dsh-multi-workspace-1.0.0-win-x64.zip`，附包内逐文件校验与 ZIP 旁整包校验。打包器拒绝覆盖同名文件。

## 许可

MIT，见 `LICENSE`。
