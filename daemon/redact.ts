// Sensitive value redaction for tool_input before sending to IM.
// Keep it boring: regex on JSON keys/values that look like credentials.
const KEY_RE = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie)/i;
const VALUE_RE = /^(eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{16,}|[A-Fa-f0-9]{32,}|ghp_[A-Za-z0-9]{20,})$/;

const redactString = (s: string): string => (VALUE_RE.test(s) ? "***" : s);

export const redact = (input: unknown): unknown => {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (KEY_RE.test(k) && typeof v === "string") {
        out[k] = "***";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return input;
};
