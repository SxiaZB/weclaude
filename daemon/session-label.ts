// Stable per-session visual tag. Hash a sessionId to a fixed animal emoji so
// the same Claude session always shows the same icon — on approval cards and
// in the /sessions list — letting the user tell sibling sessions apart when
// several un-mirrored sessions all fall back to the same WeCom chat.
//
// Stateless + deterministic: same sessionId → same emoji across daemon
// restarts, no persistence needed.

const ANIMALS = [
  "🦊", "🐬", "🦄", "🐙", "🦉", "🐢", "🦋", "🐝",
  "🐳", "🦁", "🐯", "🐰", "🦝", "🐼", "🐨", "🦓",
  "🦔", "🦇", "🐧", "🦜", "🦩", "🐸", "🐺", "🦅",
  "🐡", "🦞", "🦗", "🐌", "🦚", "🐲",
];

// FNV-1a — small, fast, good spread for short ascii ids.
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const labelFor = (sessionId: string): string => {
  if (!sessionId) return "❔";
  return ANIMALS[hash(sessionId) % ANIMALS.length] ?? "❔";
};
