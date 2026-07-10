// Convert ANSI SGR escapes to HTML <span> with inline styles. Non-SGR CSI
// (cursor moves, clears) and OSC sequences are stripped. Non-escape text is
// HTML-escaped. Single-pass fold — no globals.
//
// Called at render time on tool_result / transcript strings that may contain
// escape codes from `ls --color`, `grep --color`, npm/pnpm output, etc.
// If input has no ANSI, output equals escHtml(input).

interface Sty {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const PALETTE: Record<number, string> = {
  30: "#1f2328", 31: "#cf222e", 32: "#1a7f37", 33: "#9a6700",
  34: "#0969da", 35: "#8250df", 36: "#1b7c83", 37: "#6e7781",
  90: "#57606a", 91: "#f85149", 92: "#3fb950", 93: "#d29922",
  94: "#58a6ff", 95: "#bc8cff", 96: "#39c5cf", 97: "#8c959f",
};

const xterm256 = (n: number): string => {
  if (n < 16) return PALETTE[n < 8 ? 30 + n : 90 + (n - 8)] ?? "#1f2328";
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
    const v = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
};

const applyParams = (init: Sty, ps: readonly number[]): Sty => {
  let s: Sty = { ...init };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p >= 30 && p <= 37) s.fg = PALETTE[p];
    else if (p === 39) s.fg = undefined;
    else if (p >= 40 && p <= 47) s.bg = PALETTE[p - 10];
    else if (p === 49) s.bg = undefined;
    else if (p >= 90 && p <= 97) s.fg = PALETTE[p];
    else if (p >= 100 && p <= 107) s.bg = PALETTE[p - 10];
    else if (p === 38 || p === 48) {
      const mode = ps[i + 1];
      if (mode === 5) {
        const col = xterm256(ps[i + 2] ?? 0);
        if (p === 38) s.fg = col; else s.bg = col;
        i += 2;
      } else if (mode === 2) {
        const r = ps[i + 2] ?? 0, g = ps[i + 3] ?? 0, b = ps[i + 4] ?? 0;
        const col = `rgb(${r},${g},${b})`;
        if (p === 38) s.fg = col; else s.bg = col;
        i += 4;
      }
    }
  }
  return s;
};

const isEmpty = (s: Sty): boolean =>
  !s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline;

const styleAttr = (s: Sty): string => {
  const parts: string[] = [];
  if (s.fg) parts.push(`color:${s.fg}`);
  if (s.bg) parts.push(`background:${s.bg}`);
  if (s.bold) parts.push("font-weight:600");
  if (s.dim) parts.push("opacity:.7");
  if (s.italic) parts.push("font-style:italic");
  if (s.underline) parts.push("text-decoration:underline");
  return parts.join(";");
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([\d;?]*)([A-Za-z])/g;

export const ansiToHtml = (raw: string): string => {
  const cleaned = raw.replace(OSC_RE, "").replace(/\r(?!\n)/g, "");
  let out = "";
  let sty: Sty = {};
  let open = false;
  let last = 0;
  const re = new RegExp(CSI_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    out += esc(cleaned.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] === "m") {
      const ps = m[1] === "" ? [0] : m[1]!.split(";").map((n) => Number(n) || 0);
      sty = applyParams(sty, ps);
      if (open) { out += "</span>"; open = false; }
      if (!isEmpty(sty)) { out += `<span style="${styleAttr(sty)}">`; open = true; }
    }
  }
  out += esc(cleaned.slice(last));
  if (open) out += "</span>";
  return out;
};
