# dsh-wsl — M0 契约定稿

本文件是 M0 的产出：在动手写产品代码前，把接缝与挂载机制钉死。所有结论都标注了来源与置信度。

来源标记：**[确证]** = 来自 live inspect 或 asar 内已安装代码/文档；**[推断]** = 结构推理，待运行时验证。

---

## 1. 插件导出契约 **[确证]**

来源：`@deepseek-ai/dsh-fs-local/lib/index.js`（已安装包）＋ asar 内 `cordis-plugin-development` skill。

Provider 采用 **Service 子类 default export** 形态：

```js
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

class LocalFileSystem extends Service {
  static Config = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  constructor(ctx, config) {
    super(ctx)               // ← 不传 name：服务名由注册处决定
    this.config = config
  }
  // ... 实现抽象方法
}

export { LocalFileSystem, LocalFileSystem as default }
```

对应实据（`dsh-fs-local/lib/index.js`）：

- 第 751–754 行：`static Config = z.object({...})`，`z` 来自 `@deepseek-ai/schemastery`。
- 第 763–764 行：`constructor(ctx, config) { super(ctx); ... }` —— **`super(ctx)` 不带服务名**。
- 第 909 行：`export { LocalFileSystem, LocalFileSystem as default }`。

配套事实：

- `cordis` 的 `Service` 构造器调用 `ctx.reflect.provide(name, self, this[Service.check])`，因此**在哪个 ctx 上 new，就注册到哪个 ctx 的作用域**（见 §2）。
- `Config` 由 schemastery 在校验时填充默认值，构造器拿到的是**已应用默认值的 resolved config**。
- 另一种形态是 `export function apply(ctx, config) {}` ＋ 可选 `export const inject = [...]` / `export const Config`。**两种不要混用**。`dsh-wsl-bundle` 的 `index.js` 用 `apply` 形态（且是空的 —— 切换只由 patch 拥有）；`dsh-wsl` 的 `index.js` 也用 `apply`，因为它注册的是普通对象而非 Service 子类。

### 1.1 Provider 的依赖 **[确证]**

`dsh-fs-local` 的 `peerDependencies`：`@deepseek-ai/dsh-fs` ＋ `@deepseek-ai/cordis`。
`dsh-fs-local` 的 `dependencies`：`chokidar`、`koffi`、`@deepseek-ai/schemastery`。

→ dsh-wsl 各 provider 需要 **`@deepseek-ai/dsh-fs`** 与 **`@deepseek-ai/cordis`** 作为 peer。
`@deepseek-ai/dsh-subprocess` 与 `@deepseek-ai/dsh-sandbox` 同理（抽象接缝包）。

**这些包在 npm 上可获取 [确证]**：registry 查询 `@deepseek-ai/dsh-fs` 返回 200，`dist-tags.next = 0.2.0-rc.2`，与本机安装的 DSH 版本**完全一致**（本机 asar 内所有包均为 `0.2.0-rc.2`）。`publishConfig.access` 在 0.1.0-rc.6 之后已改为 `public`，无需私有 registry。

DSH 源码 monorepo `deepseek-ai/deepseek-harness` 在 GitHub 上**不可匿名访问**（404）**[确证]** → 只能通过 npm tarball 或 asar 切片的 `lib/types/**/*.d.ts` 获取类型。

---

## 2. 按工作区的服务隔离机制 —— M0 的核心结论 **[确证]**

来源：asar 内 `@deepseek-ai/cordis` 的 `lib/types/context.js` 与 `lib/types/service.js`。

### 2.1 `ctx.isolate(name, label?)`

```ts
/**
 * Create a child context with an independent service scope for `name`.
 *
 * Below the returned context, reads and writes of the service `name`
 * resolve against the new label instead of the parent's, so a different
 * implementation can be provided without affecting the parent scope.
 * Passing the same `label` to two `isolate()` calls joins their scopes.
 *
 * @param name  — the service name to isolate.
 * @param label — scope label to join; defaults to a fresh unique symbol.
 */
isolate(name: string, label?: symbol) {
  const shadow = Object.create(this[symbols.isolate])
  shadow[name] = label ?? Symbol(name)
  return this.extend({ [symbols.isolate]: shadow })
}
```

关键性质：

1. **只隔离 `name` 这一个服务**，其余服务继承父级 → 隔离 `fs`、`subprocess`、`sandbox` 需**连续调用三次**。
2. **同一 `label` 会合并作用域** → 要让三个服务落在**同一个 realm**，必须传入**同一个 symbol**。
3. 不传 `label` 则每次调用生成 `Symbol(name)`，**三个调用会得到三个互不相同的作用域** —— 这是最容易踩的坑。
4. 隔离映射是**原型链 shadow**（`Object.create(parent[symbols.isolate])`），父级不受影响。
5. 服务实现在 store 中按 symbol 存放；**没有 isolate realm 的 provider 会把实现写到 root 的 symbol 下**，也就是「泄漏成进程全局」。

### 2.2 对 dsh-wsl 的直接推论

构造一个 per-target 的 realm：

```js
// 同一 label 复用 → 三个服务共享一个隔离作用域
const realm = Symbol(`dsh-wsl:${distro}`)

const scoped = ctx
  .isolate('fs', realm)
  .isolate('subprocess', realm)
  .isolate('sandbox', realm)

// 在隔离 ctx 下 new 出的是「这个 realm 的」实现
const fsSvc = new WslFileSystem(scoped, config)
const spSvc = new WslSubprocess(scoped, config)
const sbSvc = new WslSandbox(scoped, config)
```

**[推断]** 消费方（`dsh-tool-fs` / `dsh-tool-bash` / `dsh-subprocess-*` 的使用者）必须运行在**由同一 realm ctx 派生的上下文**里，才能解析到 WSL 实现。M4 需要验证的是「如何让某个 Agent/Session 的上下文落在这个 realm 下」。候选路径：`agentPresets.acquireScope(id)`（返回 `{ key: ScopeKey } & AsyncDisposable`）＋ loader 行的 `isolate` 选项；两者是否等价于 `ctx.isolate` 的 label 语义尚未确证。

### 2.3 已知的强制校验 **[确证]**

`agentPresets` 有一条硬性审计：

```
throw new Error(
  `preset "${mount.presetId}" published process-global service(s) [${leaked.join(', ')}] ` +
  `after its mount was audited ... — a preset service must sit behind an \`isolate\` realm ` +
  `or move to the host composition`
)
```

结合 `leakedServices()` 的实现（「A provider without an `isolate` realm stores its implementation under the root's symbol for that name」）——**provider 必须待在 isolate realm 内，否则 preset 体系会主动抛错**。这与 dsh-wsl 按工作区隔离的设计天然一致。

### 2.4 Loader YAML 层的等价物 **[确证]**

asar 内 `cordis-composition-reference` skill：

> A row has `id`, `name`, optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
> `isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.

> `mountRootInclude` registers `cordis:include` and `cordis:group` as Loader builtins: **a group row gives one `isolate` realm to a provider and its consumers together**.

→ 静态配置路径是 **`cordis:group` 行**；动态路径是 **`ctx.isolate()`**。dsh-wsl 按工作区动态连接，用后者。

---

## 3. 环境事实（本机实测）

| 项 | 值 |
|---|---|
| DSH 安装 | `D:\workspace\tools\dsh\`（Electron 打包，`resources/app.asar` 121 MB） |
| DSH 版本 | 所有 `@deepseek-ai/*` 包均为 `0.2.0-rc.2` |
| profile | `desktop`，位于 `C:\Users\13409\.dsh\profiles\desktop\` |
| profile bundles | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` |
| Node（Windows） | `D:\tools\scoop\apps\nodejs-lts\current\node.exe` v24.20.0 |
| DSH 自带 node | `D:\workspace\tools\dsh\resources\runtime\bin\node`（**无 .exe 后缀**，须经 `node.cmd` 调用） |
| WSL | 仅 `debian`，WSL2，运行中；内核 `6.18.33.2-microsoft-standard-WSL2` |
| distro 内用户 | `pang` |
| distro 内 Node | **完全没有**（只有 `/usr/bin/python3`、`/usr/bin/git`） |
| distro 内可达工作区 | `/mnt/d/workspace/dsh/dsh-wsl` |

---

## 4. 读 asar 的工具链（本机限制的绕行方案）

**问题**：DSH 的源码与文档都在 `resources/app.asar` 里，而

- `read` 工具读该文件报 `Cannot mix BigInt and other types`；
- 内部 `node`（`app.asar.unpacked\dsh\node_modules`）**没有 `@electron/asar`**；
- `app.asar.unpacked\dsh` 只有原生二进制，**没有业务源码**。

**可行方案**：自写 asar 切片器，格式已实测确认。

```
[0..4)   u32le = 4              (pickle 前缀)
[4..8)   u32le = headerSize+4
[8..12)  u32le = jsonSize       (含 4 字节尾部填充)
[12..16) u32le = jsonSize-4     ← 真正的 JSON 长度
[16,16+jsonSize-4)  UTF-8 JSON 目录
文件内容基准 = 16 + headerSize   ← 注意不是 8 + headerSize
```

每个文件条目为 `{ size, offset }`，内容位于 `contentBase + offset`。

脚本见 `tools/asar.cjs`（本仓库内，三个子命令 `list` / `get` / `lines`）。
**注意**：`Lines` 子命令按整文件行号切片，用于取出 asar 内嵌的长文档。

---

## 4.5 参考实现已拿到 —— M0 的决定性发现 **[确证]**

`deepseek-ai/deepseek-harness` 的 GitHub 仓库不可匿名访问，**但它发布的包在 npm 上是 public 的**。已下载四个 SSH 参考包（`0.2.0-rc.2`，与本机 DSH 完全同版本）到 `.scratch/ref/`：

| 包 | 作用 |
|---|---|
| `@deepseek-ai/dsh-ssh` | 连接所有者：OpenSSH master ＋ **带版本号的 POSIX helper** ＋ 独立转发流 |
| `@deepseek-ai/dsh-fs-ssh` | 经 helper 的 `ctx.fs` |
| `@deepseek-ai/dsh-subprocess-ssh` | 经 helper 的 `ctx.subprocess` |
| `@deepseek-ai/dsh-sandbox-ssh` | 经 helper 的 `ctx.sandbox` |

### 4.5.1 `dsh-ssh` 的真实形状

来自其 `README.md` 与 `lib/types/index.d.ts`：

```ts
export declare class SshConnection extends Service {
  static Config: schema<Config>
  readonly ready: Promise<Hello>          // 校验远端身份与 helper 摘要
  [Service.init](): Promise<void>         // 插件就绪前完成校验
  get nodeExecutable(): string
  get bootstrapPath(): string
  request<T>(method, params, result: z.ZodType<T>, signal?, wait?): Promise<T>
  connectStream(endpoint: SshStreamEndpoint, signal?): Promise<Socket>
  dispose(): Promise<void>
}
declare module '@deepseek-ai/cordis' { interface Context { ssh: SshConnection } }
export default SshConnection
```

`Config` 字段：`host`、`node`、`helper`、`helperHash`、`workspace`（均必填）、`bootstrapPath`/`bootstrapHash`、`requestTimeoutMs`(30000)、`maxFrameBytes`(67108864)、`maxPending`(128)、`leaseMs`(30000)。

**关键实现细节（可复用为设计约束）**：

- OpenSSH master 承载**私有管理 RPC**；**每个程序流用独立的转发 Unix socket ＋ 独立 SSH 通道** —— 这样程序 stdout 无法伪造管理响应，也不会占满控制流的通道窗口。
- 每个流用随机 **256-bit TLS PSK**，只经管理 RPC 传递，不经流前言；socket 目录 `0700`、socket `0600`。
- **心跳租约**：helper 在 SSH EOF、终止信号或心跳超时后启动远端托管清理。
- **绝不自动重连或重放**：「A disconnected client cannot confirm the remote outcome; operations are never reconnected or replayed automatically.」
- helper 以 `--disable-sigusr1` 启动，防同用户进程打开其 Node debugger。
- 连接前用 `helperHash` 校验安装产物摘要。

### 4.5.2 必须记录的**架构修正**

原计划 §4.1 写的是「在 distro 内起一个 **DSH host**，Host 经反向 stdio 桥转发」。参考实现证明这是**多余的**：

> The host runs the Harness, model transport and Session storage; the remote machine supplies **the files and processes**.

即 DSH 的远程模型是 **host（跑 Harness）＋ remote helper（提供文件与进程）**，远端**不跑第二个 DSH host**。这同时解决了原计划里最重的两个负担：不需要把 DSH 发行包塞进 distro，也不需要处理「两份 session 日志 / 第二个 `$DSH_HOME`」的冲突。

**修正后的 dsh-wsl 形态**：Windows 上的 DSH 跑 Harness；distro 内只跑**一个 helper**（Node 脚本），提供文件与进程能力；四个 provider 经 helper 把 `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` 接到 distro。

### 4.5.3 另外两条影响设计的确证

1. **`fs-ssh` 零配置**：「This provider has no configuration fields: connection identity and the default workspace belong to `dsh-ssh`, while file-effect mode belongs to `sandboxPolicy`.」→ 连接是**单一 target** 的，provider 从连接读坐标。**整profile 级，不是按工作区**。
2. **`fs-ssh` 不支持 watch**：「Filesystem watching is unsupported: the provider keeps no `watch()` override, so the base `FS_IO_ERROR` rejection applies without polling.」→ 原计划 §4.2 要求实现 `watch` 属于**超出参考实现**的额外承诺；改为与参考一致（明确不支持并返回 `FS_IO_ERROR`），可在后续里程碑作为增强。
3. **传输层并非线协议**：`connectStream` 返回的是 **`node:net` 的 Socket**（经 SSH 通道转发），不是裸字节流。`wsl.exe` 没有等价的通道转发能力，这是 dsh-wsl 与 dsh-ssh 的**本质差异**，也是本插件要自己解决的部分。

### 4.5.4 对「按工作区」的结论

`dsh-ssh` 是 **profile 级单连接**：`Config.host` 单值、`ctx.ssh` 单实例。因此参考实现**不提供**按工作区的多目标路由 —— 那正是本插件超越参考、也是用户明确要求的部分。

`ctx.isolate(name, label)`（§2）是现成的机制，且 §2.3 的 preset 审计**强制** provider 必须待在 isolate realm 内。两者一致 → **按工作区 = 按 realm**：每个 distro 一个 realm，在同一 realm 内注册该 distro 的 `fs`/`subprocess`/`sandbox`。

---

## 6. 实施进度

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 契约定稿 | **完成** | §1–§4.5；参考实现已拉取到 `.scratch/ref/` |
| M1 连接骨架 | **完成** | `tests/m1-acceptance.mjs` **28/28 通过**；`uname` 返回 `Linux 6.18.33.2-microsoft-standard-WSL2`，distro 为 Debian GNU/Linux 13 (trixie) |
| M2 `dsh-wsl-subprocess` | **完成** | `tests/m2-acceptance.mjs` **18/18 通过** |
| M3 `dsh-wsl-fs` | **完成** | `tests/m3-acceptance.mjs` **52/52 通过** |
| M4 作用域路由 | **已废弃** —— realm 机制与 DSH 架构冲突（§6.5），代码已删除 | 结论保留在 §6.5 |
| M5a 整 profile 切换到 WSL | **完成** | `tests/m5a-acceptance.mjs` **11/11 通过** |
| M5b sandbox + UI | 未开始 | — |
| M6 Skill/MCP/Plugin 同步 | 未开始 | — |
| M7 打包与 `install_bundle` | 未开始 | — |

### 已交付的文件

```
packages/dsh-wsl/
  package.json
  helper/
    protocol.js        # 生成物：lib/protocol.js 的同步副本（tools/sync-helper.mjs）
    fsio.mjs           # Cordis-free 文件原语：realpath 身份、版本 token、原子发布、字面编辑
    wsl-helper.mjs     # distro 内唯一的 dsh-wsl 进程
  lib/
    protocol.js        # 权威帧协议：u32be 长度前缀 + JSON，64 MiB 上限，版本握手
    runtime.js         # 固定 Node v22.20.0 linux-x64 + 官方 SHA-256
    connection.js      # wsl.exe 传输、帧解码、心跳、租约、dispose、运行时供给、helper 部署
    subprocess.js      # ctx.subprocess 实现 + 环境擦洗
    paths.js           # Windows ↔ WSL 路径翻译（纯函数、可逆、不可译即拒绝）
    fs.js              # ctx.fs 实现（同步构造、惰性连接、按需解析相对基准）
    provider.js        # createWslRuntime + provideHostServices（host 平面注册）
  index.js             # Cordis 插件入口（apply），返回连接面
packages/dsh-wsl-bundle/
  package.json         # dsh.bundle.patch 指向下方 patch
  cordis.patch.yml     # 禁用被替换的行（fs-local / fs-sandbox / subprocess / sandbox-local）并插入 WSL 行
  index.js             # 空的 host 半侧：切换只由 patch 拥有
  locale/en.json       # UI 文案
tools/
  asar.cjs             # app.asar 切片器（README/源码取证）
  fetch-ref.mjs        # 从 npm 拉取参考包
  install-skills.mjs   # 按 commit + blob SHA 校验安装 ponytail skill
  sync-helper.mjs      # 同步 helper 侧协议副本（--check 用于 CI）
  probe-registry.mjs   # 探测 seam 包可用性
  probe-distro.sh      # distro 工具与网络探测
tests/
  m1-acceptance.mjs    # 28 项
  m2-acceptance.mjs    # 17 项
  m3-acceptance.mjs    # 52 项
  m5a-acceptance.mjs   # 11 项
```

**合计 109 项检查全绿。** 统一跑法：

```powershell
foreach ($m in @("m1","m2","m3","m5a")) { node "tests\$m-acceptance.mjs" }
```

> 2026-10-01 修复：`process.spawn` 曾把宿主 Windows `PATH` 原样转发进 distro 子进程，裸名命令按它解析必然 ENOENT（实测 exit -2、无 stderr）。现 host 侧不再转发宿主 `PATH`（`lib/subprocess.js`），helper 侧默认给子进程注入自己的 Linux `PATH`（`helper/wsl-helper.mjs`，与 `exec.resolve` 同一模式）；显式 spec `PATH` 仍然优先。回归守卫：`the child gets a Linux PATH, not the host one`。

### M4 review 发现的缺陷（已修，含回归守卫）

> 注：M4 的 realm 机制本身已按 §6.5/§6.6 废弃并删除代码。下面记录的是那次 review 的过程与教训，其中「测试同义反复」一条对后续所有里程碑仍然适用。

对 M4 做了一次对抗性 review，写了一个临时探针去实测而不是只看代码。**发现一个真实泄漏**：

**`ctx.provide()` 返回的 disposer 从未被调用 → 服务槽每次重连都会累积。**

实测证据（探针输出，探针已删除，断言已并入 `m4-acceptance.mjs`）：

```
修复前:  fs slots after start = 2 → after release = 2 → after cycle 2 = 3 → after restart = 4   ✗ 单调增长
修复后:  fs slots after start = 2 → after release = 1 → after cycle 2 = 2 → after restart = 2   ✓ 平台稳定
```

这是**用户可见的**：长驻宿主里每次断开/重连都会多留一个死槽，最终可能撞上「service already registered」而无法重连。触发条件很普通 —— `wsl.exe --shutdown`、distro 重启、helper 崩溃。

同时修复的其他缺陷：

| 缺陷 | 后果 | 修法 |
|---|---|---|
| `dispose()` 没有清 `#ctxs`/`#setup` | 断开后再 `start()` 会返回**已死的 provider**（`#setup` 命中缓存） | dispose 时一并清空，并释放槽位 |
| `connect()` 永久缓存已 resolve 的值 | 连接死掉后 `connect()` 永远返回死 realm，只有显式 `disconnect()` 才能恢复 | 先查 `realm.connected`，失效则 drop 重建 |
| `registry.acquire()` 每次构造一个一次性 `WslRealm` 只为算 key | 无谓分配 | 加 `WslRealm.keyFor()` 静态纯函数，先查表 |
| `THE LOAD-BEARING ASSERTION` 是**同义反复** | 断言 `x === x`，等于没测 | 改为断言「realm 解析到的**不是**宿主 provider」 |
| `index.js` 未使用 import（`WslRealm`/`expandHome`/`isWindowsBackedPath`） | 噪声；且 `WslRealm` 与 "WslRealm 是本模块内定义的类" 冲突 | 清理 |
| `start()` 的 `@returns` 类型漏了 `homeDir`、引用了未导入的 `WslSubprocess` | 文档撒谎 | 修正 |

新增回归守卫：`disposal frees the realm slot instead of leaking it`、`a fresh realm reuses the slot count rather than growing it`（断言 **恰好 +1**，不是原缺陷暴露时写的那种同义反复）、`disposing twice is safe`。

### M4 仍未解决的部分（诚实记录）

1. **「realm 建立了」≠「Session 被路由过去了」。** M4 只证明 realm 能建立且不污染宿主。**如何让某个 Session 的消费方解析到 realm 而不是宿主，仍未实现**——那是 M5 的工作。目前 `realm.contexts.{fs,subprocess}` 只是「可用」，没有消费方。
2. **`contexts` dispose 后变 `undefined`，但 vivo 的引用已经泄漏出去了。** 谁在 dispose 前拿到 contexts 并持有，之后就是悬空 fiber。需要一个明确的「realm 失效」信号，而不是让调用方去读可能为 `undefined` 的 getter。
3. **旧 `fs`/`subprocess` provider 对象没有被 dispose。** realm dispose 会释放**槽位**和**连接**，但 `WslFileSystem`/`WslSubprocess` 实例自身只是被解引用。它们没有独立的资源，所以目前无害，但这是「靠没有资源」而不是「靠正确清理」。
4. **`start()` 部分失败会泄漏已建的连接。** 若连接建立成功、随后 `provide` 抛错，`#connection` 已设置但 `#setup` 仍是 reject 的 Promise；`dispose()` 能救，但 registry 必须先知道要调它。
5. **`WslRealm` 同时管「连接」与「注册 provider」两件事。** 前者是机制，后者是策略。分开会让测试更容易（现在测试必须走真实连接才能验注册逻辑）。
6. **没有空闲回收。** registry 持有 realm 直到显式 release；配置项里也没有空闲超时。M1 设计里有这个意图，尚未落地。

## 6.5 M5a 结论：按工作区的服务路由与 DSH 架构冲突（未实施）

**这不是「没做完」，而是「做不到」—— 用证据说明。**

M5a 目标：让一个 Session 解析到 WSL provider，其他 Session 保持宿主。我按「先理解问题」的顺序调查，得到一条否定的结论。

### 证据

1. **`fs`/`subprocess` 是 host-plane 服务，不是 preset 挂载服务。**
   `agentPresets.serviceFor(agent, name)` 在整个 DSH 里只被用于 **`skills`** 一处（asar 328279、340185）。terminal-controller 的注释直接写明：
   > "The Agent context selects execution providers but does not inject consumer services."
2. **`fs`/`subprocess` 的消费方通过 inject 解析，而不是 `agent.ctx`。** Cordis 的 `inject(['fs'])` 在 fiber 构建时解析服务，早于任何 Session 存在。
3. **`serviceForAgent` 的文档把这个边界写死了：**
   > "It is not a general host handle on a session's internals: a host row that `inject`s a service cannot use it, because injection resolves before any session exists and has no agent to key by — **such a service belongs on the host plane.**"
4. **`ctx.fs`/`ctx.subprocess` 是「每 context 一个实现」的接缝**，宿主已有 `dsh-fs-local`/`dsh-subprocess-local` 占用。

### 实测的 store 语义（`tests/agent-routing-mechanism.mjs`，9/9 通过）

- store **全局共享**，按 isolate symbol 分槽。
- `provide()` 写入 `ctx.fiber.store`；**`createScope()` 提供的独立 fiber 是 realm 能存在的前提**。
- **关键陷阱**：隔离注册**无法**通过 `ctx.get()` 读回 —— 重新派生同一 isolate 上下文会得到 `undefined`，而父上下文回落到宿主实现。正确读取路径是按 fiber 归属扫描 store，也就是 `serviceForAgent` 做的事。
- `Service` 构造函数**本身就是注册**，再加 `provide()` 会重复注册报错。

### 因此 M5a 需要方向决策（见下）

## 6.6 M5a 实施：整 profile 切换到 WSL（方案 A，已完成）

方向确认后按方案 A 实施。**决策是 A，代价是放弃「本地与 WSL 并存」** —— 那是原计划的核心承诺，现已明确不做。

### 实现

- **`lib/provider.js`**：`createWslRuntime`（单一连接 + 供给 + helper 部署）与 `provideHostServices`（在 host 平面注册 `fs`/`subprocess`）。
- **`index.js`**：`apply` 同步注册两个 provider（惰性连接），`ctx.effect` 同时释放服务槽与连接。
- **`dsh-wsl-bundle`**：`cordis.patch.yml` 禁用被替换的行并插入 WSL 行。
- **删除**：`lib/realm.js`、`WslRealm`/`WslRealmRegistry`、`createWslFileSystem` 工厂、以及全部 realm 探针测试（`realm-mechanism`、`m4-acceptance`、`probe-m1`）。

### 为什么必须禁用而不能「顶替」

实测确证（`tests/m5a-acceptance.mjs` 的 `THE REASON FOR THE PATCH`）：第二个 host 行**无法**顶替已被占用的槽 —— Cordis 拒绝它，**本地 provider 继续持有该槽并继续服务**。也就是说「不 patch 直接提供」会**静默失败**：插件看起来装好了，实际所有消费者仍在用本地实现。所以 patch 里必须显式 `disabled: true`。

### 同时修掉的两个真实缺陷

1. **`~` 展开顺序错误**：原先先 `joinLinux` 再 `expandHome`，导致 `~` 变成 `/~/`（实测 `EACCES: mkdir '/~'`）。改为**先展开后拼接**。
2. **`cwd` 用了宿主值**：相对路径基准原本取自宿主 `cwd`（Windows 路径）。改为**按需向连接解析**（distro 报告的 Linux home），并缓存；注册阶段因此仍不产生任何 I/O。

### 诚实记录的代价与缺口

- **不能并存**：本地与 WSL 会话无法在同一 profile 内同时工作。要切回本地必须禁用本 bundle。
- **沙箱不再强制**：被禁用的 `sandbox-local` 与 `fs-sandbox` 是宿主侧的进程/文件效果限制，**无法约束运行在 distro 内的进程**。`sandboxPolicy` 仍挂着以满足需要它的消费者，但**模式会被报告而不会被强制**。这是 M5b 要正面解决的问题，patch 注释里也写明了。
- **`fs.js` 仍保留 `defaultCwd` 与 `#explicitCwd` 两条路径**，因为 M3 测试用显式 `cwd`、provider 用按需解析，两者都是真实用例。

### M4 实测确证的事实 —— M0 唯一未决风险的定论

> 注：M4 的 realm 方案已废弃（§6.5/§6.6），相关测试文件已删除。**但这一节记录的 store 语义本身仍然有效且重要** —— 它解释了为什么「第二个 host 行无法顶替已占用的槽」，而这正是 M5a 必须用 patch 禁用旧行的原因。

M0 把「按工作区的隔离作用域能否成立」列为最大技术风险。**已用真实 Cordis 运行时验证通过**（`tests/realm-mechanism.mjs`）：

- **机制成立**：`ctx.isolate(name, label)` 会切出一条独立的服务槽。实测 store 同时持有 `Symbol(thing)→host` 与 `Symbol(wsl:debian)→debian`，根上下文与子 realm 各解析到自己的实现。
- **⚠️ 关键陷阱：label 就是槽本身，且逐字存储。** 把**同一个 symbol 用于三个服务名**会让三个服务共用**一个**槽，后注册的覆盖先注册的。这会**静默**发生：宿主侧看起来完全正常，只有 realm 内部两个服务互相踩踏。
  → 因此 **每个服务名必须有自己的 label**。realm 的「一致性」来自**共用同一个连接对象构造**，不来自共享 symbol。
- **不传 label 会生成新 symbol**，所以「省略 label」不会意外共享 realm。
- **`Context.prototype.get()` 返回的是服务门面，不是构造出的对象**；身份比较必须用可观察状态（如 `.label`），不能用 `===`。这是我一版测试写错的原因。
- **根上下文始终不受影响**：子 realm 的注册不会改动父级的实现。

`tests/m4-acceptance.mjs` 又用**真实 provider** 验证了成对断言：realm 解析到 WSL 的 `fs`/`subprocess`，**同时宿主仍然解析自己的**；store 里出现两个 `fs` 槽；并且 realm 的文件写入能被 distro 内进程读到、realm 的子进程返回 `microsoft-standard-WSL2`。这条成对断言才是真正重要的——一个靠「替换宿主 provider」实现的 realm 会通过前半句而挂掉后半句，那正是「本地会话悄悄跑进 distro」的 bug。

补充：`ctx.provide('wsl', …)` 不可用（`provide` 要求属性已在 `props` 注册）。API 改为由 `apply` **返回**，而不是发布成一个进程级服务名 —— 消费方本就走 provider seam，多一个全局服务名只会污染命名空间。

### M3 实测确证的事实

- **错误码必须带外传递**：文件系统的 `FS_*` 码不在传输层窄词表（`BAD_FRAME`/`UNKNOWN_METHOD`/…）内。第一版把每个域失败都压成 `INTERNAL`，测试立刻暴露。修法：helper 在错误帧里额外带 `appCode`，Host 侧据此重抛真实 `FS_*` 码。**这是 §4.5「参考实现用 zod 校验响应」之外的一条独立约束**。
- **`--strip-components=1` 的落点是 `bin/node`**（不是 `node/bin/node`）。
- **版本 token 用 `dev:ino:size:mtimeNs:ctimeNs`**：实测「等长重写」（`AAAA`→`BBBB`）能被守卫检出为 stale，因为 `ctime` 移动了。
- **CRLF 保留**：编辑在 LF 归一化文本上匹配，发布时还原主导行尾；`od -c` 确认落盘仍是 CRLF。
- **原子发布的权限保留**：rename 会带上临时文件的 mode，所以发布前显式沿用目标原有 mode。
- **`sandboxMode` 必须如实报 `undefined`**：裸后端从不限制，谎报会让工具层错误地宣传升级字段。
- **供给改为幂等**：`ensureRuntime` 先探测已装运行时并复用，避免每次连接都重下重解（对应 ZCode「后续连接复用已准备资源」）。

### M2 实测确证的事实

- **`wsl.exe` stdio 是可用的长连接双向通道**：顺序保持、单次写入 ≥1 MiB、`WSL_UTF8=1` 下输出是干净 UTF-8。
- **`wsl.exe -l -v` 需要 UTF-8 或 UTF-16LE 双解码**（`WSL_UTF8=1` 在某些构建上无效）。
- **`--strip-components=1` 解包后 `bin/node` 直接落在 runtime 目录下**（不是 `node/bin/node`）。
- **distro 内网络**：`nodejs.org` 可达（HTTP 200），`registry.npmjs.org` 被 TLS 阻断。因此默认走「Windows 侧下载后推进 distro」是正确选择。
- **helper 部署后读回校验**：`sha256sum` 远端回读与本地摘要比对，防止「无法校验自身部署」。
- **按进程组终止**：`detached: true` + 负 pid `kill`，实测 `sleep 300` 在 2 ms 内以 `SIGTERM` 结束。

### 明确的实现边界（不静默降级）

`ctx.subprocess` 的**裸 `'pipe'` 输出流**与**可选 duplex control 通道**尚未实现，且会**显式抛错拒绝**。原因：二者都需要第二条独立流通道；M1 的单条帧管道（`wsl.exe` stdio）无法在不破坏「管理响应不可被程序 stdout 伪造」这一性质的前提下提供它。参考 SSH 实现靠「每流一条 SSH 通道」获得该性质，dsh-wsl 需要后续里程碑引入 distro 内 Unix socket。

---

## 7. M0 未决项（进入下一阶段前需验证）

| # | 未决项 | 状态 | 影响 | 验证方式 |
|---|---|---|---|---|
| 0 | 远程模型是「host ＋ remote helper」而非「远端 host」 | **已解决**（§4.5.2） | 大幅简化：distro 内不跑 DSH | 参考实现 README |
| 0b | provider 依赖可获取（npm public） | **已解决**（§4.5） | 可装 seam 包拿类型 | registry 探测 |
| 0c | 校验库用 `zod` 而非 schemastery | **已解决** | `Config: schema<Config>` 用 schemastery；`request()` 的 `result: z.ZodType<T>` 用 **zod**，两者并存 | `dsh-ssh/lib/types/index.d.ts` |
| 1 | 让某个 Agent/Session 的上下文落入指定 realm 的确切 API | 未决 | 决定 M4 能否按工作区路由 | 读 `dsh-agent-preset-registry` ＋ `dsh-scope` 的 `.d.ts`（已可下载）；运行时用 `cordis_inspect_query` 观察服务解析 |
| 2 | `agentPresets.acquireScope(id)` 与 `ctx.isolate(name, label)` 是否语义等价 | 未决 | 同上 | 同上 |
| 3 | 每个 workspace 的执行目标记录该落在哪 | 未决 | 决定持久化设计 | 读 `dsh-workspace` 的 `.d.ts`（已可下载） |
| 4 | `ctx.subprocess` provider 抽象基类的导出名与必实现方法集 | 未决 | M2 实现 | `@deepseek-ai/dsh-subprocess` 的 `.d.ts` |
| 5 | `ctx.sandbox` provider 抽象基类的导出名 | 未决 | M5 实现 | `@deepseek-ai/dsh-sandbox` 的 `.d.ts` |
| 6 | `wsl.exe` stdio 是否可靠承载长连接分帧（无内层 TTY 竞争） | 未决 | M1 的成败前提 | M1 用最小 echo/uname 往返实测 |

**下一步动作**：安装 seam 包（`dsh-fs`、`dsh-subprocess`、`dsh-sandbox`、`dsh-scope`、`cordis`）到开发 workspace，从 `lib/types/**/*.d.ts` 读权威类型，消解 4、5；再做 M1 的 `wsl.exe` 往返实测消解 6。
