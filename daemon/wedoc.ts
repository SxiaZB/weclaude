// 企业微信 MCP 桥接：把 WeCom 托管的 doc / smartsheet / contact MCP server
// 转发给本地 Claude。流程:
//   1. WSClient 发送 `aibot_get_mcp_config` 拿到 category → MCP URL
//   2. 对该 URL 走 Streamable HTTP MCP (initialize → Mcp-Session-Id → tools/*)
//   3. 通过 `x-openclaw-wecom-userid` header 透传可信 userid，每日 20 篇限额按此 userid 计
//
// 关键不变量:
//   - URL 与 session 都按 category 维度缓存; 失败时清掉重建。
//   - WS 命令必须等 client 已 authenticated, 调用方需保证 (daemon 启动后 await ws.ready)。
//   - 不存任何 WeCom 凭据; 信任锚是 botId+secret 的 WS 长连本身。
import { generateReqId, type WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";

const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "weclaude-wedoc", version: "0.1.0" } as const;
const USERID_HEADER = "x-openclaw-wecom-userid";
const USER_AGENT = "weclaude-wedoc/0.1";

interface McpSession {
  url: string;
  sessionId: string | null;
  initialized: boolean;
  stateless: boolean;
  // 配置 / 会话过期时间戳 (ms epoch); 任意一项失效都重新走 fetchMcpUrl + initialize。
  expiresAt: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface WedocOptions {
  client: WSClient;
  log: Logger;
  pluginVersion: string;
  cacheTtlMs: number;
  configFetchTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface WedocBridge {
  list: (category: string, requesterUserId?: string) => Promise<unknown>;
  call: (
    category: string,
    method: string,
    args: Record<string, unknown>,
    requesterUserId?: string,
  ) => Promise<unknown>;
  invalidate: (category?: string) => void;
}

// ── 纯函数: SSE 解析 ─────────────────────────────────────────────────
// Streamable HTTP 的响应有可能是 text/event-stream; 取最后一个完整 event 的 data 块。
const parseSse = (text: string): string => {
  const events: string[][] = [];
  let current: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith("data:")) {
      current.push(raw.startsWith("data: ") ? raw.slice(6) : raw.slice(5));
    } else if (raw.trim() === "") {
      if (current.length > 0) {
        events.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) events.push(current);
  const last = events[events.length - 1];
  return last ? last.join("\n").trim() : "";
};

// ── 纯函数: 解析 RPC 响应 ────────────────────────────────────────────
const parseRpc = (raw: string): unknown => {
  if (!raw) return undefined;
  const rpc = JSON.parse(raw) as JsonRpcResponse;
  if (rpc.error) {
    const err: Error & { code?: number; data?: unknown } = new Error(
      `MCP RPC error [${rpc.error.code}]: ${rpc.error.message}`,
    );
    err.code = rpc.error.code;
    err.data = rpc.error.data;
    throw err;
  }
  return rpc.result;
};

const buildHeaders = (sessionId: string | null, requesterUserId?: string): Record<string, string> => {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": USER_AGENT,
  };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  const uid = requesterUserId?.trim();
  if (uid) h[USERID_HEADER] = uid;
  return h;
};

// ── 副作用: 发送 JSON-RPC, 处理 session-id / SSE / 普通 JSON ─────────
const sendRaw = async (
  url: string,
  session: McpSession,
  body: { jsonrpc: "2.0"; id?: string; method: string; params?: Record<string, unknown> },
  timeoutMs: number,
  requesterUserId?: string,
): Promise<{ result: unknown; newSessionId: string | null; status: number }> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(session.sessionId, requesterUserId),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`MCP request timed out (${timeoutMs}ms)`);
    throw new Error(`MCP fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const newSessionId = res.headers.get("mcp-session-id");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: Error & { status?: number } = new Error(
      `MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
    );
    err.status = res.status;
    throw err;
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { result: undefined, newSessionId, status: res.status };
  }

  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  const payload = ct.includes("text/event-stream") ? parseSse(text) : text.trim();
  return { result: parseRpc(payload), newSessionId, status: res.status };
};

// ── 副作用: 通过 WS 拉一个 category 的 MCP URL ───────────────────────
const fetchMcpUrl = async (
  client: WSClient,
  category: string,
  pluginVersion: string,
  timeoutMs: number,
): Promise<string> => {
  if (!client.isConnected) throw new Error("WS not connected; cannot fetch MCP config");
  const reqId = generateReqId("mcp_config");
  const wait = client.reply(
    { headers: { req_id: reqId } },
    { biz_type: category, plugin_version: pluginVersion },
    MCP_GET_CONFIG_CMD,
  );
  const guarded = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`MCP config fetch for "${category}" timed out (${timeoutMs}ms)`)), timeoutMs),
  );
  const frame = (await Promise.race([wait, guarded])) as { errcode?: number; errmsg?: string; body?: { url?: string } };
  if (frame.errcode !== undefined && frame.errcode !== 0) {
    throw new Error(`MCP config fetch failed: errcode=${frame.errcode}, errmsg=${frame.errmsg ?? "?"}`);
  }
  const url = frame.body?.url;
  if (!url) throw new Error(`MCP config response missing url (category="${category}")`);
  return url;
};

// ── 副作用: initialize 握手 ──────────────────────────────────────────
const handshake = async (
  url: string,
  timeoutMs: number,
  requesterUserId: string | undefined,
  ttlMs: number,
): Promise<McpSession> => {
  const session: McpSession = {
    url,
    sessionId: null,
    initialized: false,
    stateless: false,
    expiresAt: Date.now() + ttlMs,
  };

  const init = await sendRaw(
    url,
    session,
    {
      jsonrpc: "2.0",
      id: generateReqId("mcp_init"),
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    },
    timeoutMs,
    requesterUserId,
  );
  session.sessionId = init.newSessionId;

  // 服务端没回 Mcp-Session-Id → 无状态 server, 不必发 initialized 通知。
  if (!session.sessionId) {
    session.stateless = true;
    session.initialized = true;
    return session;
  }

  // 通知 server 完成 initialization (不带 id, 是 notification)。
  const notif = await sendRaw(
    url,
    session,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    timeoutMs,
    requesterUserId,
  );
  if (notif.newSessionId) session.sessionId = notif.newSessionId;
  session.initialized = true;
  return session;
};

// ── 工厂: 把所有缓存 / 重试 / 锁封在闭包里 ───────────────────────────
export const makeWedocBridge = (opts: WedocOptions): WedocBridge => {
  const { client, log, pluginVersion, cacheTtlMs, configFetchTimeoutMs, requestTimeoutMs } = opts;
  const sessions = new Map<string, McpSession>();
  const inflight = new Map<string, Promise<McpSession>>();

  const isFresh = (s: McpSession): boolean => s.initialized && Date.now() < s.expiresAt;

  const ensureSession = async (category: string, requesterUserId: string | undefined): Promise<McpSession> => {
    const cached = sessions.get(category);
    if (cached && isFresh(cached)) return cached;

    const pending = inflight.get(category);
    if (pending) return pending;

    const p = (async () => {
      const url = await fetchMcpUrl(client, category, pluginVersion, configFetchTimeoutMs);
      log.info({ category, url }, "wedoc mcp url");
      const s = await handshake(url, requestTimeoutMs, requesterUserId, cacheTtlMs);
      sessions.set(category, s);
      log.info({ category, stateless: s.stateless }, "wedoc mcp ready");
      return s;
    })().finally(() => inflight.delete(category));
    inflight.set(category, p);
    return p;
  };

  // 401/404/410 → 抛弃 session 重建一次; 其它错误直接上抛。
  const isStaleStatus = (e: unknown): boolean => {
    const s = (e as { status?: number }).status;
    return s === 401 || s === 404 || s === 410;
  };

  const callRpc = async (
    category: string,
    method: string,
    params: Record<string, unknown> | undefined,
    requesterUserId: string | undefined,
  ): Promise<unknown> => {
    let session = await ensureSession(category, requesterUserId);
    const body = { jsonrpc: "2.0" as const, id: generateReqId("mcp_call"), method, params };
    try {
      const r = await sendRaw(session.url, session, body, requestTimeoutMs, requesterUserId);
      if (r.newSessionId) session.sessionId = r.newSessionId;
      return r.result;
    } catch (e) {
      if (!isStaleStatus(e)) throw e;
      log.warn({ category, err: (e as Error).message }, "wedoc session stale, rebuilding");
      sessions.delete(category);
      session = await ensureSession(category, requesterUserId);
      const r = await sendRaw(session.url, session, body, requestTimeoutMs, requesterUserId);
      if (r.newSessionId) session.sessionId = r.newSessionId;
      return r.result;
    }
  };

  return {
    list: (category, requesterUserId) => callRpc(category, "tools/list", undefined, requesterUserId),
    call: (category, method, args, requesterUserId) =>
      callRpc(category, "tools/call", { name: method, arguments: args }, requesterUserId),
    invalidate: (category) => {
      if (category) {
        sessions.delete(category);
        inflight.delete(category);
      } else {
        sessions.clear();
        inflight.clear();
      }
    },
  };
};
