// Inbound text router. Hands the message off to either the headless CC bridge
// (mode=headless) or the mirror bridge (mode=mirror).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, BaseMessage } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import type { Bridge } from "./cc-bridge.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import { tryConsumeClaim, persistClaim, ackClaim, shouldAutoClaim, ackAutoClaim } from "./claim.js";
import { spawnTmuxClaude } from "./spawn-tmux.js";

// Chat-binding key: stable id for "this conversation thread". Used as
// session-map key, mirror target, defaultChat. NOT used for auth.
const chatPrincipal = (msg: BaseMessage): string =>
  msg.chattype === "group" && msg.chatid ? `chat:${msg.chatid}` : `user:${msg.from.userid}`;

// Auth principals: any-of test against allowFrom. Tiered — allowing a user
// grants them access in any chat; allowing a group grants every member of
// that group access. DMs collapse to just the sender.
const authPrincipals = (msg: BaseMessage): string[] => {
  const user = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) return [`chat:${msg.chatid}`, user];
  return [user];
};

// "会话id" = chat-binding (session/mirror key); "权限id" = either the group
// OR the sender — allowFrom passes if any one of them is whitelisted.
const renderIds = (msg: BaseMessage): string => {
  const sender = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) {
    const chat = `chat:${msg.chatid}`;
    return `[weclaude] 会话id: \`${chat}\`\n发送者: \`${sender}\`\n权限id (allowFrom): \`${chat}\` 或 \`${sender}\` 任一即可`;
  }
  return `[weclaude] 会话id / 权限id: \`${sender}\``;
};

const isIdCommand = (text: string): boolean => text.trim() === "/id";
const isNewCommand = (text: string): boolean => text.trim() === "/new";

// Strip any "@<botname>" mention (leading, mid-text, or trailing) so it doesn't
// leak into claude's prompt. WeCom may place the mention anywhere depending on
// where the user typed it.
const stripMentions = (text: string): string =>
  text.replace(/\s*@\S+\s*/gu, " ").replace(/\s+/gu, " ").trim();

const isAllowed = (cfg: Config, principals: string[]): boolean => {
  if (cfg.wrc.allowFrom.length === 0) return false;
  // Tolerate invisible chars sneaking into hand-edited config (paste artifacts).
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  return principals.some((p) => allowed.has(p));
};

// Mirror mode grants implicit talkback: any chat that's currently a mirror
// target can post back without being in `allowFrom`. The act of /wrc'ing into
// that chat is the authorization signal.
const isMirrorTarget = (bridge: Bridge | MirrorBridge, who: string): boolean =>
  "hasMirrorTarget" in bridge && bridge.hasMirrorTarget(who);

// Sniff extension from magic bytes; falls back to .bin. WeCom doesn't always
// give us a filename for images, and we want claude's Read tool to recognize
// the file (it dispatches on extension).
const sniffExt = (buf: Buffer): string => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf.length >= 12 && buf.subarray(4, 12).toString("ascii") === "ftypheic") return ".heic";
  return ".bin";
};

interface DownloadDeps {
  client: WSClient;
  log: Logger;
  inboxDir: string;
}

const downloadToInbox = async (
  deps: DownloadDeps,
  url: string,
  aesKey: string | undefined,
  msgid: string,
  index: number,
): Promise<string | undefined> => {
  try {
    const { buffer, filename } = await deps.client.downloadFile(url, aesKey);
    const ext = filename ? `.${filename.split(".").pop()!}` : sniffExt(buffer);
    const safeName = `${msgid.replace(/[^A-Za-z0-9_-]/g, "_")}_${index}${ext}`;
    mkdirSync(deps.inboxDir, { recursive: true });
    const abs = join(deps.inboxDir, safeName);
    writeFileSync(abs, buffer);
    deps.log.info({ url: url.slice(0, 80), bytes: buffer.length, abs }, "media saved");
    return abs;
  } catch (e) {
    deps.log.error({ err: (e as Error).message }, "media download failed");
    return undefined;
  }
};

export const installInboundRouter = (
  client: WSClient,
  cfg: Config,
  log: Logger,
  bridge: Bridge | MirrorBridge,
  sourcePath: string,
): void => {
  const inboxDir = expandHome(cfg.wrc.mirror.inboxDir);

  // Mirror-only auto-spawn: create a fresh tmux+claude and attach it to `who`.
  // Returns the user-facing status string; void when not in mirror mode.
  const autoSpawnAndAttach = async (who: string): Promise<string> => {
    if (!("attach" in bridge)) return "[weclaude] /new only available in mirror mode";
    const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "spawn", who }), windowName: who });
    if (!r.ok) return `[weclaude] auto-spawn failed: ${r.reason ?? "unknown"}`;
    const att = bridge.attach({
      sessionId: r.sessionId!,
      jsonlPath: r.jsonlPath!,
      target: who,
      tmuxPane: r.tmuxPane,
      tmuxSession: r.tmuxSession,
    });
    if (!att.ok) return `[weclaude] attach failed: ${att.reason ?? "unknown"}`;
    return `✅ tmux \`${r.tmuxSession}\` → claude session \`${r.sessionId}\` attached`;
  };

  // Common gating: claim bootstrap + allowFrom check. Returns true if the
  // caller should stop (claim consumed or message rejected).
  const gate = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, text: string): Promise<{ stop: boolean; who: string }> => {
    const who = chatPrincipal(msg);
    const auths = authPrincipals(msg);
    // /id — bypass allowFrom so users can discover their ids before configuring.
    if (isIdCommand(text)) {
      try { await client.replyStream(frame, msg.msgid, renderIds(msg), true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    if (tryConsumeClaim(text, who)) {
      log.info({ who }, "claim consumed — bootstrapping defaultChat + allowFrom");
      try { persistClaim(cfg, sourcePath, who); } catch (e) {
        log.error({ err: (e as Error).message }, "persistClaim failed");
      }
      await ackClaim(client, who, log);
      try { await client.replyStream(frame, msg.msgid, "✅ done", true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Auto-claim: empty allowFrom + DM ⇒ first sender becomes super admin.
    // Falls through so the same message is also dispatched as a real prompt —
    // user types "hi" and gets both the promotion ack and the assistant reply.
    const isDm = !(msg.chattype === "group" && msg.chatid);
    if (shouldAutoClaim(cfg, isDm)) {
      log.info({ who }, "auto-claim — empty allowFrom, first DM sender promoted");
      try { persistClaim(cfg, sourcePath, who); } catch (e) {
        log.error({ err: (e as Error).message }, "auto-claim persistClaim failed");
      }
      await ackAutoClaim(client, who, log);
      // fall through to dispatch
    }
    if (!isAllowed(cfg, auths) && !isMirrorTarget(bridge, who)) {
      log.warn({ from: who, auths }, "drop: not in allowFrom");
      try {
        await client.replyStream(
          frame,
          msg.msgid,
          `[weclaude] 未授权\n${renderIds(msg)}\n请将上述任一权限id加入 config 的 wrc.allowFrom 数组`,
          true,
        );
      } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Authorized `/new` — spawn a tmux+claude pair and attach it to this chat.
    // Runs BEFORE the mirror-not-attached short-circuit so it works as the
    // very first message from a fresh user.
    if (isNewCommand(text)) {
      const reply = await autoSpawnAndAttach(who);
      try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
      return { stop: true, who };
    }
    // Mirror mode but no Claude session attached for this chat yet. Since the
    // sender is already in allowFrom, we treat that authorization as license
    // to auto-spawn: this inbound becomes both the binding signal and the
    // first prompt — attach, then fall through to dispatch.
    if ("hasMirrorTarget" in bridge && !bridge.hasMirrorTarget(who)) {
      const reply = await autoSpawnAndAttach(who);
      if (!reply.startsWith("✅")) {
        try { await client.replyStream(frame, msg.msgid, reply, true); } catch { /* ignore */ }
        return { stop: true, who };
      }
      // attached — fall through to dispatch
    }
    return { stop: false, who };
  };

  const send = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string, images: string[] = []): Promise<void> => {
    try {
      await bridge.dispatch({ principal: who, text, images, frame, streamId: msg.msgid });
    } catch (e) {
      log.error({ err: (e as Error).message }, "bridge dispatch failed");
      try { await client.replyStream(frame, msg.msgid, `[weclaude] error: ${(e as Error).message}`, true); } catch { /* ignore */ }
    }
  };

  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const raw = msg.text?.content ?? "";
    const text = stripMentions(raw);
    log.info({ msgid: msg.msgid, len: text.length }, "rx text");
    const { stop, who } = await gate(frame, msg, text);
    if (stop) return;
    await send(frame, msg, who, text);
  });

  client.on("message.image", async (frame: WsFrame<ImageMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid }, "rx image");
    const { stop, who } = await gate(frame, msg, "");
    if (stop) return;
    const path = await downloadToInbox({ client, log, inboxDir }, msg.image.url, msg.image.aeskey, msg.msgid, 0);
    if (!path) {
      try { await client.replyStream(frame, msg.msgid, "[weclaude] 图片下载失败", true); } catch { /* ignore */ }
      return;
    }
    // Pass the path through the bridge's `images` channel — mirror mode pumps
    // each via macOS clipboard + Ctrl+V into the live TTY (matches Claude
    // Code's documented image paste flow → image content block, no Read tool
    // turn). Spawn-mode falls back to `@<path>` automatically.
    await send(frame, msg, who, "", [path]);
  });

  client.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, items: msg.mixed?.msg_item?.length }, "rx mixed");
    const { stop, who } = await gate(frame, msg, "");
    if (stop) return;
    const texts: string[] = [];
    const images: string[] = [];
    let imgIdx = 0;
    for (const item of msg.mixed?.msg_item ?? []) {
      if (item.msgtype === "text" && item.text?.content) {
        const t = stripMentions(item.text.content);
        if (t) texts.push(t);
      } else if (item.msgtype === "image" && item.image?.url) {
        const path = await downloadToInbox(
          { client, log, inboxDir },
          item.image.url,
          item.image.aeskey,
          msg.msgid,
          imgIdx++,
        );
        if (path) images.push(path);
      }
    }
    if (texts.length === 0 && images.length === 0) return;
    await send(frame, msg, who, texts.join("\n"), images);
  });

  // template_card_event is handled in approval module; no listener here.
};
