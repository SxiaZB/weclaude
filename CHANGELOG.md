# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.2.8] - 2026-08-05

### Fixed
- `inbound`: `#tag` 后夹一个不可见格式字符(输入法/复制常带的 `U+2060` word-joiner、零宽空格等)时,tag 右边界断言 `(?=\s|$)` 落空 —— 整个 `TAG_RE` 不匹配,`parseTag` 返回空 tag,消息被误路由到**默认会话**而非目标 `#tag` 会话。右边界字符类补入零宽(`U+200B–200D`)、word joiner(`U+2060`)、BOM(`U+FEFF`),与空白同等视作合法分隔。

## [1.2.7] - 2026-08-01

### Fixed
- `mirror`: KeepAlive 轮次计数卡在 `1/N` —— 1.2.6 把调度改用消息时钟后,`grewSinceLast`(轮次重置 + 真实活动重锚的判据)错用了 `lastMs`(**含保活自己的 ping/pong**)。心跳的 ping+pong 也是消息 turn,会推高 `lastMs`,在交互式会话里 pong 隔几秒才生成、时序有缝,导致下一个非 pinging tick 把自己的心跳误判为「新活动」而把 `round` 归零,`n` 永远爬不过 1。改为只看 `lastRealMs`(已滤除 ping/pong):纯保活期间轮次正常累加 `1/N→2/N→…`,只有真实对话才重置。

## [1.2.6] - 2026-07-31

### Fixed
- `mirror`: **保活调度彻底改用消息 turn 时间戳,不再依赖文件 mtime**。Claude Code 每轮会往 jsonl 追加 `file-history-snapshot` / `ai-title` / `mode` / `permission-mode` 等**无 `timestamp` 的非消息行**,它们顶高文件 mtime 却不代表任何真实对话。旧逻辑 `idleSinceTouch` / `realIdle` / `grewSinceLast` 全建立在 `statSync(mtime)` 上,于是这些元数据写入被误判为「活跃」:`grewSinceLast` 每周期重锚 `realMtime` 使 `realIdle` 永不过 `maxIdleSec` —— **真实对话在数小时前的死会话被无限保活**(daemon 每次启动/reload 还会把「末行是 ping」的死会话集体复活)。现新增 `keepaliveStamps` 从消息 turn 取 `lastMs`(最后一条消息=缓存触碰)/`lastRealMs`(最后一条非 ping/非 pong=真实空闲基准),文件 mtime 仅作「要不要重读 tail」的廉价闸门;tail 内无真实 turn ⇒ 判死。移除 `realMtime` 字段;`n/N` 分母按实际 cadence(`ttlSec-marginSec`)floor 计。
- `mirror`: `/stop` 暂停保活现**持久化**(`keepaliveOff` / `keepaliveOffAt` 写入 `mirror-attachments.json`),daemon reload / launchd 重启不再复活一个被用户显式静音的会话;真实 inbound 或 busy-resume 解除时同步落盘。

## [1.2.5] - 2026-07-31

### Added
- `mcp`: 新增 `config_set` tool — 在对话中直接读写 wezard 配置（allowFrom、审批时间窗口、danger skip、cwd、log level 等），无需手动编辑 config.jsonc。

## [1.2.4] - 2026-07-31

### Changed
- `mirror`: KeepAlive 心跳通知带回轮次计数 —— 从 `KeepAlive · ~Nk tokens` 恢复为 `KeepAlive n/N · ~Nk tokens`。`n` = 上次真实（非 ping）活动以来的 ping 轮数（真实活动重新锚定时归零），`N` = 当前配置下缓存冷掉前的最大保活轮数。1.2.1 随 `maxPings`→`maxIdleSec` 一并去掉的 `n/max`，现按需求改以派生分母回归。

## [1.2.3] - 2026-07-31

### Fixed
- `mirror`: `/stop` 暂停保活的第二个自我唤醒漏洞 —— 1.2.0 给 busy-resume 加了 grace，但 `grewSinceLast`（transcript 增长）分支没有守卫。`/stop` 的 Esc 打断会产生尾部写入（被中断的 turn + 残留 tool result），下一个 tick 把它当成真实活动立刻解除刚请求的暂停，KeepAlive 照常触发。现在纯 transcript 增长不再解除 `/stop` 暂停，只有 busy pane（过 grace）或 WeCom inbound 能恢复。

## [1.2.2] - 2026-07-31

### Fixed
- `mirror`: tagged-only chat（无 untagged 默认会话）中 `enter` 设置 cwd 后 `/clear` 不触发目录切换 — `chatCwdFallback` 只读 base principal，base 不存在时返回空；dispatch 和 newSession 现在都 fallback 到 caller 自身的 `pendingCwd`。

## [1.2.1] - 2026-07-31

### Changed
- `mirror`: 保活调度改为**锚定最后一次真实（非 ping）对话** — 保活自己的 ping 不再刷新空闲锚点，因此不会把一个搁置很久的会话误判成活跃而无限续命。真实空闲超过 `maxIdleSec`（新配置，默认 = `ttlSec` 5min）即停手，让缓存自然冷掉；reload 时若 transcript 末轮是自己的 ping，则视作早已空闲、不重新烧热。配置项 `maxPings` 移除，替换为 `maxIdleSec`（保活功能在 1.2.0 刚发布，此为随即修正）。聊天心跳去掉 `n/max` 计数，只显示 `❤️ 保活 · context ~Nk tokens`。

## [1.2.0] - 2026-07-31

### Added
- `mcp`: 事件订阅/广播全面 MCP 化 — 新增 `subscribe_topic` / `unsubscribe_topic` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` / `list_topics`,直接对 AI 说人话即可订阅/广播/定时。
- `mcp`: 新增 `handoff` tool — 原地把一个 pane 的会话交接给全新会话。
- `mirror`: prompt-cache 保活心跳 — 空闲 pane 在缓存过期前廉价续命；心跳记入 chat detail，留痕含真实 cache-read usage。
- `approval`: 新增 `danger.skip` — 命中危险名单也免卡直接放行。

### Changed
- `mirror`: `/stop` 暂停保活 + 明确终止语义。

### Removed
- **BREAKING** `topics`: 移除订阅/广播的 IM 文本命令(「订阅」「广播」「每天…广播」「取消广播」「订阅列表」「广播列表」)及 `/skill-b`,全部改由 MCP 工具驱动。`POST /publish` 外部触发接口保留。

### Fixed
- `mirror`: `/stop` 暂停保活失效 — 保活自身的 ping 会让 pane 变 busy，而 busy 被当成「真实活动」立刻解除暂停；改为对 busy-resume 加 30s grace 窗口，只有暂停后真正的新一轮才恢复（WeCom dispatch 仍即时恢复）。
- `sync`: 为 CodeBuddy targets 把 MCP entry 写入 `mcp.json`。
- 发布包补齐 svr plist/service 模板。

## [1.1.4] - 2026-07-31

### Fixed
- `approval`: reload 续接 — 重启时挂着的审批不再 fallback 成本地权限框。

## [1.1.3] - 2026-07-31

### Added
- `approval`: 新增 `danger` 模式 — 只对危险名单发卡,其余静默放行。

### Changed
- `mcp`: 重命名 `cd` 工具为 `enter` — 更贴合实际语义。

## [1.1.2] - 2026-07-30

### Added
- `approval`: codebuddy 下 `AskUserQuestion` / `ExitPlanMode` 由 mirror 接管下发卡片。
- `detail`: detail/chat url 参数加 `ww_uniq=1`。

## [1.1.1] - 2026-07-30

### Changed
- `approval`: 危险名单移除普通 `git push` — 仅保留强推等不可逆操作。

## [1.1.0] - 2026-07-30

### Added
- `chat`: 上下文断点可见化 — `/clear`、`/new`、会话轮换在线程里显式分隔。

## [1.0.0] - 2026-07-29

首个稳定版:项目更名 `weclaude` → `wezard`。

### Changed
- **BREAKING**: 项目更名 `weclaude` → `wezard`,新增 `wezard migrate` 迁移命令。
- `init`: 本地拉起 svr,详情/会话链接默认走内网 IP。

### Added
- `approval`: 危险操作名单 — 命中者强制逐次单独审批。
- `session-scan`: 通过 `ps` + `lsof` fallback 支持 macOS。

### Fixed
- `chat`: 修复移动端滚动 — `.main` 加 `min-height:0`,叠加 overscroll + safe-area。

[Unreleased]: https://github.com/guxi11/wezard/compare/v1.2.7...HEAD
[1.2.7]: https://github.com/guxi11/wezard/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/guxi11/wezard/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/guxi11/wezard/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/guxi11/wezard/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/guxi11/wezard/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/guxi11/wezard/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/guxi11/wezard/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/guxi11/wezard/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/guxi11/wezard/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/guxi11/wezard/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/guxi11/wezard/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/guxi11/wezard/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guxi11/wezard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guxi11/wezard/releases/tag/v1.0.0
