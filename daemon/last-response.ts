// Track the last response weclaude emitted to each chat target, so the inbound
// router can suppress redundant `quote` blocks when the user replies to our
// most recent message. We treat the FINAL bubble (`finish=true` of a stream)
// as the response — interim chunks would race against the user's reply.
//
// Implemented as a one-shot SDK-level wrap rather than threading a tracker
// through every `client.replyStream` call site (~20 of them) — single seam,
// every reply path automatically covered.
import type { WSClient, WsFrame, BaseMessage, WsFrameHeaders } from "@wecom/aibot-node-sdk";

// Same principal derivation as inbound.ts — keep them in lockstep.
const principalFromFrame = (frame: WsFrame<BaseMessage> | WsFrameHeaders | undefined): string => {
  // Wrapped SDK calls receive the full inbound frame (with body); plain header
  // frames have no chat context and we just skip recording.
  const body = (frame as WsFrame<BaseMessage> | undefined)?.body;
  if (!body) return "";
  if (body.chattype === "group" && body.chatid) return `chat:${body.chatid}`;
  if (body.from?.userid) return `user:${body.from.userid}`;
  return "";
};

const lastByTarget = new Map<string, string>();

export const getLastResponse = (target: string): string | undefined =>
  lastByTarget.get(target);

// Wrap replyStream + replyStreamWithCard so EVERY `finish=true` reply lands in
// the tracker. Mutates the client in place; call once at daemon startup.
export const installResponseTracker = (client: WSClient): void => {
  const origReplyStream = client.replyStream.bind(client);
  const origReplyStreamWithCard = client.replyStreamWithCard.bind(client);

  client.replyStream = async (frame, streamId, content, finish, msgItem, feedback) => {
    const r = await origReplyStream(frame, streamId, content, finish, msgItem, feedback);
    if (finish) {
      const target = principalFromFrame(frame as WsFrame<BaseMessage>);
      if (target) lastByTarget.set(target, content);
    }
    return r;
  };

  client.replyStreamWithCard = async (frame, streamId, content, finish, options) => {
    const r = await origReplyStreamWithCard(frame, streamId, content, finish, options);
    if (finish) {
      const target = principalFromFrame(frame as WsFrame<BaseMessage>);
      if (target) lastByTarget.set(target, content);
    }
    return r;
  };
};
