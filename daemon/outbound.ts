// Outbound message handler for /message endpoint (used by `weclaude send` & MCP).
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

interface MsgReq {
  chat: string;
  text?: string;
  markdown?: string;
}

export const makeMessageHandler = (client: WSClient, log: Logger): Handler => {
  return async (req, res) => {
    const body = (await readBody(req)) as Partial<MsgReq>;
    const chat = body.chat ?? "";
    const content = body.markdown ?? body.text ?? "";
    if (!chat || !content) {
      json(res, 400, { ok: false, error: "missing chat or text" });
      return;
    }
    if (!client.isConnected) {
      json(res, 503, { ok: false, error: "ws_disconnected" });
      return;
    }
    try {
      await client.sendMessage(stripPrefix(chat), {
        msgtype: "markdown",
        markdown: { content },
      });
      log.info({ chat, len: content.length }, "tx markdown");
      json(res, 200, { ok: true });
    } catch (e) {
      log.error({ err: (e as Error).message }, "send failed");
      json(res, 502, { ok: false, error: (e as Error).message });
    }
  };
};
