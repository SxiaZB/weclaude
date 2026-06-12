# weclaude 上手指南

3 步在一台新机器上把「IM 授权转发 + 远程 CC 控制」跑通。

## 前置

- Node ≥ 20
- 已安装 `claude` 或 `claude-internal`
- 一个企业微信「智能机器人」：拿到 `botId` 和 `secret`
  - 创建入口：企业微信管理后台 → 应用管理 → 智能机器人

## 步骤

```bash
# 方式 A：npm 全局安装（推荐）
npm install -g weclaude
weclaude init

# 方式 B：免安装一次性试用
npx weclaude init

# 方式 C：本地开发
git clone <repo> && cd weclaude
npm install && npm run build
./cli/weclaude.sh init
```

> ⚠️ 卸载时**先**跑 `weclaude uninstall`（unsync settings.json + 卸载 daemon），**再** `npm uninstall -g weclaude`。否则 launchd/systemd 会反复尝试启动已删除的二进制。
> `~/.weclaude/` 下的 config/secrets/state 不会被清掉，二次安装可无缝复用。

### [1/3] 采集配置

交互式问 4 个值：

| 字段 | 写到 |
| --- | --- |
| botId | `~/.weclaude/secrets.json` |
| secret | `~/.weclaude/secrets.json` |
| Claude agent | `~/.weclaude/config.jsonc` (`wrc.claudeBin` + `sync.targets[0].settingsPath`) |
| 是否启用 PreToolUse hook | `~/.weclaude/config.jsonc` (`approval.enabled`) |

Agent 选项：

- `claude` → 写到 `~/.claude/settings.json`
- `claude-internal` → 写到 `~/.claude-internal/settings.json`
- `custom` → 你给的绝对路径

`secrets.json` 和 `config.jsonc` 在 `loadConfig` 里 deep-merge，方便把 `config.jsonc` dotfile 化但 secrets 留在本机。

完成后自动：
1. `npx tsc` 编译 dist
2. `weclaude sync` 把 hook / MCP / env 写进选定的 settings.json
3. 安装常驻 daemon（macOS launchd / Linux systemd --user）
4. 等 WebSocket 鉴权通过

### [2/3] 绑定默认会话

CLI 提示你**在企业微信里**给机器人发：

```
将本对话设置为默认会话
```

Daemon 在内存里临时打开 claim 窗口（10 分钟）。这条消息精确匹配后：

- 把发送方 principal（`user:<id>` 或 `chat:<id>`）写到 `defaultChat`
- 把同一个 principal 加进 `wrc.allowFrom`（去重）
- 落盘 + 同步内存里的 cfg 对象
- 给你回一条 markdown ack

这一步是**唯一一次**绕过 `allowFrom` 检查的入口；消费完立刻关闭。后续所有消息严格按 `allowFrom` 鉴权。

### [3/3] 授权转发演示

CLI 自动 `spawn claude -p` 跑一条三步指令：

```
1. Bash: echo hello world from weclaude    ← 触发 PreToolUse hook
2. Bash: sleep 3                           ← 再触发一次
3. wecom__send_markdown                    ← 通过 MCP 主动推送结果
```

期望体验：

- IM 收到按钮卡片：`授权请求: Bash`
- 点 ✅ → 卡片就地刷新成 `✅ Bash · 已允许`
- 3 秒后再来一张卡片（或被 5 分钟自动窗口短路）
- 最终收到 `✅ weclaude 演示完成：hello world`

如果第 1 步选「不开 hook」，会跳过演示。

## 完成后

```bash
weclaude status              # daemon + WS 健康
weclaude logs -f             # 实时日志
weclaude send <chat> <text>  # 主动推消息
weclaude unsync              # 卸载 hook/MCP（保留 daemon）
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `daemon: down` | `weclaude reload`；看 `~/.weclaude/daemon.stderr.log` |
| 发完暗号 daemon 没反应 | 检查 `weclaude status` 的 `wsConnected` 是不是 true；机器人 `secret` 错会卡在 auth |
| Hook 不触发 | `cat ~/.claude/settings.json | jq .hooks.PreToolUse`；`weclaude sync` 重写 |
| 卡片点了没反应 | 5 秒内才能就地更新；超时是正常情况，决策仍然生效 |
| MCP 调用 404 | `mcpServers.wecom._managedBy=="weclaude"` 应在 settings.json；`weclaude sync` 修复 |

## 多机部署

`config.jsonc` 可以纳入 dotfiles；`secrets.json` 每台机器独立填。`init` 跑过一次后，第二台机器：

```bash
cp ~/dotfiles/weclaude-config.jsonc ~/.weclaude/config.jsonc
./cli/weclaude.sh init    # 跳过覆盖提示，但仍走 claim 步骤拿到本机的 IM principal
```
