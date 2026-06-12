// Local control HTTP — talks to hooks, slash commands, MCP server.
// Bound to 127.0.0.1; trust = "anyone with loopback access".
// Endpoints intentionally tiny & sync-friendly.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import type { DaemonWs } from "./ws.js";
import { listPending } from "./pending.js";

interface Ctx {
  cfg: Config;
  ws: DaemonWs;
  log: Logger;
  sourcePath: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx) => Promise<void> | void;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
};

const routes: Record<string, Handler> = {
  "GET /healthz": (_req, res, _url, { ws }) => {
    json(res, 200, { ok: true, wsConnected: ws.client.isConnected });
  },
  "GET /status": (_req, res, _url, { cfg, ws, sourcePath }) => {
    json(res, 200, {
      ok: true,
      wsConnected: ws.client.isConnected,
      botId: cfg.bot.botId,
      defaultChat: cfg.defaultChat,
      pending: listPending().length,
      uptimeSec: Math.round(process.uptime()),
      sourcePath,
      logFile: expandHome(cfg.daemon.logFile),
    });
  },
  "GET /pending": (_req, res) => {
    json(res, 200, { pending: listPending() });
  },
  "POST /shutdown": async (_req, res, _url, { ws, log }) => {
    json(res, 200, { ok: true });
    log.info("shutdown via HTTP");
    await ws.shutdown();
    setTimeout(() => process.exit(0), 100);
  },
  // /approve and /message are wired by callers later (approval, slash).
};

export interface HttpServer {
  close: () => Promise<void>;
  /** Register additional routes after construction (e.g. /approve once approval module loads). */
  register: (key: string, handler: Handler) => void;
}

export const startHttp = (ctx: Ctx): HttpServer => {
  const dynamic = new Map<string, Handler>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const key = `${req.method ?? "GET"} ${url.pathname}`;
    const handler = dynamic.get(key) ?? routes[key];
    if (!handler) {
      json(res, 404, { error: "not_found", route: key });
      return;
    }
    try {
      await handler(req, res, url, ctx);
    } catch (e) {
      ctx.log.error({ err: (e as Error).message, route: key }, "http handler failed");
      if (!res.headersSent) json(res, 500, { error: "internal", message: (e as Error).message });
    }
  });

  server.listen(ctx.cfg.daemon.port, ctx.cfg.daemon.host, () => {
    ctx.log.info({ host: ctx.cfg.daemon.host, port: ctx.cfg.daemon.port }, "HTTP listening");
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    register: (key, handler) => dynamic.set(key, handler),
  };
};

export type { Handler, Ctx };
export { readBody, json };
