// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { loadConfig } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { startWs } from "./ws.js";
import { startHttp, json } from "./http.js";
import { installInboundRouter } from "./inbound.js";
import { loadSessionStore } from "./sessions.js";
import { loadMirrorStore } from "./mirror-store.js";
import { makeBridge } from "./cc-bridge.js";
import { startMirror, installMirrorEventListener, type MirrorBridge } from "./mirror-bridge.js";
import { installApprovalEventListener, makeApproveHandler } from "./approval.js";
import { initDetailPersistence, makeDetailHandler } from "./detail.js";
import { initAutoWindowPersistence } from "./session-cache.js";
import { makeMessageHandler } from "./outbound.js";
import { makeCardHandler, makeAskHandler, installAskEventListener } from "./ask.js";
import {
  makeClaimStartHandler,
  makeClaimStatusHandler,
  makeClaimResetHandler,
} from "./claim.js";

// pino's file transport is async; without flush, log.fatal before process.exit
// vanishes. Mirror anything fatal to stderr too so launchd's stderr.log captures it.
const fatalExit = (msg: string, extra?: Record<string, unknown>): never => {
  // eslint-disable-next-line no-console
  console.error(`[weclaude-daemon] FATAL: ${msg}`, extra ?? "");
  process.exit(1);
};

const main = async (): Promise<void> => {
  const { config: cfg, sourcePath } = loadConfig();
  const log = makeLogger({
    logFile: cfg.daemon.logFile,
    logLevel: cfg.daemon.logLevel,
    name: "weclaude-daemon",
  });
  log.info({ sourcePath, pid: process.pid }, "daemon start");

  // Restore auto-approve windows persisted across daemon restarts —
  // otherwise a `weclaude reload` silently drops the user's "10min" choice.
  initAutoWindowPersistence(cfg.daemon.stateDir);
  // Replay tool/approval detail records so reload doesn't lose click-to-detail
  // links from messages already on the user's WeCom timeline.
  initDetailPersistence(cfg.daemon.stateDir, log.child({ mod: "detail" }));

  const ws = startWs(cfg, log);
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
  // In mirror mode, approval clicks should also finalize the live stream so
  // post-click tool output falls through to the debounced standalone path.
  const onApprovalClicked =
    cfg.wrc.mode === "mirror"
      ? (sid: string): void => (bridge as MirrorBridge).terminateLiveStream(sid)
      : undefined;
  installApprovalEventListener(ws.client, log.child({ mod: "approval" }), cfg, onApprovalClicked);
  // In mirror mode, route approval cards to the WeCom chat bound to the requesting session.
  // Falls back to cfg.approval.approvers / cfg.defaultChat when no mirror is attached.
  const getMirrorTarget =
    cfg.wrc.mode === "mirror"
      ? (sid: string): string | undefined => (bridge as MirrorBridge).targetForSession(sid)
      : undefined;
  const http = startHttp({ cfg, ws, log, sourcePath });
  http.register(
    "POST /approve",
    makeApproveHandler({ cfg, log: log.child({ mod: "approval" }), client: ws.client, getMirrorTarget }),
  );
  http.register("POST /message", makeMessageHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /card", makeCardHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /ask", makeAskHandler(ws.client, log.child({ mod: "ask" })));
  http.register("POST /claim/start", makeClaimStartHandler({ log: log.child({ mod: "claim" }) }));
  http.register("GET /claim/status", makeClaimStatusHandler());
  http.register("POST /claim/reset", makeClaimResetHandler());
  http.register("GET /detail", makeDetailHandler(log.child({ mod: "detail" })));
  installAskEventListener(ws.client, log.child({ mod: "ask" }));

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
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutdown signal");
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
  console.error("[weclaude-daemon] fatal:", e);
  process.exit(1);
});
