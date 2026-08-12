// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { loadConfig } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { bindCliBackends, type CliBackendName } from "../shared/cli-backends.js";
import { startWs } from "./ws.js";
import { startHttp, json } from "./http.js";
import { installInboundRouter } from "./inbound.js";
import { loadSessionStore } from "./sessions.js";
import { loadMirrorStore } from "./mirror-store.js";
import { makeBridge } from "./cc-bridge.js";
import { startMirror, installMirrorEventListener, type MirrorBridge } from "./mirror-bridge.js";
import { setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { installApprovalEventListener, makeApproveHandler } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward } from "./detail.js";
import { initAutoWindowPersistence } from "./session-cache.js";
import { makeMessageHandler } from "./outbound.js";
import { makeCardHandler, makeAskHandler, installAskEventListener } from "./ask.js";
import { drainForReload } from "./pending.js";
import {
  makeClaimStartHandler,
  makeClaimStatusHandler,
  makeClaimResetHandler,
} from "./claim.js";
import { makeWedocBridge } from "./wedoc.js";
import { installResponseTracker } from "./last-response.js";
import { scanClaudeSessions } from "./session-scan.js";
import {
  startScheduler,
  publish as publishTopic,
  subscribe as subscribeTopic,
  unsubscribe as unsubscribeTopic,
  listSubs,
  listSchedules,
  addSchedule,
  removeSchedulesByTopic,
} from "./topics.js";
import { baseOfKey, keyOf, withTagHeader } from "../shared/session-label.js";
import {
  startGraph,
  stopRun,
  getRun,
  listRuns,
  validateSpec,
  waitForIdle,
  type GraphSpec,
  type GraphNodeSpec,
  type GraphStepSpec,
} from "./graph.js";

// pino's file transport is async; without flush, log.fatal before process.exit
// vanishes. Mirror anything fatal to stderr too so launchd's stderr.log captures it.
const fatalExit = (msg: string, extra?: Record<string, unknown>): never => {
  // eslint-disable-next-line no-console
  console.error(`[wezard-daemon] FATAL: ${msg}`, extra ?? "");
  process.exit(1);
};

const main = async (): Promise<void> => {
  const { config: cfg, sourcePath } = loadConfig();
  const log = makeLogger({
    logFile: cfg.daemon.logFile,
    logLevel: cfg.daemon.logLevel,
    name: "wezard-daemon",
  });
  log.info({ sourcePath, pid: process.pid }, "daemon start");

  // Bind the CLI backend registry. `primary` (= defaultCli) drives new-session
  // spawns; `backends` is every installed CLI whose transcript root exists, so
  // sessions from all of them can be mirrored concurrently — each attachment
  // derives its dialect from its own jsonl path. Must run BEFORE any mirror
  // attach / tmux spawn.
  const { primary, backends } = bindCliBackends({ ...cfg.wrc, projectsDirOverride: cfg.wrc.mirror.projectsDir });
  log.info({ primary: primary.name, bin: primary.bin, backends: backends.map((b) => b.name) }, "cli backends bound");

  // A killed-on-timeout tmux call is the ONLY externally visible symptom of a
  // wedged tmux server, and the exec helper has no logger of its own. Wire it
  // up before anything can spawn a pane.
  setTmuxTimeoutReporter(({ args, timeoutMs }) =>
    log.warn({ args: args.slice(0, 4), timeoutMs }, "tmux command timed out — killed"),
  );

  // Restore auto-approve windows persisted across daemon restarts —
  // otherwise a `wezard reload` silently drops the user's "10min" choice.
  initAutoWindowPersistence(cfg.daemon.stateDir);
  // Replay tool/approval detail records so reload doesn't lose click-to-detail
  // links from messages already on the user's WeCom timeline.
  initDetailPersistence(cfg.daemon.stateDir, log.child({ mod: "detail" }));
  configureRemoteForward(cfg.daemon.detailRemoteBase, cfg.daemon.detailRemoteToken);

  const ws = startWs(cfg, log);
  // Wrap replyStream / replyStreamWithCard before any module sends —
  // last-response tracker enables inbound's `quote` dedup of bot self-replies.
  installResponseTracker(ws.client);
  const sessions = loadSessionStore(cfg.wrc.sessionMapFile);
  const mirrorStore = loadMirrorStore(cfg.wrc.mirror.attachmentsFile);
  const bridge =
    cfg.wrc.mode === "mirror"
      ? startMirror({ cfg, log: log.child({ mod: "mirror" }), client: ws.client, store: mirrorStore })
      : makeBridge({ cfg, log: log.child({ mod: "bridge" }), client: ws.client, sessions });
  if (!bridge) {
    log.fatal("bridge failed to start");
    fatalExit("bridge failed to start");
  }
  installInboundRouter(ws.client, cfg, log, bridge, sourcePath);
  // approval click → finalize 当前 liveStream, 后续 tool/text 落到 standalone。
  // 规则 2: 用户点击授权那一刻就是"上一段对话"的边界, 截断 stream 让授权后的
  // 工作单独成块, 比让 stream 一直长到下一个 inbound / hardTimer 更清晰。
  // headless 模式没有 liveStream 概念, onApproved 只在 mirror 模式接。
  const onApproved =
    cfg.wrc.mode === "mirror"
      ? (sid: string): void => (bridge as MirrorBridge).terminateLiveStream(sid)
      : undefined;
  installApprovalEventListener(ws.client, log.child({ mod: "approval" }), cfg, onApproved);
  // In mirror mode, route approval cards to the WeCom chat bound to the requesting session.
  // Falls back to cfg.approval.approvers / cfg.defaultChat when no mirror is attached.
  const getMirrorTarget =
    cfg.wrc.mode === "mirror"
      ? (sid: string): string | undefined => (bridge as MirrorBridge).targetForSession(sid)
      : undefined;
  // Pre-card barrier: drain pending mirror text/tool markdown for this session
  // and await its FIFO so vote/approval cards never overtake the "thinking" bubble.
  // Headless mode has no mirror pipe — leave undefined so approval skips the call.
  const flushBeforeCard =
    cfg.wrc.mode === "mirror"
      ? (sid: string, expect?: { toolName: string; toolInput: unknown }): Promise<void> =>
          (bridge as MirrorBridge).flushBeforeCard(sid, expect)
      : undefined;
  const http = startHttp({ cfg, ws, log, sourcePath });
  http.register(
    "POST /approve",
    makeApproveHandler({ cfg, log: log.child({ mod: "approval" }), client: ws.client, sourcePath, getMirrorTarget, flushBeforeCard }),
  );
  http.register("POST /message", makeMessageHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /card", makeCardHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /ask", makeAskHandler(ws.client, log.child({ mod: "ask" })));
  // 事件订阅广播: 外部脚本/CI 可 curl :17890/publish 触发一次广播,不用关心订阅者。
  http.register("POST /publish", async (req, res) => {
    const { readBody } = await import("./http.js");
    const body = (await readBody(req)) as Partial<{ topic: string; markdown: string; text: string }>;
    const topic = (body.topic ?? "").trim();
    const content = body.markdown ?? body.text ?? "";
    if (!topic || !content) { json(res, 400, { ok: false, error: "topic and markdown/text required" }); return; }
    if (!ws.client.isConnected) { json(res, 503, { ok: false, error: "ws_disconnected" }); return; }
    try {
      const r = await publishTopic(ws.client, cfg, log.child({ mod: "topics" }), topic, content);
      json(res, 200, { ok: true, ...r });
    } catch (e) {
      json(res, 502, { ok: false, error: (e as Error).message });
    }
  });
  http.register("POST /claim/start", makeClaimStartHandler({ log: log.child({ mod: "claim" }) }));
  http.register("GET /claim/status", makeClaimStatusHandler());
  http.register("POST /claim/reset", makeClaimResetHandler());
  http.register("GET /detail", makeDetailHandler(log.child({ mod: "detail" })));
  for (const [key, handler] of Object.entries(chatHandlers())) http.register(key, handler);
  installAskEventListener(ws.client, log.child({ mod: "ask" }));

  // 智能机器人 doc / smartsheet / contact MCP 桥接 — 总是注册路由, 失败让
  // 错误透传到上游 (Claude / curl)。requesterUserId 解析顺序:
  // 调用方 body.requesterUserId → defaultChat 里 user:<id> 部分 → 不传
  // (server 侧会拒, 错误消息原样回去, 比 daemon 提前判更透明)。
  {
    const wedocLog = log.child({ mod: "wedoc" });
    const bridge = makeWedocBridge({
      client: ws.client,
      log: wedocLog,
      pluginVersion: "wezard-0.1",
      cacheTtlMs: 30 * 60_000,
      configFetchTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
    });
    const fallbackUserId = (): string | undefined => {
      const dc = cfg.defaultChat.trim();
      if (dc.startsWith("user:")) return dc.slice(5);
      return undefined;
    };
    const resolveUid = (raw: unknown): string | undefined => {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v) return v.startsWith("user:") ? v.slice(5) : v;
      return fallbackUserId();
    };
    http.register("POST /wedoc/list", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ category: string; requesterUserId: string }>;
      const category = (body.category ?? "").trim();
      if (!category) { json(res, 400, { ok: false, error: "category required" }); return; }
      try {
        const result = await bridge.list(category, resolveUid(body.requesterUserId));
        json(res, 200, { ok: true, result });
      } catch (e) {
        wedocLog.error({ err: (e as Error).message, category }, "wedoc list failed");
        json(res, 502, { ok: false, error: (e as Error).message });
      }
    });
    http.register("POST /wedoc/call", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{
        category: string;
        method: string;
        args: Record<string, unknown>;
        requesterUserId: string;
      }>;
      const category = (body.category ?? "").trim();
      const method = (body.method ?? "").trim();
      if (!category || !method) {
        json(res, 400, { ok: false, error: "category and method required" });
        return;
      }
      try {
        const result = await bridge.call(category, method, body.args ?? {}, resolveUid(body.requesterUserId));
        json(res, 200, { ok: true, result });
      } catch (e) {
        wedocLog.error({ err: (e as Error).message, category, method }, "wedoc call failed");
        json(res, 502, { ok: false, error: (e as Error).message });
      }
    });
    http.register("POST /wedoc/invalidate", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ category: string }>;
      bridge.invalidate(body.category?.trim() || undefined);
      json(res, 200, { ok: true });
    });
    wedocLog.info("wedoc bridge ready");
  }

  // Mirror-mode: expose attach/status so a slash command can pin the live session.
  if (cfg.wrc.mode === "mirror") {
    const m = bridge as MirrorBridge;
    installMirrorEventListener(ws.client, m, log.child({ mod: "mirror" }));
    http.register("GET /mirror/status", (_req, res) => json(res, 200, m.status()));
    http.register("POST /mirror/attach", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ sessionId: string; jsonlPath: string; target: string; tmuxPane: string; tmuxSession: string }>;
      if (!body.sessionId || !body.jsonlPath) {
        json(res, 400, { ok: false, reason: "sessionId and jsonlPath required" });
        return;
      }
      const r = m.attach({ sessionId: body.sessionId, jsonlPath: body.jsonlPath, target: body.target, tmuxPane: body.tmuxPane, tmuxSession: body.tmuxSession });
      json(res, r.ok ? 200 : 400, r);
    });
    // Manual auto-spawn trigger — used by `wezard init` to materialize a
    // tmux+claude pane immediately after claim, instead of waiting for the
    // first inbound. Body: { target?: "user:xxx" | "chat:xxx" }. Falls back
    // to cfg.defaultChat. Same code path as the inbound auto-spawn so any
    // future fix benefits both.
    http.register("POST /mirror/spawn", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string }>;
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, reason: "target required (and cfg.defaultChat empty)" });
        return;
      }
      const spawnLog = log.child({ mod: "mirror", sub: "spawn-init", target });
      const r = await spawnTmuxClaude({ cfg, log: spawnLog, windowName: target });
      if (!r.ok) { json(res, 500, { ok: false, reason: r.reason }); return; }
      const att = m.attach({ sessionId: r.sessionId!, jsonlPath: r.jsonlPath!, target, tmuxPane: r.tmuxPane, tmuxSession: r.tmuxSession });
      json(res, att.ok ? 200 : 500, att.ok ? { ok: true, sessionId: r.sessionId, tmuxSession: r.tmuxSession, tmuxPane: r.tmuxPane, target } : { ok: false, reason: att.reason });
    });
    // ── Session discovery / switching (conversational, via MCP tools) ───────
    // GET /sessions/list — enumerate live claude sessions in tmux + a one-line
    // "what is it doing" summary each, with a stable animal-emoji label. The
    // session currently mirrored to defaultChat (if any) is flagged `current`.
    http.register("GET /sessions/list", async (_req, res) => {
      try {
        const sessions = await scanClaudeSessions();
        const cur = m.status();
        const currentSid = cur?.attached ? cur.sessionId : "";
        json(res, 200, {
          ok: true,
          current: currentSid,
          sessions: sessions.map((s) => ({ ...s, current: s.sessionId === currentSid })),
          backends: backends.map((b) => b.name),
        });
      } catch (e) {
        json(res, 500, { ok: false, reason: (e as Error).message });
      }
    });
    // POST /sessions/switch { sessionId, target? } — re-point the WeCom mirror
    // at an already-running session. We re-scan to recover its live pane/jsonl
    // (the caller MCP tool only knows its OWN session), then attach — which
    // replaces any existing binding for the target.
    http.register("POST /sessions/switch", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ sessionId: string; target: string }>;
      const sessionId = (body.sessionId ?? "").trim();
      if (!sessionId) {
        json(res, 400, { ok: false, reason: "sessionId required" });
        return;
      }
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, reason: "target required (and cfg.defaultChat empty)" });
        return;
      }
      const sessions = await scanClaudeSessions();
      const hit = sessions.find((s) => s.sessionId === sessionId);
      if (!hit) {
        json(res, 404, { ok: false, reason: `session ${sessionId} not found among live tmux sessions` });
        return;
      }
      const att = m.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      json(res, att.ok ? 200 : 500, att.ok
        ? { ok: true, sessionId: hit.sessionId, label: hit.label, target, cwd: hit.cwd, tmuxSession: hit.tmuxSession }
        : { ok: false, reason: att.reason });
    });
    // POST /sessions/new { cwd, target? } — spawn a fresh claude in a tmux pane
    // rooted at `cwd`, then attach the WeCom mirror to it. Reuses the same
    // spawn+attach path as /mirror/spawn, just with an explicit cwdOverride.
    http.register("POST /sessions/new", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ cwd: string; target: string; cli: CliBackendName }>;
      const cwd = (body.cwd ?? "").toString().trim();
      if (!cwd) {
        json(res, 400, { ok: false, reason: "cwd required" });
        return;
      }
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, reason: "target required (and cfg.defaultChat empty)" });
        return;
      }
      const spawnLog = log.child({ mod: "mirror", sub: "sessions-new", target });
      const r = await spawnTmuxClaude({ cfg, log: spawnLog, windowName: target, cwdOverride: cwd, cli: body.cli });
      if (!r.ok) { json(res, 500, { ok: false, reason: r.reason }); return; }
      const att = m.attach({ sessionId: r.sessionId!, jsonlPath: r.jsonlPath!, target, tmuxPane: r.tmuxPane, tmuxSession: r.tmuxSession, cwd: r.cwd });
      json(res, att.ok ? 200 : 500, att.ok
        ? { ok: true, sessionId: r.sessionId, target, cwd: r.cwd, cli: r.cli, tmuxSession: r.tmuxSession, tmuxPane: r.tmuxPane }
        : { ok: false, reason: att.reason });
    });
    // Frame-less inject — used by `wezard init` to fire a demo prompt right
    // after /mirror/spawn so first-time users see the full PreToolUse → card
    // → mirror loop without needing to type in WeCom.
    http.register("POST /mirror/inject", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string; text: string }>;
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      const text = (body.text ?? "").toString();
      if (!target) { json(res, 400, { ok: false, reason: "target required" }); return; }
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const r = await m.injectText(target, text);
      json(res, r.ok ? 200 : 500, r);
    });
    // Per-chat project-path binding. POST sets the "next" cwd that /new (and
    // /clear with mismatch) will spawn in; GET reads the current bindings.
    // Resolved target precedence: explicit body.target → sessionId-derived
    // (so MCP can omit it) → cfg.defaultChat. Sender of the call (MCP) is
    // typically running inside a claude that's already attached, so passing
    // sessionId is the cleanest way to identify the right chat.
    http.register("POST /mirror/cwd", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string; sessionId: string; tmuxPane: string; cwd: string }>;
      const cwd = (body.cwd ?? "").toString();
      let target = (body.target ?? "").trim();
      if (!target && body.sessionId) {
        const t = m.targetForSession(body.sessionId.trim());
        if (t) target = t;
      }
      // sessionId rotates on /clear; the MCP caller's env sessionId may be stale.
      // Pane id is stable, so resolve by it before falling back to defaultChat.
      if (!target && body.tmuxPane) {
        const t = m.targetForPane(body.tmuxPane.trim());
        if (t) target = t;
      }
      if (!target) target = (cfg.defaultChat ?? "").trim();
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId of an attached chat)" }); return; }
      if (!cwd) { json(res, 400, { ok: false, reason: "cwd required" }); return; }
      const r = m.setPendingCwd(target, cwd);
      json(res, r.ok ? 200 : 400, { ...r, target });
    });
    // ── Peer collaboration + loop graph ────────────────────────────────
    // These routes let the Claude inside one pane act on its SIBLINGS: the
    // other `#tag` sessions of the same WeCom chat. An MCP tool can only see
    // its own process, so the daemon — which owns every attachment — is the
    // only place that can answer "what is #fix doing" or "inject this into
    // #review". Callers identify themselves the same way /mirror/cwd does:
    // explicit target → sessionId → tmuxPane (stable across /clear) →
    // defaultChat.
    const resolveSelf = (b: Partial<{ target: string; sessionId: string; tmuxPane: string }>): string => {
      const explicit = (b.target ?? "").trim();
      if (explicit) return explicit;
      const bySid = b.sessionId?.trim() ? m.targetForSession(b.sessionId.trim()) : undefined;
      if (bySid) return bySid;
      const byPane = b.tmuxPane?.trim() ? m.targetForPane(b.tmuxPane.trim()) : undefined;
      if (byPane) return byPane;
      return (cfg.defaultChat ?? "").trim();
    };
    // Peer addressed by tag. Empty tag = the chat's default (untagged) session,
    // which is a legitimate collaboration target ("report back to the main one").
    const peerTarget = (self: string, tag: string): string =>
      keyOf(baseOfKey(self), (tag ?? "").trim().replace(/^#/, ""));

    interface PeerBody { target?: string; sessionId?: string; tmuxPane?: string; tag?: string }
    const readPeerBody = async (req: import("node:http").IncomingMessage): Promise<{ self: string; body: PeerBody }> => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as PeerBody;
      return { self: resolveSelf(body), body };
    };

    http.register("POST /peers/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session (pass target/sessionId/tmuxPane)" }); return; }
      const peers = await m.peers(self);
      json(res, 200, { ok: true, self, base: baseOfKey(self), peers });
    });

    // Push a plain markdown bubble into a chat. `base` may carry a `#tag` — a
    // tagged key strips down to the same WeCom chatid as its base.
    const notifyChat = (base: string, markdown: string): void => {
      const chatId = baseOfKey(base).replace(/^(user|chat|group):/, "");
      void ws.client
        .sendMessage(chatId, { msgtype: "markdown", markdown: { content: markdown } })
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "chat notify failed"));
    };
    // Agent↔agent traffic is invisible to the human otherwise: it happens inside
    // two panes nobody is watching. Relay each leg as its own bubble, headed
    // `<from> → <to>` so the direction reads at a glance in the chat timeline.
    const RELAY_MAX = 1200;
    const relayPeer = (from: string, to: string, body: string): void => {
      const text = body.trim();
      if (!text) return;
      const head = `${withTagHeader(from, "→")} ${withTagHeader(to, "")}`.trim();
      notifyChat(from, `${head}\n${text.length > RELAY_MAX ? `${text.slice(0, RELAY_MAX)}…` : text}`);
    };

    http.register("POST /peers/peek", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const target = peerTarget(self, body.tag ?? "");
      const turns = Math.min(Math.max(Number((body as { turns?: number }).turns ?? 6) || 6, 1), 40);
      // Transcript first — it is the conversation. Only when the peer has no
      // readable jsonl (never attached, or `/clear`ed a moment ago) do we fall
      // back to scraping its terminal.
      const peek = await m.peekTurns(target, turns);
      const pane = peek.ok ? undefined : await m.peekPane(target, 24);
      json(res, 200, {
        ok: true,
        target,
        dialog: peek.dialog ?? "",
        pane: pane?.pane ?? "",
        error: peek.ok ? undefined : (pane?.reason ?? peek.reason),
        busy: peek.busy ?? false,
        lastText: m.lastText(target),
      });
    });

    http.register("POST /peers/send", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const text = ((body as { text?: string }).text ?? "").toString();
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const target = peerTarget(self, body.tag ?? "");
      // Injecting into your own pane would type into the box you're generating
      // from — Claude Code queues it and the caller deadlocks waiting for itself.
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to inject into the calling session itself" }); return; }
      const r = await m.injectText(target, text);
      if (r.ok) relayPeer(self, target, text);
      json(res, r.ok ? 200 : 502, { ...r, target });
    });

    http.register("POST /peers/wait", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const target = peerTarget(self, body.tag ?? "");
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to wait on the calling session itself" }); return; }
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 900) || 900, 10), 7200) * 1000;
      const r = await waitForIdle(target, m.isBusy, timeoutMs, () => false);
      const lastText = m.lastText(target);
      // Only a finished turn is a real answer; a timeout's tail is half-written.
      if (r.idle) relayPeer(target, self, lastText);
      json(res, 200, { ok: true, target, idle: r.idle, reason: r.reason, lastText });
    });

    // POST /handoff — 交接一个 pane 的会话给一个全新会话,原地完成。先让目标
    // 会话把当前工作压成一份"零上下文也能接手"的交接简报,等它写完并抓取,
    // 再向同一 pane 注入 `/clear`(原地重开 session、重置上下文窗口、cwd 不变),
    // settle 后把简报作为新会话的首条消息贴进去。全程只操控 tmux。拒绝对调用方
    // 自身 pane 操作(会 deadlock,同 /peers/send)。
    http.register("POST /handoff", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const pane = ((body as { pane?: string }).pane ?? "").trim();
      const target = pane ? m.targetForPane(pane) : peerTarget(self, body.tag ?? "");
      if (!target) { json(res, 404, { ok: false, reason: pane ? `no mirror session bound to pane ${pane}` : "cannot resolve target session" }); return; }
      // 注入到自己的 pane = 往正在生成的输入框里打字,Claude Code 会把它排队,
      // 调用方等自己等成死锁(同 /peers/send)。
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to hand off the calling session itself (would deadlock)" }); return; }
      const focus = ((body as { focus?: string }).focus ?? "").toString().trim();
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 600) || 600, 30), 7200) * 1000;

      const briefPrompt = [
        "把你当前会话的全部工作压缩成一份**交接简报**,目标是让一个零上下文的全新会话仅凭这份简报就能无缝接手。必须自洽、具体、可执行,涵盖:",
        "1. 总目标 / 用户到底想要什么",
        "2. 已完成的事、关键决策与其理由",
        "3. 当前状态:改到哪了、什么能跑、什么还没跑通",
        "4. 下一步该做什么(有序)",
        "5. 涉及的关键文件/路径/符号,以及非显而易见的坑",
        focus ? `特别强调:${focus}` : "",
        "只输出这份简报本身,不要寒暄、不要反问。",
      ].filter(Boolean).join("\n");

      const inj1 = await m.injectText(target, briefPrompt);
      if (!inj1.ok) { json(res, 502, { ok: false, target, reason: `summary inject failed: ${inj1.reason}` }); return; }
      const idle = await waitForIdle(target, m.isBusy, timeoutMs, () => false);
      const brief = m.lastText(target);
      // 没等到 idle 就不能 /clear —— 那会丢掉这次还在生成的交接总结。
      if (!idle.idle) { json(res, 504, { ok: false, target, brief, reason: `target still working: ${idle.reason}; not clearing to avoid losing the turn` }); return; }
      if (!brief.trim()) { json(res, 502, { ok: false, target, reason: "target produced no summary text" }); return; }

      const clr = await m.injectText(target, "/clear");
      if (!clr.ok) { json(res, 502, { ok: false, target, brief, reason: `/clear inject failed: ${clr.reason}` }); return; }
      // /clear 后 TUI 重绘出全新空会话 + 首条注入需要 warmup,给足 settle。
      await new Promise((r) => setTimeout(r, 3000));

      const carry = `以下是上一个会话交接过来的工作简报,请据此无缝接手并继续:\n\n${brief}`;
      const inj2 = await m.injectText(target, carry);
      json(res, inj2.ok ? 200 : 502, inj2.ok
        ? { ok: true, target, brief }
        : { ok: false, target, brief, reason: `handoff carry inject failed: ${inj2.reason}` });
    });

    // ── Topic pub/sub (MCP-driven) ─────────────────────────────────────
    // 订阅/退订/列表/定时/取消 全部走 MCP,不再有 IM 文本命令。self 复用 peer
    // 路由的解析链(target → sessionId → tmuxPane → defaultChat),把调用方所在
    // 的聊天当作订阅者。即时广播是订阅者无关的,复用全局 POST /publish,不在这里
    // 另开。持久化与 startScheduler 定时器不变。
    const topicOf = (body: PeerBody): string => ((body as { topic?: string }).topic ?? "").trim();

    http.register("POST /topics/subscribe", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const r = subscribeTopic(cfg, sourcePath, topic, self);
      json(res, 200, { ok: true, ...r, topic, target: self, subs: (cfg.topics.subs[topic] ?? []).length });
    });

    http.register("POST /topics/unsubscribe", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const r = unsubscribeTopic(cfg, sourcePath, topic, self);
      json(res, 200, { ok: true, ...r, topic, target: self });
    });

    // List = 本聊天订阅了哪些 topic + 全部定时广播(scheduler 是进程级的)。
    http.register("POST /topics/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      json(res, 200, { ok: true, target: self, subs: listSubs(cfg, self), schedules: listSchedules(cfg) });
    });

    http.register("POST /topics/schedule", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      const b = body as { hour?: number; minute?: number; content?: string };
      const hour = Number(b.hour);
      const minute = Number(b.minute ?? 0);
      const content = (b.content ?? "").toString();
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      if (!content.trim()) { json(res, 400, { ok: false, reason: "content required" }); return; }
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) { json(res, 400, { ok: false, reason: "hour must be 0-23" }); return; }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) { json(res, 400, { ok: false, reason: "minute must be 0-59" }); return; }
      addSchedule(cfg, sourcePath, { topic, hour, minute, content, createdBy: self, createdAt: Date.now() });
      json(res, 200, { ok: true, topic, hour, minute, subs: (cfg.topics.subs[topic] ?? []).length });
    });

    http.register("POST /topics/cancel-schedule", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const removed = removeSchedulesByTopic(cfg, sourcePath, topic);
      json(res, 200, { ok: true, topic, removed });
    });

    // POST /config/set — modify daemon config from MCP
    http.register("POST /config/set", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as { key?: string; value?: unknown; action?: string };
      const { configSet } = await import("./config-api.js");
      const r = configSet(cfg, sourcePath, body.key, body.value, body.action);
      json(res, r.ok ? 200 : 400, r);
    });

    http.register("POST /config/get", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as { key?: string };
      const { configGet } = await import("./config-api.js");
      const r = configGet(cfg, body.key);
      json(res, r.ok ? 200 : 400, r);
    });

    // POST /graph/run — declare a loop graph over this chat's tagged sessions
    // and start walking it. Fire-and-forget: returns a runId immediately, then
    // narrates progress into the chat while it advances.
    http.register("POST /graph/run", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{
        target: string; sessionId: string; tmuxPane: string;
        nodes: GraphNodeSpec[]; steps: GraphStepSpec[];
        rounds: number; until: string; idleTimeoutSec: number;
      }>;
      const self = resolveSelf(body);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const spec: GraphSpec = {
        base: baseOfKey(self),
        nodes: Array.isArray(body.nodes) ? body.nodes : [],
        steps: Array.isArray(body.steps) ? body.steps : [],
        rounds: body.rounds,
        until: body.until,
        idleTimeoutSec: body.idleTimeoutSec,
      };
      const bad = validateSpec(spec);
      if (bad) { json(res, 400, { ok: false, reason: bad }); return; }
      const graphLog = log.child({ mod: "graph", base: spec.base });
      const run = startGraph(spec, {
        // Reuse a live tagged pane; only spawn when the node doesn't exist yet
        // (or its pane died). Re-spawning a healthy node would throw away the
        // context that makes a multi-round loop worth running.
        ensureNode: async (target, node) => {
          const existing = (await m.peers(target)).find((p) => p.target === target);
          if (existing?.paneAlive) return { ok: true };
          // No broadcast plumbing needed: a `base#tag` target strips down to the
          // same WeCom chatid as `base`, so the node's own pushes already land
          // in this chat — mirroring them again was pure duplication.
          const r = await m.newSession(target, node.tag, node.cli, { model: node.model, cwd: node.cwd, silent: true });
          return { ok: r.ok, reason: r.reason };
        },
        send: (target, text, origin) => m.injectText(target, text, origin),
        isBusy: m.isBusy,
        lastText: async (target) => m.lastText(target),
        notify: notifyChat,
        log: graphLog,
      });
      json(res, 200, { ok: true, runId: run.runId, base: run.base, nodes: spec.nodes.length, steps: spec.steps.length, rounds: spec.rounds ?? 1 });
    });

    http.register("GET /graph/status", (req, res) => {
      const u = new URL(req.url ?? "", "http://x");
      const runId = (u.searchParams.get("runId") ?? "").trim();
      if (runId) {
        const run = getRun(runId);
        json(res, run ? 200 : 404, run ? { ok: true, run } : { ok: false, reason: `unknown runId ${runId}` });
        return;
      }
      const base = (u.searchParams.get("target") ?? "").trim();
      json(res, 200, { ok: true, runs: listRuns(base ? baseOfKey(base) : undefined) });
    });

    http.register("POST /graph/stop", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ runId: string }>;
      const runId = (body.runId ?? "").trim();
      if (!runId) { json(res, 400, { ok: false, reason: "runId required" }); return; }
      const stopped = stopRun(runId);
      json(res, stopped ? 200 : 404, stopped ? { ok: true, runId } : { ok: false, reason: `run ${runId} not found or already finished` });
    });

    http.register("GET /mirror/cwd", async (req, res) => {
      const u = new URL(req.url ?? "", "http://x");
      let target = (u.searchParams.get("target") ?? "").trim();
      const sid = (u.searchParams.get("sessionId") ?? "").trim();
      const pane = (u.searchParams.get("tmuxPane") ?? "").trim();
      if (!target && sid) {
        const t = m.targetForSession(sid);
        if (t) target = t;
      }
      if (!target && pane) {
        const t = m.targetForPane(pane);
        if (t) target = t;
      }
      if (!target) target = (cfg.defaultChat ?? "").trim();
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId)" }); return; }
      json(res, 200, { ok: true, target, ...m.getCwd(target) });
    });
  }

  // 事件订阅调度器 — 每 20s 检查 topics.schedules,匹配当前分钟即广播。
  const scheduler = startScheduler({ client: ws.client, cfg, log: log.child({ mod: "topics" }) });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutdown signal");
    scheduler.stop();
    // 同 POST /shutdown: 先把挂着的审批长轮询了结成「稍后续接」, 再关连接。
    log.info(drainForReload(), "pending drained for reload");
    // Hard-exit watchdog: http.close() blocks until every in-flight connection
    // (long-poll approvals, keep-alive) drains, which can hang forever. SIGTERM
    // (launchctl bootout / systemctl stop) must never wedge on that — force exit.
    setTimeout(() => process.exit(0), 1500).unref();
    await new Promise((r) => setTimeout(r, 200));
    await Promise.allSettled([ws.shutdown(), http.close()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await ws.ready;
    log.info("daemon ready");
  } catch (e) {
    log.fatal({ err: (e as Error).message }, "WS fatal — exiting");
    fatalExit("WS fatal", { err: (e as Error).message });
  }
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[wezard-daemon] fatal:", e);
  process.exit(1);
});
