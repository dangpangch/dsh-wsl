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

## 4.6 ZCode 对照：能借鉴的是 WSL 行为边界，不是架构

来源：通读 `ZCode-main/packages/server/src/remote/`（`wsl-backend`、`wsl-detect`、`wslProxy`、`connect`、`create-backend`、`remoteDeployLock`、`zcodeAgentWrapperDeploy`）、`ZCode-main/packages/shared/src/`（`remoteTarget`、`wslUserValidation`、`remote-workspace-identity`）、`ZCode-main/packages/desktop/src/`（`main/desktopWslTargetResolver`、`main/desktopRemoteSessions`、`host/windowRemoteConnectionRegistry`、`main/openInEditor`），以及本仓库 `packages/dsh-wsl/**`、`tests/**`。

**本节结论：不能把 ZCode 的 WSL 实现当作 dsh-wsl 的模板。** 两者解决的不是同一个问题。ZCode 的 WSL 后端是「往 distro 里部署一个完整服务，再用一条 stdio RPC 客户端连它」的三种 backend 之一；dsh-wsl 要交付的是「主机跑 Harness，distro 内只跑一个 helper，把 `fs`/`subprocess`/`sandbox` 三个 seam 接到 distro」。**ZCode 的模型恰好就是 §4.5.2 已否决的「远端 host」模型** —— 照搬它等于把已论证掉的方案重新引入，代价是三份重复状态（两份 `$DSH_HOME`、两份 session 日志、一份 distro 内 DSH 发行包），并丢掉 seam 契约。

即使把「只做 WSL 连接」理解为「只实现连接层、不顺带做三个 provider」，结论不变：dsh-wsl 的连接层必须交付**延续性 + 供给 + 租约 + seam 语义**，而 ZCode 的 WSL 后端交付的是**一次性命令通道**（`exec` 一次一条命令、无状态、无 helper、无租约）。

### 4.6.1 根本差异（不可迁移的部分）

| 维度 | ZCode | dsh-wsl |
|---|---|---|
| 远程模型 | distro 内跑第二份完整服务：`~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`（`connect.ts:391`） | 主机跑 Harness；distro 内只有 `helper/wsl-helper.mjs` 一个进程 |
| distro 内部署物 | Node + `zcode-server.cjs` + node-pty + 远端资产包 | 固定 Node v22.20.0 + helper 三件套 + bwrap `.deb` |
| 主机侧角色 | RPC 客户端（`ChannelClient` + `RemoteServiceAccess`） | `fs`/`subprocess`/`sandbox` 三个 seam 的 provider 实现方 |
| 后端接口形态 | `exec` / `upload` / `readFile` / `exists`，一次调用一条命令 | `WslConnection.request(method, params)`，长驻进程 + 请求 id 多路复用 |
| 程序流隔离 | 不需要（远端 server 自己管） | 需要，但 `wsl.exe` 不给 → 已显式拒绝而非降级（§6） |
| 连接活性 | 无心跳（本地 `wsl.exe` 进程可等 close 事件） | 心跳 10s（`lib/connection.js:40`）+ helper 租约 60s（`:42`） |
| 资源生命周期 | 无租约；远端 server 进程自己活 | 租约到期 helper 自行清理托管范围（`lib/connection.js:500`） |
| 范围粒度 | 一个 Host 服务多个 workspace（按 `wsl:distro\0user` 池化 + 60s 空闲回收） | 整 profile 切换（`fs`/`subprocess` 是 host-plane 单例） |
| 路径与身份 | `workspacePath`（Linux 路径）与 `workspaceIdentity`（去重 key）分离并贯穿全链路 | 无 workspace 路由（M4 已废弃），只有一份 `cwd` |
| 并发部署 | 有远端部署锁（owner token + heartbeat + release marker） | 只有进程内 `setup ??=`（`lib/provider.js:119`） |

也就是说，**不可迁移的是架构**：远端模型、接缝契约、生命周期所有权、范围粒度。

### 4.6.2 已经独立收敛的一致项（说明 WSL 的「知识」部分没有缺口）**[确证]**

| 问题 | ZCode | dsh-wsl |
|---|---|---|
| UTF-8 / UTF-16LE 双解码 | 靠含 NUL 字节判断（`wsl-detect.ts:10`） | 同一启发式（`lib/connection.js:59`） |
| `wsl.exe -l -v` 首列 `*` 标记默认 distro | 是（`wsl-detect.ts:57`） | 是（`lib/connection.js:172`） |
| `-d <distro> -u <user> -- …` 参数形状 | 是（`wsl-backend.ts:69`） | 是（`lib/connection.js:114`） |
| 强制 UTF-8 输出 | 未设 `WSL_UTF8` | 每次调用注入 `WSL_UTF8=1`（`lib/connection.js:75`）→ 更稳 |
| 原子发布 + 校验和 + 复用已装资源 | `remoteAssetCache` | `.partial` + rename、SHA-256、`reusing the runtime already installed`（`lib/connection.js:586,782`） |
| 只 kill 自己 spawn 的子进程，绝不 terminate distro | 是（`wsl-backend.ts:425`） | 是（`lib/connection.js:500`，另有租约兜底） |
| 域错误码带外传递 | 无对应物 | `appCode`（`lib/connection.js:358`）——M3 独立得出 |

### 4.6.3 值得借鉴的三项（按价值排序，均未排期）

**1. 跨进程部署互斥 —— 当前真实缺陷 [高]**

dsh-wsl 的部署幂等只在**进程内**（`setup ??=`，`lib/provider.js:119`）。同一台机器上两个 DSH 窗口（或宿主重启后的残留 helper）同时首次连接同一 distro，会并发执行 `ensureRuntime` → 并发 `mkdir` 同一 `runtimeDir`、并发 `tar -xJ` 覆盖 `bin/node`。

ZCode 对同一问题有完整答案，且它的注释恰好点出同一情形：进程内 single-flight **无法**覆盖不同 Desktop/build/backend（`ZCode-main/packages/server/src/remote/deploy.ts:439`），实现见 `remoteDeployLock.ts`。

> 2026-10-01 复核：仍未修。M5b 的 `ensureBwrap` 把同一模式复制到了第二个资产。另发现 Windows 侧子问题：`fetchNodeArchive`/`ensureBwrap` 的暂存路径固定为 `archivePath.partial`（`lib/connection.js:588-590`、`:783-785`），两进程并发下载会交叉写入同一暂存文件、rename 发布损坏归档——读缓存时的 SHA 校验能自愈但浪费；修互斥锁时应改用带 pid/随机的暂存名。**→ 均已由 M5c-3 修复（`withProvisionLock` + 带 pid 暂存名）。**

**2. `bash -lc` 多行脚本会被提前展开 —— 疑似真实缺陷，待实测 [高]**

ZCode 用注释钉死了一条实测结论（`ZCode-main/packages/server/src/remote/remoteDeployLock.ts:85-86`）：

> `wsl.exe` 会先经默认 shell 重组 `bash -lc` 参数，脚本里的局部 `$var` 会在真正的 shell 执行前被展开为空。用纯八进制内容落盘后再执行。

ZCode 为此发明了两个绕法（八进制编码落盘、按字节上传替代 shell 写入，见 `remoteDeployLock.ts:82` 与 `zcodeAgentWrapperDeploy.ts:21`）。**dsh-wsl 也走 `bash -lc`**（`lib/connection.js:117`）。逐条核对本仓库的脚本：

| 落点 | 脚本内容 | 是否含 shell 变量 | 有测试覆盖 |
|---|---|---|---|
| `ensureRuntime` `push` | `mkdir -p … && tar -xJ -C … -f -` | 否 | 是（m1:245、m2、m3:154） |
| `ensureRuntime` **`distro`** | `tmp=$(mktemp -d)` … `"$tmp/${NODE_ARCHIVE}"`（`lib/connection.js:696-705`） | **是** | **否** |
| `ensureRuntime` `existing` | `test -x … && … --version` | 否 | 否 |
| `ensureBwrap` | `dpkg-deb -x - …` | 否 | 是（m5b:258） |
| `deployHelper` | `cat > …` / `sha256sum …` | 否 | 是（m1:269） |

即：**唯一含 shell 变量的脚本恰好是唯一没有测试的策略**，且形状正落在 ZCode 记录的失效模式上。若 ZCode 的结论在本机成立，`distro` 策略会**响亮地失败**（`curl` 得到被展开为空的路径）而非静默错误。**[推断]** —— 本仓库的 m1/m2/m3/m5b 全部显式使用 `strategy: 'push'` 或省略（默认 `push`），**`distro` 与 `existing` 两个策略从未被任何验收脚本执行过**（`tests/m1-acceptance.mjs:251`、`tests/m2-acceptance.mjs:116`、`tests/m3-acceptance.mjs:154`）。

> 2026-10-01 复核：维持原结论——仍未实测、仍未修（grep 证实验收脚本仍全部 `push`）。**→ M5c-4 已实测确证并修复：脚本改为变量自由，探针结论钉在 m5c 的 THE TRANSPORT FACT 检查里。**

**3. 「默认 distro」未归一 —— 会造成重复部署 [中]**

ZCode 用 `resolveCanonicalWslTarget`（`ZCode-main/packages/desktop/src/main/desktopWslTargetResolver.ts:31`，5s TTL）把 `{}` 解析成 `{distro, user}` 的真实值，理由正是「默认 distro」与显式名字不能变成两个不同目标。

dsh-wsl 的 `resolveHome` 只取 `$HOME`（`lib/provider.js:69`），**没有把默认 distro 归一成真实名字**，而 `index.js:60` 把 `config.distro ?? ''` 一直传下去。后果在 `lib/connection.js:633`：

```js
const runtimeDir = `${homeDir}/.local/share/dsh-wsl/${distro}`   // distro === '' → 尾部空段
```

于是「不填 distro 连一次」与「填 `debian` 连一次」落到**两个目录**（`…/dsh-wsl/` 与 `…/dsh-wsl/debian`），各下载一份归档、各部署一份 helper、各下载一份 bwrap `.deb`。讽刺的是 `parseDistributionList` 已经解析出 `default: true`（`lib/connection.js:176`），做归一化是现成的。所有验收脚本都传真实 distro 名（m1:249、m5a:104/129、m5b:116），**空 distro 路径同样无覆盖**。

> 2026-10-01 复核：仍未修，且影响面扩大——M5b 后同一空段路径有三处消费（node `lib/connection.js:633`、helper `:836`、bwrap `:750`）。修复会把 `listDistributions` 带进连接路径，而它现在每次调用都全新 spawn `wsl.exe -l -v`（`lib/connection.js:151-154`），届时应按 ZCode 的 5 秒 TTL 缓存（`ZCode-main/packages/server/src/remote/wsl-detect.ts:8`）。**→ M5c-2 已修；TTL 缓存最终未加——归一化只在 `setup ??=` 内执行一次，连接生命周期内没有重复调用可缓存（YAGNI）。**

### 4.6.4 不适用（照搬会有害）

- **UNC 快速上传**：ZCode 对 `\\wsl.localhost\<distro>\…` 优先做文件系统复制、失败回退 `cat > file`（`wsl-backend.ts:197-265`）；dsh-wsl 一律走 stdin 流式写。但 dsh-wsl 的 `deployHelper` 额外做了**远端 `sha256sum` 回读校验**（`lib/connection.js:861-873`），这是 ZCode 没有的强度；换成 UNC 复制要小心别丢掉这层。
- **代理网关重写**：`wslProxy.ts` 解决的是「Windows 上的 loopback 代理在 distro 内不可达」（`wsl-backend.ts:163`）。dsh-wsl 默认 `push` 策略让 distro 完全不出网，只有 `distro` 策略才需要 egress。
- **Host 池与空闲回收**：ZCode 一个 Host 服务多个 workspace（`windowRemoteConnectionRegistry.ts:116,319`），dsh-wsl 是整 profile 单连接、随插件卸载释放（`index.js:93`），没有这个复杂度也不需要。
- **跨工作区身份/路由**：ZCode 的 `workspaceIdentity` 体系与按 workspace 的 Host 池，对应的正是 M4 已废弃的路线（§6.5）。

### 4.6.5 唯一有前瞻价值的借鉴点

§6 记录「裸 `pipe` 输出流与 duplex control 通道显式拒绝，因为需要第二条独立流通道，而 `wsl.exe` 给不了」。ZCode 在这一环提供的不是机制而是**探测纪律**：先探 loopback 可达性、再回退，并显式区分 mirrored networking 模式（`wsl-backend.ts:163-195`，纯函数在 `wslProxy.ts`）。这套「探测 + 有界回退 + 失败不阻断主流程」的写法，直接适用于将来「Windows 经 WSL2 localhost 转发连到 distro 内 TCP socket」的第二通道设计。**[推断]**

### 4.6.6 顺带发现的两个脚本问题 **[确证]**

1. 根 `package.json` 的 `"test": "node --test tests/"`。Node v24 把位置参数**当作 glob 模式**而不是目录枚举（`lib/internal/main/test_runner.js`：`options.globPatterns = process.argv.slice(1)`；`createTestFileList` 直接用 `new Glob(patterns, …)`），而默认只认 `**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs}` 这一组命名。`tests/m1-acceptance.mjs` 同时不满足「目录名为 `test`」和「文件名含 `test` 边界」两条，因此这条脚本**不会收集到任何验收文件**；§6 记录的统一跑法（逐个 `node tests/mX-acceptance.mjs`）才是有效的。若要修，把文件改名为 `test-m1.mjs` 之类，或把脚本改为显式逐个执行。
2. `"probe": "node tests/probe-m1.mjs"` 指向已删除的文件（§6 记录 `probe-m1` 已删，`tests/` 目录只剩 5 个 `*-acceptance.mjs`），是死引用。

> 2026-10-01 实测修正（第 1 条）：`node --test tests/` 在 Node v24.20.0 上的真实行为**不是静默收集零个文件**，而是把 `tests` 目录路径当作模块加载并**响亮失败**（exit 1，`Cannot find module '…\tests'`）。结论不变——脚本跑不到任何验收文件——但 CI 上会红而不是假绿，危害比原记录的低。

### 4.6.7 2026-10-01 复审：对账结果与本节漏掉的事项

对本节做了一次复审：§4.6.1–§4.6.6 引用的每一条 ZCode 证据都到源码重新核对（**全部属实**，含 `remoteDeployLock.ts:84-86` 的展开注释、`deploy.ts:438-441` 的 single-flight 注释、`zcodeAgentWrapperDeploy.ts:20-33` 的按字节上传），并通读了本仓库当前实现（`connection/provider/fs/subprocess/sandbox/index`）。复审发现：**三个借鉴项至今无一进入里程碑排期**，以及一个本节原本没有覆盖、恰好落在「ZCode 处理得最完整的领域」（断连检测与恢复）的真实回归。

**0. 死连接缓存回归 —— M4 教训在 M5a 重写中丢失 [高 → M5c-1 已修]**

M4 review 曾修过「`connect()` 永久缓存已 resolve 的值」（§6 缺陷表），但修复代码在被 M5a 删除的 `lib/realm.js` 里，**没有迁移到 `createWslRuntime`**。现状是三层缓存咬住死连接：

- `lib/provider.js:118-162`：`setup ??=` 只在 reject 时清缓存（`:154-159`）；**resolve 过但连接后来死了**会被永久返回。
- `lib/fs.js:188-191`、`lib/subprocess.js:392-395`：各自的 `#pending ??= this.connect()` 无死活检查——即使修好 `start()`，这两个 provider 还会各自咬住死连接不放。
- `lib/sandbox.js:75-84`：`confine` 每次调用重新 connect，无缓存——反而健康。
- `lib/connection.js:473-480` 的 `onClose()` **全仓库无消费方**；唯一读 `.closed` 的地方是 `status()`（`lib/provider.js:175`）。

后果链：helper 崩溃、`wsl.exe --shutdown`、distro 重启 → 连接 `#closed` → 之后每一次 `ctx.fs`/`ctx.subprocess` 操作永远收到 `IO_ERROR: connection is closed`，**整个 profile 变砖直到重载插件**。触发条件正是 §6 记录过的普通场景。123 项验收测试没有一条覆盖「连接死亡后下一次操作自动恢复」。

ZCode 的范本：连接层上报断连（`ZCode-main/packages/server/src/remote/connect.ts:235-245` 把 backend 断连并入 `onDidRemoteClose`），上层据此回收路由、下次使用时重建；缓存条目失败即删（`ZCode-main/packages/desktop/src/main/desktopWslTargetResolver.ts:63-68` 的 catch 删缓存——与本仓库 provider 的「reject 即清」同模式，缺的正是「已 resolve 但已死」的半边）。

**修法（三层都要动）**：`start()` 返回缓存前检查 `connection.closed`，失效则丢弃重建；订阅 `connection.onClose` 主动置 `setup = undefined`；`fs.js`/`subprocess.js` 的 `connection()` 对已 resolve 的 promise 做同样检查。回归守卫：kill helper 后下一次 `ctx.fs` 操作必须成功。

**三个小缺口（均低 severity，随 M5c 顺带修）：**

1. **stderr 未走双解码**：`runInDistro` 的 `stderrText` 原样 `toString('utf8')`（`lib/connection.js:124-125`）。`WSL_UTF8=1` 无效的构建上（M2 实测存在），wsl.exe 自身的错误（distro 名打错、WSL 未装）是 UTF-16LE，进错误消息即乱码。ZCode 对 stdout/stderr 统一走 `decodeWslOutput`。修法一行：`stderrText` 用现成的 `decodeWslText`。
2. **helper 启动参数未加引号**：`lib/connection.js:264-270` 把 `nodePath`/`helperPath` 裸放 argv；经 wsl.exe 默认 shell 重组（§4.6.3-2 同一条结论）后，homeDir 含空格即碎。ZCode 的全部远端路径都过 `quotePosixShellArg`。触发罕见，但本节既已引用那条 shell 重组结论，启动路径按同一纪律处理才自洽。
3. **一次性 provisioning 子进程不被 dispose 追踪**：ZCode 追踪全部 owned children 并在 dispose 时统一 kill（`ZCode-main/packages/server/src/remote/wsl-backend.ts:425`）；本仓库 `dispose()` 只管长驻 helper child，进行中的 `runWsl`（如 25MB tar 解包）会跑完。危害很小（只写部署目录，后续 start 有 reuse 检查），记录即可。

> 本节全部结论来自源码通读。**原会话未执行任何测试**：shell 被沙箱拦住（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\workspace\dsh\dsh-wsl)`），`pwsh` 无法启动，所以 §4.6.3 的三项停留在「源码证据 + 待实测」。2026-10-01 复审（§4.6.7）shell 可用，执行了最小探针（`node --test tests/` 行为实测，见上文修正）；§4.6.3 的三项仍未实测。

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
| M5b sandbox + UI | **完成** | `tests/m5b-acceptance.mjs` **14/14 通过**；distro 内 bwrap 后端，M5a 的「沙箱只报告不强制」缺口已关闭 |
| M5c 健壮性收口 | **完成** | `tests/m5c-acceptance.mjs` **11/11 通过**（1 项在无 TLS 出口环境下自报 SKIP）；§4.6.3 三项与 §4.6.7 全部落地，实施记录见「M5c 实施记录」 |
| M6 Skill/MCP/Plugin 同步 | 未开始 | — |
| M7 打包与 `install_bundle` | 未开始 | — |

### 已交付的文件

```
packages/dsh-wsl/
  package.json
  helper/
    protocol.js        # 生成物：lib/protocol.js 的同步副本（tools/sync-helper.mjs）
    fsio.mjs           # Cordis-free 文件原语：realpath 身份、版本 token、原子发布、字面编辑
    wsl-helper.mjs     # distro 内唯一的 dsh-wsl 进程（含 sandbox.confine：bwrap 包装）
  lib/
    protocol.js        # 权威帧协议：u32be 长度前缀 + JSON，64 MiB 上限，版本握手
    runtime.js         # 固定 Node v22.20.0 linux-x64 + 官方 SHA-256；固定 bubblewrap 0.12.0 (trixie) + SHA-256
    connection.js      # wsl.exe 传输、帧解码、心跳、租约、dispose、运行时供给、helper 部署、bwrap 供给（ensureBwrap）
    subprocess.js      # ctx.subprocess 实现 + 环境擦洗
    paths.js           # Windows ↔ WSL 路径翻译（纯函数、可逆、不可译即拒绝）
    fs.js              # ctx.fs 实现（同步构造、惰性连接、按需解析相对基准）
    sandbox.js         # ctx.sandbox 实现：confine(argv, policy) → bwrap 包装 argv，fail-closed
    provider.js        # createWslRuntime + provideHostServices（host 平面注册 fs/subprocess/sandbox）
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
  m2-acceptance.mjs    # 18 项
  m3-acceptance.mjs    # 52 项
  m5a-acceptance.mjs   # 11 项
  m5b-acceptance.mjs   # 14 项
  m5c-acceptance.mjs   # 11 项（含 1 项在无出口环境自报 SKIP）
```

**合计 134 项检查全绿。** 统一跑法：

```powershell
foreach ($m in @("m1","m2","m3","m5a","m5b","m5c")) { node "tests\$m-acceptance.mjs" }
```

### M5b 实测确证的事实

- **后端选型**：distro 内无 bwrap/firejail，securityfs 为空（Landlock 无法从 Node 直调），但非特权 userns 可用、`deb.debian.org` 可达 → 选 **bubblewrap**（Debian trixie 官方包 `0.12.0-1~deb13u1`，仅提取 `usr/bin/bwrap` 推进用户部署目录，**不装系统**；其依赖 libc6/libcap2/libselinux1 是 trixie 基础系统的成员）。
- **方言与宿主后端一致**：profile argv、`enforcement: 'full'`、denial `read-only file system`、runner-failure `bwrap: ` 全部照抄 `dsh-sandbox-local` 的 bwrap 分支，消费方无法从行为上区分两个后端。
- **沙箱 mode 现在是真强制**：M5a 记录的「`sandbox-local` 被禁用后 mode 只报告不强制」缺口由本里程碑关闭 —— `ctx.sandbox` 在 distro 内用 bwrap 落实 file-effect policy，不可用即 fail-closed `SANDBOX_UNAVAILABLE`（经 `appCode` 带外通道，与 `FS_*` 同路）。
- **`--tmpfs /tmp` 的语义边界**：workspace-write 下 `/tmp` 是每次 confinement 独立的 tmpfs —— 私有临时目录可写，但不持久、也不与 `ctx.fs` 共享；持久的工作区写在 `workspaceRoot`（消费方按 seam 传 canonical 路径）。因此验收测试的 workspace 放在 home 下。
- **workspaceRoot 在 helper 侧 realpath 化**：bind 落在真实 inode 上，符号链接根也被正确授写；`--ro-bind /` 之下 home 内的链接在沙箱内仍可见（`/tmp` 下的链接则被 tmpfs 藏掉 —— 见上一条）。
- **供给幂等**：`ensureBwrap` 与 `ensureRuntime` 同模式 —— 已部署且可执行则复用；Windows 侧缓存 `.deb` 并按固定 SHA-256 校验后原子发布。

### M5c 实施记录与实测确证的事实

M5c 按审查排期分四个 commit 落地（死连接恢复 → distro 归一化 → 互斥锁 → 传输修复）。

- **死连接恢复（§4.6.7-0）**：`connection.onClose` 清 `setup`/`connection` 缓存；fs/subprocess 的 `connection()` 对已 resolve 但已死的连接丢弃重连。回归守卫在 kill helper 后断言 `start()` 重建出**新 pid** 的连接、fs 消费者下一次操作成功；fs 层守卫被验证在撤销 fs.js 修复时确实变红（不是同义反复）。
- **THE TRANSPORT FACT（§4.6.3-2 从推断升级为确证）**：探针实测 `x=hi; printf %s "$x"` 与 `y=$(echo sub)` 经 `wsl.exe -- bash -lc` 后都返回**空串**——局部变量确实在真正的 shell 执行前被外层默认 shell 展开为空，ZCode 的记录在本机成立。`distro` 策略脚本改为纯 host 计算的带引号字面量（顺手删掉了 mktemp 机制）；测试钉住这一平台事实；distro 内无 TLS 出口时该策略检查自报 SKIP 而非失败。
- **启动引号新事实**：helper 启动从多 argv 改为**单条 `bash -lc` 命令**。原多 argv 形态在路径含空格时坏掉：Node 的 Windows 命令行 join 把单引号元素再包一层**双引号**，wsl.exe 交给默认 shell 后双引号被剥掉、字面单引号留在文件名里 → `ENOENT`（127）。这是 spaced-home 检查当场抓到的真实 bug，不是理论推演。
- **互斥锁（§4.6.3-1）**：`withProvisionLock` 用 POSIX `mkdir` 原子性做 distro 侧锁（约 40 行）：胜者供给、败者轮询、超过 5 分钟视为死持有者夺锁；并发串行化与夺锁都有实测检查。第一版漏了父目录 `mkdir -p`，全新 home 上锁目录永远建不出来、等待者误判 busy 等满超时——被 spaced-home 检查抓住后修复。Windows 侧下载暂存名带 pid，并发下载不再互写同一 `.partial`。
- **归一化（§4.6.3-3）**：空 distro 在 `start()` 内解析为系统默认的真实名字（`default` 标记优先，否则第一个），node/helper/bwrap 三件套全部落进 canonical 的 `~/.local/share/dsh-wsl/<distro>/` 目录；`runtime.distro` getter 供 fs 的 UNC 映射经 thunk 读取（空 distro 不再退化成 `\\wsl$\localhost\…`）。
- **stderr 双解码（§4.6.7-1）**：`runInDistro` 的 stdout/stderr 统一走 `decodeWslText`。
- **出口事实更新**：本环境 distro 内对 nodejs.org 的 TLS 也被阻断（`curl (35) unexpected eof`），与 M2 记录的 `registry.npmjs.org` 阻断同类——`push` 默认策略再次被证明是正确选型。会话末期主机侧对 nodejs.org 也出现 TLS 拦截（`SEC_E_WRONG_PRINCIPAL`），因此 spaced-home 检查改为从 canonical 树 `cp -a` 预置、`distro` 策略检查自报 SKIP，整套 m5c 对主机出网零依赖。
- **部署根统一到 `~/.dsh_wsl/`**：distro 侧所有 dsh-wsl 文件收进一个可见、一条命令可清空的目录——部署树 `~/.dsh_wsl/<distro>/`（node/helper/bwrap，helper 仍按自身位置相对解析 bwrap，整体搬移无损）、供给锁 `~/.dsh_wsl/.<distro>.lock`、测试残渣 `~/.dsh_wsl/.scratch/`。`migrateLegacyDeployRoot` 把旧 XDG 路径 `~/.local/share/dsh-wsl/<distro>` 一次性 rename 进来（同文件系统零成本；旧树缺失或新树已存在时为 no-op），在供给锁内执行。实机迁移已执行，distro home 里 `.local/share/dsh-wsl` 不复存在。/tmp 下的测试文件保持原位——tmpfs 自清且测试 finally 自删。
- **记录不动（§4.6.7-3）**：一次性 provisioning 子进程仍不被 dispose 追踪——按审查结论维持「只记录」，危害上界是写完部署目录后被 reuse 检查收敛。

### M5b 诚实记录的代价与缺口

- **`danger-full-access` 不经 confine**：与 seam 契约一致（消费方自行 bypass）；provider 收到该 mode 会显式拒绝而非降级。
- **网络与进程可见性不在承诺内**：bwrap 的 `--unshare-pid` 隔了 PID 视图，但 file-effect 词汇表本就不含网络 —— 与参考实现相同。
- **内核依赖非特权 userns**：WSL 内核若收紧 `user.max_user_namespaces` 或关闭 userns，probe 会失败并 fail-closed；此时 sandbox 不可用是显式错误，不是静默裸跑。

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
| 5 | `ctx.sandbox` provider 抽象基类的导出名 | **已解决**（M5b） | seam 为 `SandboxProvider.confine(argv, policy) → ConfinedArgv`（argv 包装，非执行）；本插件以普通对象注册 `sandbox`，与 fs/subprocess 同法 | `@deepseek-ai/dsh-sandbox` 的 `.d.ts` |
| 6 | `wsl.exe` stdio 是否可靠承载长连接分帧（无内层 TTY 竞争） | 未决 | M1 的成败前提 | M1 用最小 echo/uname 往返实测 |

**下一步动作**：安装 seam 包（`dsh-fs`、`dsh-subprocess`、`dsh-sandbox`、`dsh-scope`、`cordis`）到开发 workspace，从 `lib/types/**/*.d.ts` 读权威类型，消解 4、5；再做 M1 的 `wsl.exe` 往返实测消解 6。
