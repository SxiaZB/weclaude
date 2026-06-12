# Init flow 设计

## 目标

让没改过任何 dotfile 的新用户，从 `git clone` 到「在企业微信点按钮放行 Claude 写文件」少于 5 分钟，零手工编辑配置。

## 三个被忽略的难点

### 1. allowFrom 的鸡生蛋

正常运行时 daemon 严格按 `wrc.allowFrom` 白名单转发；用户不在白名单里就被丢弃。但**第一次**用户的 IM userid 还没被任何人知道（你不能预填，你不知道自己企业微信 userid 是多少）。

**方案**：daemon 加 `claim` 模式。短窗口内（10 min），匹配指定暗号的第一条消息绕过 allowFrom，把发送方的 principal 同时写进 `defaultChat` 和 `allowFrom`。一次性消费。

为什么不让用户先去后台查 userid 填进 config：

- 用户体验断点。打开管理后台找 userid 是个高摩擦动作。
- 群聊 chatid 在后台根本看不到，必须从消息流里捞。
- 反正消息进来时 daemon 已经知道 principal；让它自己写比让人抄稳。

**为什么不直接关掉 allowFrom 让任何人都能用**：会被任意外部联系人触发 `claude -p` 跑代码。安全模型必须保留白名单，bootstrap 是唯一豁免点，且单次。

### 2. 密钥不能进 dotfile repo

如果 `config.jsonc` 整个塞进 dotfile，`secret` 就会进 git。

**方案**：复用 `loadConfig()` 里早就有的 `secrets.json` deep-merge 钩子。init 时把 `botId/secret` 写到 `~/.weclaude/secrets.json`，其他写 `config.jsonc`。两份文件运行时合并。`config.jsonc` 可入 dotfiles，`secrets.json` 留本机。

### 3. 配置写入要保留注释

`config.example.jsonc` 是带注释的 JSONC，新手要靠注释理解每个字段。如果 init 用 `JSON.parse` + `JSON.stringify` 重写，注释全没。

**方案**：用 `jsonc-parser.modify` 做外科级 patch（已经是 `cli/sync.ts` 的依赖）。只动指定 path 的值，其他字节保留。

```ts
patchJsonc(CONFIG, [
  { path: ["bot", "websocketUrl"], value: "wss://..." },
  { path: ["wrc", "claudeBin"], value: claudeBin },
])
```

## 三步划分的依据

不是三步随便选的，是**必须**三步：

| 步 | 干什么 | 必须独立的原因 |
| --- | --- | --- |
| 1 | 写 config + 装 daemon | daemon 起不来后面都不用谈 |
| 2 | 跨进程 IM 握手 | 必须等真人在另一个客户端发消息，是异步的等待点 |
| 3 | 端到端 smoke | 验证授权链路和 outbound 链路双向通 |

把第 2 步合并进第 1 步是不行的——daemon 必须先完整启动并连上 WS，才有人接得到那条暗号。

把第 3 步省掉是不行的——hook + MCP + WS + 进程产物链路只有一种验证方式：让 Claude 真的跑一次。装好不演示，第一次真用还是会踩坑。

## 为什么没用 ink

考虑过 ink，否决理由：

- 当前仓库纯 TS，无 React，无 JSX，tsconfig 没开 `jsx`。引入 ink → 加 `react`、`@types/react`、改 tsconfig、新建 `.tsx` 文件，体积和复杂度都涨。
- 这个流程是**严格顺序**的 4 个 prompt + 几段 status 输出，没有并发可视化、没有持久面板、没有键盘焦点。这是 inquirer 的舒适区，不是 ink 的。
- `@inquirer/prompts` 函数式 API（`await input(...)`、`await select(...)`）和仓库里其他模块的风格一致：纯函数 + 副作用推到边界。

如果以后要做 daemon dashboard / 任务队列实时面板，再上 ink。现在先不上。

## claim 模式的状态机

```
        POST /claim/start
          │
   ┌──────▼──────┐
   │ ARMED       │ phrase, expiresAt
   └──────┬──────┘
          │
   ┌──────┴──────┬─────────────┐
   │             │             │
 inbound       TTL          POST /claim/reset
 matches       expires           │
   │             │               │
   ▼             ▼               ▼
CLAIMED       (cleared)      (cleared)
   │
   └─→ persistClaim(cfg, sourcePath, principal)
       └─→ defaultChat = principal
           allowFrom += principal     ← 同时改磁盘 + 改内存
       └─→ ackClaim(client, principal)
```

`state` 是模块级单例，单实例 daemon 不需要锁。如果以后要多 worker，state 要挪进 daemon 共享存储——但 WS 客户端本身就是单连接的，不会有这个问题。

## 演示选什么 prompt

```
1. Bash: echo hello world from weclaude
2. Bash: sleep 3
3. wecom__send_markdown chat="<defaultChat>" content="✅ ..."
```

设计取舍：

- **必须用 Bash 工具**，因为 `approval.matcher = ".*"` 默认全拦，但 `pre-tool-use.sh` 里对 `Bash` 的只读命令（grep/ls/cat...）有 fast-path 直接 allow。`echo` 不在 fast-path 里，会真触发卡片。
- **第二次 sleep** 是为了让用户看到「点了一次 ✅，下一次还会问」是默认行为；如果他想免打扰可以点 `✅ N 分钟` 开窗口。
- **MCP send_markdown** 而不是 `claude` 自己 print：验证的是「主动推送回 IM」这条链路，普通 print 只回流到终端。

prompt 里**显式拼出 chat id**而不是依赖 LLM 推断「default chat」，因为：MCP 工具签名要求 `chat` 是显式 string，没有「default」概念。让 LLM 猜是不必要的脆弱性。

## 失败模式

| 场景 | init 行为 | 状态可恢复性 |
| --- | --- | --- |
| 用户 Ctrl-C 在 prompt 中 | 进程退出，未写任何文件 | ✅ 完全干净 |
| 写完 config 但 daemon 起不来 | 抛 `daemon did not become ready` | ✅ config 保留，下次 `weclaude reload` 即可 |
| Claim 超时 | 报「超时未收到消息」并退出 | ✅ daemon 还在跑，可手填 config 或重跑 init |
| 演示 spawn `claude` 失败 | 红字打印 spawn 错误，正常退出 | ✅ 前两步成果都保留 |

没有「半完成」的中间状态需要回滚。

## 后续可能的改进

不在本次范围，但留给未来：

- `weclaude init --reset` 一键清空（unsync + uninstall daemon + 删 ~/.weclaude）
- claim 暗号支持自定义（防多人共用同一台 daemon 的暗号冲突）
- 演示步骤后做一次 `weclaude status` 的彩色断言，给用户一个「绿色对勾合集」
- ink 化的 daemon dashboard（独立工具，`weclaude tui`）
