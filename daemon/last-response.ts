// Track the last response wezard emitted to each chat target, so the inbound
// router can suppress redundant `quote` blocks when the user replies to our
// most recent message. We treat the FINAL bubble (`finish=true` of a stream)
// AND any markdown sendMessage push as "the response" — because the standalone
// rendering path (post tool→text split, /pwd/ack, /id replies, etc.) skips the
// stream and goes straight through `client.sendMessage`. If we only watched
// replyStream we'd miss exactly the case where the user is most likely to
// quote (the final text bubble of a tool-heavy turn).
//
// Implemented as a one-shot SDK-level wrap rather than threading a tracker
// through every call site (~30+) — single seam, every reply path covered.
//
// In-memory only by design: a `wezard reload` clears the map; the next
// inbound after reload will miss dedup once. Acceptable in production (rare
// reloads); in dev just avoid reloading mid-conversation when testing.
import type { WSClient, WsFrame, BaseMessage, WsFrameHeaders } from "@wecom/aibot-node-sdk";

// Strip `chat:` / `user:` prefix to get the bare chatid/userid that
// `sendMessage` takes. Chat ids and user ids don't collide in practice (group
// chatids start with `wr…`, userids are short alphanumeric) so we can safely
// key the tracker by the bare id and use the same lookup from inbound.
const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

const principalToBare = (principal: string): string => stripPrefix(principal);

const bareFromFrame = (frame: WsFrame<BaseMessage> | WsFrameHeaders | undefined): string => {
  // Wrapped SDK calls receive the full inbound frame (with body); plain header
  // frames have no chat context and we just skip recording.
  const body = (frame as WsFrame<BaseMessage> | undefined)?.body;
  if (!body) return "";
  if (body.chattype === "group" && body.chatid) return body.chatid;
  if (body.from?.userid) return body.from.userid;
  return "";
};

const lastByBareId = new Map<string, string>();

export const getLastResponse = (target: string): string | undefined =>
  lastByBareId.get(principalToBare(target));

const record = (bareId: string, content: string): void => {
  if (!bareId || !content) return;
  lastByBareId.set(bareId, content);
};

// Wrap replyStream + replyStreamWithCard (live stream finalize) AND
// sendMessage (markdown standalone push) so EVERY user-visible bubble lands
// in the tracker. Mutates the client in place; call once at daemon startup.
export const installResponseTracker = (client: WSClient): void => {
  const origReplyStream = client.replyStream.bind(client);
  const origReplyStreamWithCard = client.replyStreamWithCard.bind(client);
  const origSendMessage = client.sendMessage.bind(client);

  client.replyStream = async (frame, streamId, content, finish, msgItem, feedback) => {
    const r = await origReplyStream(frame, streamId, content, finish, msgItem, feedback);
    if (finish) record(bareFromFrame(frame as WsFrame<BaseMessage>), content);
    return r;
  };

  client.replyStreamWithCard = async (frame, streamId, content, finish, options) => {
    const r = await origReplyStreamWithCard(frame, streamId, content, finish, options);
    if (finish) record(bareFromFrame(frame as WsFrame<BaseMessage>), content);
    return r;
  };

  client.sendMessage = async (chatid, body) => {
    const r = await origSendMessage(chatid, body);
    // Only capture markdown pushes — template_card / media bubbles don't
    // carry quotable text and would just pollute the tracker.
    if ((body as { msgtype?: string }).msgtype === "markdown") {
      const md = (body as { markdown?: { content?: string } }).markdown?.content ?? "";
      record(chatid, md);
    }
    return r;
  };
};
