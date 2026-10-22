# Host 端实现报告（task-1，owner: host-bridge）

## 交付文件

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | Host 插件：状态文件原子读写、exact Fetch 路由、system prompt 段落。仅 `node:` 内置模块。 |
| `test/host.test.mjs` | `node:test` 单元测试（离线、临时 `DSH_HOME`、不写真实 `~/.dsh`）。 |
| `dev/host-report.md` | 本报告。 |

## 验证命令与结果

在 `F:\AIwork\DSH custom plugin\multi-workspace` 下执行：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/host.test.mjs
```

结果（2026-10-21，Node v24.19.0，win32 x64）：

```
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ duration_ms ~600
```

### 覆盖点（18 个用例）

1. 模块契约：`name` / `inject=['connection','systemPrompt']` / `apply`；无 `Config` 导出；源码 import 只有 `node:` 内置模块、无 `@deepseek-ai/*` / `require('@deepseek-ai/...')`。
2. `resolveDshHome`：`DSH_HOME` 优先（trim、空串回落）、`~/.dsh` 兜底；`stateFilePath` 绝对化。
3. `normalizePathKey`：Windows 下 `/` 与 `\`、大小写、尾分隔符折叠；非字符串/空串不匹配。
4. GET：`{ok:true,value:{version:1,workspaces:{}}}`；`content-type: application/json; charset=utf-8`、`cache-control: no-store`；首次 GET 不落盘；注册路由 `path/methods/requestBody/fetch` 精确匹配契约。
5. save：`fs.realpath` 规范化主文件夹；roots 去重（含尾分隔符变体）+ 去掉与主文件夹相同项、保持顺序；`name` 接受但不落盘；`updatedAt` 为 ISO；落盘结构 `{version:1,workspaces:{id:{id,path,roots,updatedAt}}}`；原子写后目录内只有 `state.json`（无残留 tmp）；同 id 覆盖写。
6. save 容错：`realpath` 失败（路径暂不存在）保留原拼写。
7. 非法输入 → HTTP 400 且状态不变、不写文件：坏 JSON(`invalid-json`)、非对象 body(`invalid-body`)、未知 op(`invalid-op`)、缺/空 id(`invalid-id`)、空/非字符串/相对路径(`invalid-path`)、roots 非数组/空项/相对项(`invalid-roots`)。
8. remove：删除成功 `{id,removed:true}`、重复删除 `{id,removed:false}`、缺 id → 400；内存与磁盘一致。
9. 重启持久化：unload 后重新 apply，GET 与 prompt 段落都能读到旧记录。
10. prompt 段落：`name='multi-workspace:roots'`、`order=8000`、`interpolate:false`、`text` 为函数；命中 `context.agent.session.header.cwd` 时输出主文件夹（带 `(primary folder of this Session)`）与全部成员文件夹，含 `sandbox_permissions` 提权说明；尾分隔符 cwd 命中；Windows 大小写不同 cwd 命中。
11. prompt 不命中/异常：无 context、无 agent、无 session/header、cwd 非字符串、无关 cwd、getter 抛错 → 均为 `''` 且不抛；只含主文件夹（roots 为空）的记录不输出段落；成员文件夹不是 Session cwd；记录删除后段落消失。
12. 清理已删除工作区：`ctx.get('workspaceRegistry')` 可用时 GET 按 `list()` id 剪除并落盘；二次 GET 稳定；registry 缺失 / `list()` 抛错 / 返回非数组时保留记录且 GET 仍 200。
13. 状态文件损坏或版本不符：降级为空 state（不阻塞插件启动），随后 save 可正常重写。
14. 并发 save：两次并发 POST 均成功，最终内存与磁盘都包含两条记录（写队列串行化）。
15. 非 GET/POST：405 `{ok:false,error:{code:'method-not-allowed'}}` + `allow: GET, POST`，不写状态。
16. dispose 幂等：`ctx.effect` 复合 disposer 与各注册 disposer 均只执行一次；重复 dispose / 重复调用 disposer 不抛错。
17. 缺省可选服务容错：只有 `connection` 的 ctx 上 `apply` 不抛错且仍注册路由。

### 补充：真实 Cordis 集成冒烟（未入库，一次性验证）

本机 `app.asar` 中提取了 0.2.1-rc.2 的真实依赖（`@deepseek-ai/cordis` 4.0.5、`dsh-scope`、`dsh-system-prompt`、`schemastery`、`cosmokit`、`@standard-schema/spec`），在 `%TEMP%` 夹具里用真实 `Context` + 真实 `SystemPrompt` 服务 + 假 `connection`（记录注册）加载本插件，结果 `INTEGRATION OK`：

- 真实 Cordis 生命周期下 `apply` 正常激活，`ctx.effect` 复合清理生效；
- 真实 `systemPrompt.section()` 接受该段落，`assemble({agent:{session:{header:{cwd}}}})` 的 sections 中能读到本段且 `renderPrompt()` 渲染正常；
- 不匹配的 cwd 段落文本为 `''`；
- 卸载 fiber 后段落消失、路由 disposer 被调用。

> 该冒烟只验证 Cordis/SystemPrompt 真实装配；真实 `HostConnectionService`（含 cookie 认证）与真实 `workspaceRegistry` 由 Lead 的安装后 live 检查覆盖。

## 与已安装代码核对过的 API 契约

- Fetch 路由：`@deepseek-ai/dsh-client-connection/lib/index.js`
  - `HostConnectionService.fetch.register(route)` → `registerFetchRoute()` → `assertFetchRoute()`：`endpointFromPath('/api', route.path)` 必须可解析（`/api/` 前缀 + 段字符集），`methods` 非空且不重复；
  - `createSharedFetchHandler('/api')`：命中路由且 `peer.principal.kind === 'owner'` 才调用 `route.fetch(request)`，否则 403；`/api` 前缀 Web 路由先做认证，未认证 401。⇒ 本插件路由 `/api/multi-workspace/state`、`['GET','POST']`、`requestBody:'buffered'` 合法，且自动走 cookie 认证。
- SystemPrompt：`@deepseek-ai/dsh-system-prompt/lib/index.js`
  - `section(PromptSection)` 的 `text` 可为 `(context) => string`；`interpolate:false` 时原样输出；空文本段在 `renderPrompt()` 被过滤（空段不产生空行噪音）。
- Prompt context：`@deepseek-ai/dsh-agent/lib/index.js` 的 `assembleContextFor(agent, signal)` 返回 `{agent, scope}`；`assemble()` 把它传给 section 的 text 函数。Agent 实为 `ReactLoopAgent`（`@deepseek-ai/dsh-agent-loop`），持有 `.session`，Session 有 `.header.cwd`。⇒ `context.agent?.session?.header?.cwd` 可靠。
- 工作区注册表：`workspaceRegistry.list(): Workspace[]`（`{id,path,title,...}`），`ctx.get('workspaceRegistry')` 可选读取。

## 实现决策 / 设计未明处

1. **roots 为空的工作区不输出 prompt 段落**：单文件夹工作区没有新信息，返回 `''` 由 registry 丢弃。记录仍照常保存（修改对话框需要预填）。
2. **cwd 只与记录的主文件夹匹配**（不匹配成员文件夹）：Session header.cwd 语义上永远是主文件夹；若把成员文件夹当 cwd 匹配，`(primary folder of this Session)` 标注会失真。
3. **remove 响应**：设计未固定，采用 `{ ok:true, value:{ id, removed:boolean } }`（不存在时 `removed:false`，仍 200 幂等）。若客户端想用别的形状请告知，改动成本极低。
4. **`name` 只接受不落盘**：save 忽略 `name`，响应记录不含 name（改名由 client 调 `workspaces.rename`），符合设计“只记录不落盘”。
5. **错误码**：roots 里的非法项统一回 `invalid-roots`（不是 `invalid-path`），便于客户端区分。
6. **apply 同步加载 state**：prompt 段落的 text 是同步回调，无法 await，所以启动时用 `readFileSync` 读小 JSON；读坏/版本不符/不可读降级为空 state 并 warn，不阻塞插件激活。
7. **写失败不回滚内存**：save/remove 先改内存再入写队列，写盘失败向 POST 返回 500；进程内状态与磁盘可能短暂不一致，重启以磁盘为准（设计未要求事务回滚，未额外扩大范围）。
8. **GET 剪除是尽力而为**：剪除后的持久化失败只 warn，不阻断 GET；下次 GET 会重试。
9. **Windows 大小写**：`normalizePathKey` 在 win32 折叠大小写与分隔符、去掉尾分隔符（盘根除外），索引键使用它；非 Windows 保留大小写。
10. **`\\?\` 长路径前缀**：realpath 若返回扩展前缀会剥掉，避免与 Session cwd 拼写不一致。

## 未覆盖 / 风险（交给 Lead 与 verifier）

- **未做 live 安装验证**：`package.json` / `cordis.patch.yml` 由 Lead 编写，安装后需检查（DESIGN 第 6 节）：Config 目录出现条目、`GET /api/multi-workspace/state` 未认证 401（而非 404）、已认证 GET 返回 200。
- **真实 Connection 认证链路**未在单测中跑：401/403 由 DSH `client-connection` 层负责（已读源码确认），本插件 handler 不做自己的认证。
- **自定义 DSH_HOME 的覆盖路径**：插件只按设计读 `process.env.DSH_HOME`。若桌面进程用命令行参数而非环境变量指定 home（`dsh-home-paths.resolveDshHome(configured, env)` 支持 configured 优先），本插件会落到 `~/.dsh`；live 检查时请用自定义 DSH_HOME 验证一次，必要时再协调（不擅自扩大范围）。
- 边界未自动化：>260 长路径、junction/symlink 目标身份（仅 realpath 成功时统一）、Windows 杀软/文件锁导致 rename 失败、两个 DSH 进程同时写同一 home（last-writer-wins，无跨进程锁）。
- prompt 只覆盖“Session 主文件夹 == 记录主文件夹”的工作区；成员文件夹信息不会出现在 `@file` 补全/文件树（DESIGN 已列为已知限制）。
- 状态文件损坏时旧数据被丢弃（只降级为空，无备份文件）；如需保留损坏副本可后续加 `.corrupt-<ts>` 备份。

## 给 Lead 的接口备忘

- 路由：`GET /api/multi-workspace/state` → `{ok:true,value:{version:1,workspaces:{[workspaceId]:{id,path,roots,updatedAt}}}}`
- `POST {op:'save', id, name?, path, roots?}` → `{ok:true,value:{id,path,roots,updatedAt}}`（path/roots 均绝对路径，roots 已去重去主文件夹）
- `POST {op:'remove', id}` → `{ok:true,value:{id,removed}}`
- 错误：400 `{ok:false,error:{code,message}}`；500 `{ok:false,error:{code:'internal-error',message}}`
- 状态文件：`<DSH_HOME>/multi-workspace/state.json`，原子写（同目录 tmp + rename）。
