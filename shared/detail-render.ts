// Pure HTML rendering for detail records — no IO, no state. Consumed by daemon's
// local /detail handler and the standalone svr binary. Any UI change here 自动
// 让两端保持同款外观。
import { structuredPatch, parsePatch, type StructuredPatchHunk } from "diff";
import { highlightCode, langFromPath } from "./highlight.js";
import type {
  ApprovalDecision,
  ApprovalDetailRecord,
  DetailRecord,
  ToolDetailRecord,
} from "./detail-store.js";

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const fmtTs = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
};

const decisionBadge = (d?: ApprovalDecision): { label: string; cls: string } => {
  if (!d) return { label: "待审批", cls: "pending" };
  if (d === "deny") return { label: "拒绝", cls: "deny" };
  if (d === "timeout") return { label: "超时", cls: "warn" };
  if (d === "allow_window") return { label: "通过 · 窗口", cls: "allow" };
  if (d === "allow_session") return { label: "通过 · 会话", cls: "allow" };
  if (d === "swept") return { label: "通过 · 批量", cls: "allow" };
  if (d === "allow") return { label: "通过", cls: "allow" };
  return { label: String(d), cls: "pending" };
};

const highlightJson = (json: string): string => {
  const escaped = escHtml(json);
  return escaped.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (_m, key, str, kw, num) => {
      if (key) return `<span class="jk">${key}</span>`;
      if (str) return `<span class="js">${str}</span>`;
      if (kw) return `<span class="jb">${kw}</span>`;
      if (num) return `<span class="jn">${num}</span>`;
      return _m;
    },
  );
};

const toJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2) ?? "null"; } catch { return String(v); }
};

export const SHARED_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f6f8fa;color:#1f2328;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:24px 20px 60px}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  h1{margin:0;font-size:18px;font-weight:600}
  h1 .accent{color:#0969da}
  .meta{color:#656d76;font-size:12px;margin-bottom:20px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .meta .sep{margin:0 6px;opacity:.5}
  .badge{font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid #d0d7de}
  .badge.allow{color:#1a7f37;border-color:#1a7f3733;background:#1a7f3714}
  .badge.deny{color:#cf222e;border-color:#cf222e33;background:#cf222e14}
  .badge.warn{color:#9a6700;border-color:#9a670033;background:#9a670014}
  .badge.pending{color:#8250df;border-color:#8250df33;background:#8250df14}
  section{background:#fff;border:1px solid #d0d7de;border-radius:6px;
    margin-bottom:12px;overflow:hidden}
  section>h2{margin:0;padding:6px 12px;font-size:11px;font-weight:600;
    color:#656d76;text-transform:uppercase;letter-spacing:.5px;
    background:#f1f3f6;border-bottom:1px solid #d0d7de}
  pre{margin:0;padding:12px;overflow:auto;font-size:12.5px;line-height:1.5;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
  .jk{color:#953800}.js{color:#0a3069}.jb{color:#9a6700}.jn{color:#8250df}
  .hc{color:#6e7781;font-style:italic}.hs{color:#0a3069}.hk{color:#cf222e}
  .hl{color:#8250df}.hn{color:#0550ae}.hv{color:#953800}
  .codeview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5;overflow:auto;padding:8px 0}
  .codeview .row{display:grid;grid-template-columns:56px 1fr}
  .codeview .ln{color:#8c959f;text-align:right;padding:0 8px;
    user-select:none;font-variant-numeric:tabular-nums}
  .codeview .txt{padding:0 8px;white-space:pre}
  .diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5;overflow:auto}
  .diff .row{display:grid;grid-template-columns:44px 44px 14px 1fr}
  .diff .row.add{background:#dafbe1}
  .diff .row.del{background:#ffebe9}
  .diff .row.hunk{background:#ddf4ff;color:#0969da;
    grid-template-columns:1fr;padding:1px 12px}
  .diff .ln{color:#8c959f;text-align:right;padding:0 6px;
    user-select:none;font-variant-numeric:tabular-nums}
  .diff .sign{text-align:center;color:#656d76;user-select:none}
  .diff .row.add .sign{color:#1a7f37}
  .diff .row.del .sign{color:#cf222e}
  .diff .txt{padding:0 8px;white-space:pre;min-width:0}
  .diff-meta{padding:4px 12px;font-size:12px;color:#656d76;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    font-family:ui-monospace,monospace}
  details summary{cursor:pointer;color:#656d76;padding:6px 12px;font-size:11px;
    text-transform:uppercase;letter-spacing:.5px;font-weight:600;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    list-style:none;user-select:none}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▶ ";font-size:9px}
  details[open] summary::before{content:"▼ "}
`;

interface DiffBlock { path: string; oldStr: string; newStr: string; label?: string }

const renderHunks = (hunks: readonly StructuredPatchHunk[], label: string | undefined, path: string, lang?: string): string => {
  let adds = 0, dels = 0;
  const renderText = (t: string): string =>
    t === "" ? "&nbsp;" : (lang ? highlightCode(t, lang) : escHtml(t));
  const rowsHtml = hunks.flatMap((h) => {
    const header = `<div class="row hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>`;
    let oa = h.oldStart, nb = h.newStart;
    const body = h.lines
      .filter((ln) => !ln.startsWith("\\"))
      .map((ln) => {
        const sign = ln[0] ?? " ";
        const text = ln.slice(1);
        const tag = sign === "+" ? "add" : sign === "-" ? "del" : "eq";
        const oldLn = tag === "add" ? "" : oa++;
        const newLn = tag === "del" ? "" : nb++;
        if (tag === "add") adds++;
        else if (tag === "del") dels++;
        return `<div class="row ${tag}"><div class="ln">${oldLn}</div><div class="ln">${newLn}</div><div class="sign">${sign}</div><div class="txt">${renderText(text)}</div></div>`;
      })
      .join("");
    return [header, body];
  }).join("");
  const head = label ? `${escHtml(label)} · ` : "";
  return `<section>
    <h2>${head}<span style="color:#1a7f37">+${adds}</span> <span style="color:#cf222e">-${dels}</span>${path ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0">${escHtml(path)}</span>` : ""}</h2>
    <div class="diff">${rowsHtml}</div>
  </section>`;
};

const renderDiffBlock = (b: DiffBlock): string => {
  const norm = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  const patch = structuredPatch("a", "b", norm(b.oldStr), norm(b.newStr), "", "", { context: 3 });
  return renderHunks(patch.hunks, b.label, b.path, langFromPath(b.path));
};

const tryRenderUnifiedDiff = (text: string): string => {
  if (!/(^|\n)(diff --git |@@ -\d)/.test(text)) return "";
  let patches: ReturnType<typeof parsePatch>;
  try { patches = parsePatch(text); } catch { return ""; }
  const sections = patches
    .filter((p) => p.hunks && p.hunks.length > 0)
    .map((p, idx, arr) => {
      const path = p.newFileName || p.oldFileName || "";
      const label = arr.length > 1 ? `file ${idx + 1}/${arr.length}` : undefined;
      return renderHunks(p.hunks, label, path, langFromPath(path));
    })
    .join("");
  return sections;
};

const extractDiffBlocks = (toolName: string, input: unknown): DiffBlock[] => {
  if (!input || typeof input !== "object") return [];
  const i = input as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : "";
  if (toolName === "Edit") {
    const oldStr = typeof i.old_string === "string" ? i.old_string : "";
    const newStr = typeof i.new_string === "string" ? i.new_string : "";
    if (!oldStr && !newStr) return [];
    return [{ path, oldStr, newStr }];
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
    return edits.flatMap((e, idx) => {
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      const newStr = typeof e.new_string === "string" ? e.new_string : "";
      if (!oldStr && !newStr) return [];
      return [{ path, oldStr, newStr, label: `edit ${idx + 1}/${edits.length}` }];
    });
  }
  if (toolName === "Write") {
    const content = typeof i.content === "string" ? i.content : "";
    return [{ path, oldStr: "", newStr: content, label: "create / overwrite" }];
  }
  return [];
};

const renderBashCommand = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const cmd = typeof i.command === "string" ? i.command : "";
  if (!cmd) return "";
  const desc = typeof i.description === "string" ? i.description : "";
  const subtitle = desc ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(desc)}</span>` : "";
  return `<section><h2>command${subtitle}</h2><pre><code>${highlightCode(cmd, "bash")}</code></pre></section>`;
};

const CAT_N_RE = /^\s*(\d+)\t(.*)$/;
const renderReadContent = (text: string, filePath: string): string => {
  const lang = langFromPath(filePath);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = lines
    .map((line) => {
      const m = CAT_N_RE.exec(line);
      const num = m ? m[1]! : "";
      const content = m ? m[2]! : line;
      const txt = content === "" ? "&nbsp;" : highlightCode(content, lang);
      return `<div class="row"><div class="ln">${num}</div><div class="txt">${txt}</div></div>`;
    })
    .join("");
  const langLabel = lang ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(lang)}</span>` : "";
  const head = filePath ? `<span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(filePath)}</span>${langLabel}` : `content${langLabel}`;
  return `<section><h2>${head}</h2><div class="codeview">${rows}</div></section>`;
};

const renderToolPage = (r: ToolDetailRecord): string => {
  const inputJson = highlightJson(toJson(r.toolInput));
  const hasResult = typeof r.toolResult === "string" && r.toolResult.length > 0;
  const isBash = r.toolName === "Bash";
  const isRead = r.toolName === "Read";
  const diffResultHtml = hasResult && !isRead ? tryRenderUnifiedDiff(r.toolResult!) : "";
  const filePath = isRead && r.toolInput && typeof r.toolInput === "object"
    ? String((r.toolInput as Record<string, unknown>).file_path ?? "")
    : "";
  const readResultHtml = isRead && hasResult ? renderReadContent(r.toolResult!, filePath) : "";
  const resultBlock = readResultHtml
    ? `${readResultHtml}<section><details><summary>result (raw)</summary><pre><code>${escHtml(r.toolResult!)}</code></pre></details></section>`
    : hasResult
      ? (diffResultHtml
        ? `${diffResultHtml}<section><details><summary>result (raw)</summary><pre><code>${escHtml(r.toolResult!)}</code></pre></details></section>`
        : `<section><h2>result</h2><pre><code>${escHtml(r.toolResult!)}</code></pre></section>`)
      : `<section><h2>result</h2><pre style="color:#656d76;font-style:italic"><code>(尚未捕获)</code></pre></section>`;
  const status = hasResult
    ? `<span class="badge allow">完成${r.resultAt ? ` · ${fmtDuration(r.resultAt - r.createdAt)}` : ""}</span>`
    : `<span class="badge pending">运行中</span>`;
  const diffBlocks = extractDiffBlocks(r.toolName, r.toolInput);
  const diffSection = diffBlocks.map(renderDiffBlock).join("");
  const bashCommandHtml = isBash ? renderBashCommand(r.toolInput) : "";
  const hasPrimary = diffBlocks.length > 0 || bashCommandHtml || readResultHtml;
  const inputSection = hasPrimary
    ? `<section><details><summary>input</summary><pre><code>${inputJson}</code></pre></details></section>`
    : `<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>`;
  const metaParts = [
    fmtTs(r.createdAt),
    r.sessionId ? r.sessionId.slice(0, 8) : null,
    r.target || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>${status}</header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
${bashCommandHtml}
${diffSection}
${inputSection}
${resultBlock}
</div></body></html>`;
};

const renderApprovalPage = (r: ApprovalDetailRecord): string => {
  const badge = decisionBadge(r.decision);
  const inputJson = highlightJson(toJson(r.toolInput));
  const ageMs = (r.decidedAt ?? Date.now()) - r.createdAt;
  const transcript = r.transcriptTail.trim();
  const metaParts = [
    fmtTs(r.createdAt),
    r.decidedAt ? `用时 ${fmtDuration(ageMs)}` : null,
    r.decidedBy || null,
    r.cwd || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>
<span class="badge ${badge.cls}">${badge.label}</span></header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>
${transcript
    ? `<section><details><summary>transcript (${transcript.split("\n").length} 行)</summary><pre><code>${escHtml(transcript)}</code></pre></details></section>`
    : ""}
</div></body></html>`;
};

export const renderDetailPage = (r: DetailRecord): string =>
  r.kind === "tool" ? renderToolPage(r) : renderApprovalPage(r);

export const renderNotFound = (id: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;background:#f6f8fa;color:#1f2328;padding:60px 20px;text-align:center"><p style="color:#656d76">未找到 <code style="background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:2px 6px;font-family:ui-monospace,monospace">${escHtml(id)}</code></p></body>`;
