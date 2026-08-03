// Wraps @wecom/aibot-node-sdk WSClient. Pure construction + event wiring;
// outbound helpers (text/card) live in `outbound.ts`.
import {
  WSClient,
  WSAuthFailureError,
  WSReconnectExhaustedError,
  type Logger as SdkLogger,
} from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";

// SCENE is a numeric channel tag assigned by WeCom for telemetry;
// 0 = generic / unbranded.
const SCENE = 0;
const PLUG_VERSION = "0.0.1";
const HEARTBEAT_MS = 30_000;
// -1 = SDK 原生无限重连 (指数退避封顶 reconnectMaxDelay 30s)。给有限次数是陷阱:
// Mac 睡眠唤醒 / 切网时 DNS 会短暂 ENOTFOUND, 10 次重连累计只撑约 2 分钟就耗尽,
// 此后 SDK 抛 WSReconnectExhaustedError 便彻底躺平 —— 进程活着、HTTP 端口通, 但对
// WeCom 完全失聪, 发不出卡也收不到点击。2026-08-03 就这么把一条审批 hook 挂了 9 小时,
// 而那时 DNS 早就恢复了。
// 两个边界不受此值影响: 认证失败走独立的 MAX_AUTH_FAIL 计数器仍 fail-fast; 被服务端
// 踢下线 (别处建了新连接) SDK 置 isManualClose 后本就不重连, 不会两个 daemon 互抢。
const MAX_RECONNECT = -1;
const MAX_AUTH_FAIL = 5;

const sdkLogger = (log: Logger): SdkLogger => ({
  debug: (msg, ...a) => log.debug({ a }, String(msg)),
  info: (msg, ...a) => log.info({ a }, String(msg)),
  warn: (msg, ...a) => log.warn({ a }, String(msg)),
  error: (msg, ...a) => log.error({ a }, String(msg)),
});

export interface DaemonWs {
  client: WSClient;
  /** resolves on first authenticated; rejects on fatal auth/reconnect failure */
  ready: Promise<void>;
  shutdown: () => Promise<void>;
}

export const startWs = (cfg: Config, log: Logger): DaemonWs => {
  const { bot } = cfg;
  log.info({ botId: bot.botId, ws: bot.websocketUrl }, "WS init");

  const client = new WSClient({
    botId: bot.botId,
    secret: bot.secret,
    wsUrl: bot.websocketUrl,
    logger: sdkLogger(log),
    heartbeatInterval: HEARTBEAT_MS,
    maxReconnectAttempts: MAX_RECONNECT,
    maxAuthFailureAttempts: MAX_AUTH_FAIL,
    scene: SCENE,
    plug_version: PLUG_VERSION,
  });

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  client.on("connected", () => log.info("WS connected"));
  client.on("authenticated", () => {
    log.info("WS authenticated");
    resolveReady();
  });
  client.on("disconnected", (reason) => log.warn({ reason }, "WS disconnected"));
  client.on("reconnecting", (attempt) => log.info({ attempt }, "WS reconnecting"));
  client.on("error", (err) => {
    log.error({ err: err.message, kind: err.constructor.name }, "WS error");
    if (err instanceof WSAuthFailureError || err instanceof WSReconnectExhaustedError) {
      rejectReady(err);
    }
  });
  client.on("event.disconnected_event", () => {
    log.error("WS kicked by server (new connection elsewhere); auto-restart suppressed");
    client.disconnect();
  });

  const shutdown = async (): Promise<void> => {
    log.info("WS shutdown");
    try {
      client.disconnect();
    } catch (e) {
      log.warn({ err: (e as Error).message }, "disconnect threw");
    }
  };

  // SDK 构造不自动连接，需显式调用。
  client.connect();

  return { client, ready, shutdown };
};
