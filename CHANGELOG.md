# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- `mcp`: 新增 `subscribe_topic` / `broadcast_topic` tool — agent 自主订阅 topic 与广播,与 IM 命令「订阅」「广播」共用同一订阅表。
- `mcp`: 新增 `handoff` tool — 原地把一个 pane 的会话交接给全新会话。
- `mirror`: prompt-cache 保活心跳 — 空闲 pane 在缓存过期前廉价续命；心跳记入 chat detail，留痕含真实 cache-read usage。
- `approval`: 新增 `danger.skip` — 命中危险名单也免卡直接放行。

### Changed
- `mirror`: `/stop` 暂停保活 + 明确终止语义。

### Fixed
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

[Unreleased]: https://github.com/guxi11/wezard/compare/v1.1.4...HEAD
[1.1.4]: https://github.com/guxi11/wezard/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/guxi11/wezard/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/guxi11/wezard/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/guxi11/wezard/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guxi11/wezard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guxi11/wezard/releases/tag/v1.0.0
