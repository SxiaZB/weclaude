// Pure HTML rendering for detail records — no IO, no state. Consumed by daemon's
// local /detail handler and the standalone svr binary. Any UI change here 自动
// 让两端保持同款外观。
import { structuredPatch, parsePatch, type StructuredPatchHunk } from "diff";
import { highlightCode, langFromPath } from "./highlight.js";
import { ansiToHtml } from "./ansi.js";
import type {
  ApprovalDecision,
  ApprovalDetailRecord,
  DetailRecord,
  ToolDetailRecord,
  TurnDetailRecord,
  TurnItem,
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

// 42431 → "42.4k"; 999 → "999"; 12345678 → "12.35M"
const fmtTok = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1e6) {
    const v = n / 1000;
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
};

// 上下文窗口大小 —— [1m] / 1m 后缀标记 1M 窗口 (Claude Code 长上下文变体), 否则按 200k。
const ctxWindow = (model?: string): number =>
  model && /\[?1m\]?/i.test(model) ? 1_000_000 : 200_000;

// 窗口占用压力配色: <60% 绿, <85% 黄, 否则红。
const ctxPressure = (pct: number): { fill: string; text: string } =>
  pct < 60 ? { fill: "#1a7f37", text: "#1a7f37" }
  : pct < 85 ? { fill: "#9a6700", text: "#9a6700" }
  : { fill: "#cf222e", text: "#cf222e" };

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
  pre{margin:0;padding:12px;font-size:12.5px;line-height:1.5;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .jk{color:#953800}.js{color:#0a3069}.jb{color:#9a6700}.jn{color:#8250df}
  .hc{color:#6e7781;font-style:italic}.hs{color:#0a3069}.hk{color:#cf222e}
  .hl{color:#8250df}.hn{color:#0550ae}.hv{color:#953800}
  .codeview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5;padding:8px 0}
  .codeview .row{display:grid;grid-template-columns:56px 1fr;min-width:0}
  .codeview .ln{color:#8c959f;text-align:right;padding:0 8px;
    user-select:none;font-variant-numeric:tabular-nums}
  .codeview .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5}
  .diff .row{display:grid;grid-template-columns:44px 44px 14px 1fr;min-width:0}
  .diff .row.add{background:#dafbe1}
  .diff .row.del{background:#ffebe9}
  .diff .row.hunk{background:#ddf4ff;color:#0969da;
    grid-template-columns:1fr;padding:1px 12px}
  .diff .ln{color:#8c959f;text-align:right;padding:0 6px;
    user-select:none;font-variant-numeric:tabular-nums}
  .diff .sign{text-align:center;color:#656d76;user-select:none}
  .diff .row.add .sign{color:#1a7f37}
  .diff .row.del .sign{color:#cf222e}
  .diff .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
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
    ? `${readResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
    : hasResult
      ? (diffResultHtml
        ? `${diffResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
        : `<section><h2>result</h2><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></section>`)
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
    ? `<section><details><summary>transcript (${transcript.split("\n").length} 行)</summary><pre><code>${ansiToHtml(transcript)}</code></pre></details></section>`
    : ""}
</div></body></html>`;
};

// ── Turn (brief-mode) 聚合页 ────────────────────────────────────────────
// 一个 turn 内的所有 item 按 ts 序渲染成 claude.ai 风格气泡时间线。
// tool_use 与其配对的 tool_result 合并为一个可折叠 section (按 toolUseId 匹配)。
// assistant text 用客户端 markdown-it + highlight.js 富文本渲染 —— 服务端只输出
// 转义后的原文放到 data-md, 页尾脚本一次性 render 到 .md-body。未 closed 时页面
// 每 2s meta-refresh, closed 后移除 refresh + 状态徽章切「已完成 · 用时Xs」。
const TURN_CSS = `
  .bubbles{display:flex;flex-direction:column;gap:14px;margin-top:8px}
  .bubble{background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden}
  .bubble.assistant{background:#fff}
  .bubble.final{border-color:#1a7f3766;box-shadow:0 0 0 2px #1a7f3714}
  .bubble.tool{background:#fafbfc}
  .bubble.approval{background:#fbfaff}
  .bubble-head{display:flex;align-items:center;gap:8px;padding:10px 14px;
    font-size:13px;color:#1f2328;flex-wrap:wrap}
  .bubble-head .role{font-weight:600}
  .bubble-head .ts{margin-left:auto;color:#8c959f;font-size:11px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .bubble-head .compact{color:#656d76;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .md-body{padding:2px 16px 14px;color:#1f2328;line-height:1.65;font-size:14px}
  .md-body p{margin:.6em 0}
  .md-body h1,.md-body h2,.md-body h3{margin:1em 0 .4em;font-weight:600}
  .md-body h1{font-size:1.4em}.md-body h2{font-size:1.2em}.md-body h3{font-size:1.05em}
  .md-body ul,.md-body ol{margin:.6em 0;padding-left:1.6em}
  .md-body li{margin:.2em 0}
  .md-body code{background:#f6f8fa;border-radius:4px;padding:1px 5px;font-size:.9em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .md-body pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;
    margin:.7em 0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .md-body pre code{background:transparent;padding:0;font-size:12.5px;line-height:1.5}
  .md-body pre code.hljs{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .md-body blockquote{margin:.6em 0;padding:.2em 1em;border-left:3px solid #d0d7de;color:#656d76}
  .md-body table{border-collapse:collapse;margin:.7em 0}
  .md-body th,.md-body td{border:1px solid #d0d7de;padding:6px 10px}
  .md-body a{color:#0969da;text-decoration:none}
  .md-body a:hover{text-decoration:underline}
  .bubble details{border-top:1px solid #eaeef2}
  .bubble details summary{background:#f6f8fa;border-bottom:0}
  .typing{color:#8c959f;font-style:italic;padding:10px 14px;
    background:#fff;border:1px dashed #d0d7de;border-radius:12px}
  .typing::after{content:"";display:inline-block;width:6px;height:6px;
    background:#8c959f;border-radius:50%;margin-left:6px;
    animation:blink 1.2s infinite}
  @keyframes blink{0%,60%,100%{opacity:.2}30%{opacity:1}}
  .turn-info{display:flex;flex-wrap:wrap;gap:6px;margin:-6px 0 12px}
  .turn-info:empty{display:none}
  .chip{font-size:11px;padding:2px 8px;border-radius:10px;background:#f6f8fa;
    color:#57606a;border:1px solid #d0d7de55;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-variant-numeric:tabular-nums}
  .chip.model{color:#0969da;background:#0969da10;border-color:#0969da33;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .chip.ctx{position:relative;font-weight:600;border-color:currentColor;
    background:linear-gradient(to right,
      color-mix(in srgb,var(--fc) 16%,transparent) var(--fill),
      #f6f8fa var(--fill));overflow:hidden}
  .chip.ctx::after{content:"";position:absolute;left:0;bottom:0;height:2px;
    width:var(--fill);background:var(--fc)}
  .chip.ctx b{font-weight:700}
  .chip.mini{font-size:10.5px;opacity:.72;padding:2px 6px}
  .chip.mini.cache{color:#8250df;opacity:.85}
  .chip.tier{color:#9a6700;background:#9a670010;border-color:#9a670033}
  .chip.muted{opacity:.55}
`;

const renderJsonSection = (input: unknown): string =>
  `<details><summary>input</summary><pre><code>${highlightJson(toJson(input))}</code></pre></details>`;

const renderToolBubble = (
  use: Extract<TurnItem, { t: "tool_use" }>,
  result: Extract<TurnItem, { t: "tool_result" }> | undefined,
): string => {
  const isBash = use.toolName === "Bash";
  const isRead = use.toolName === "Read";
  const bashHtml = isBash ? renderBashCommand(use.toolInput) : "";
  const diffBlocks = extractDiffBlocks(use.toolName, use.toolInput);
  const diffHtml = diffBlocks.map(renderDiffBlock).join("");
  const rawResult = result?.body ?? "";
  const readResultHtml = isRead && rawResult ? renderReadContent(rawResult, extractFilePath(use.toolInput)) : "";
  const diffResultHtml = rawResult && !isRead ? tryRenderUnifiedDiff(rawResult) : "";
  const primary = [bashHtml, diffHtml, readResultHtml, diffResultHtml].filter(Boolean).join("");
  // primary 已把命令/路径完整展示 —— 头部的一行 compact 只会重复它, 有 primary 时省掉。
  const compact = primary ? "" : `<span class="compact">${escHtml(oneLineCompact(use.toolInput))}</span>`;
  const inputSection = primary
    ? renderJsonSection(use.toolInput)
    : `<details open><summary>input</summary><pre><code>${highlightJson(toJson(use.toolInput))}</code></pre></details>`;
  const resultRaw = rawResult
    ? `<details><summary>result (raw)</summary><pre><code>${ansiToHtml(rawResult)}</code></pre></details>`
    : `<details><summary>result</summary><pre style="color:#656d76;font-style:italic;margin:0;padding:12px"><code>(尚未捕获)</code></pre></details>`;
  return `<section class="bubble tool">
    <div class="bubble-head">🔧 <span class="role">${escHtml(use.toolName)}</span>
      ${compact}
      <span class="ts">${fmtTs(use.ts)}</span></div>
    ${primary}
    ${inputSection}
    ${resultRaw}
  </section>`;
};

const oneLineCompact = (input: unknown, max = 100): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return truncate(pick.replace(/\s+/g, " ").trim(), max);
  }
  try { return truncate(JSON.stringify(input) ?? "", max); } catch { return ""; }
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const extractFilePath = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>).file_path;
  return typeof v === "string" ? v : "";
};

const renderTextBubble = (item: Extract<TurnItem, { t: "text" }>): string => {
  const role = item.final ? "assistant · final" : "assistant";
  const cls = item.final ? "bubble final" : "bubble assistant";
  // 原文用 <script type="text/plain"> 承载 —— 免转义歧义, JS 端 textContent 读回原样。
  return `<section class="${cls}">
    <div class="bubble-head"><span class="role">${escHtml(role)}</span>
      <span class="ts">${fmtTs(item.ts)}</span></div>
    <div class="md-body"></div>
    <script type="text/plain" class="md-src">${escHtml(item.body)}</script>
  </section>`;
};

const renderApprovalItem = (item: Extract<TurnItem, { t: "approval" }>): string => {
  const b = decisionBadge(item.decision);
  return `<section class="bubble approval">
    <div class="bubble-head">🔐 <span class="role">${escHtml(item.toolName)}</span>
      <span class="badge ${b.cls}">${b.label}</span>
      <span class="ts">${fmtTs(item.ts)}</span></div>
  </section>`;
};

const pairItems = (items: readonly TurnItem[]): Array<{ kind: "solo"; item: TurnItem } | { kind: "pair"; use: Extract<TurnItem, { t: "tool_use" }>; result?: Extract<TurnItem, { t: "tool_result" }> }> => {
  const results = new Map<string, Extract<TurnItem, { t: "tool_result" }>>();
  for (const it of items) if (it.t === "tool_result") results.set(it.toolUseId, it);
  const paired: ReturnType<typeof pairItems> = [];
  const consumed = new Set<string>();
  for (const it of items) {
    if (it.t === "tool_use") {
      const r = results.get(it.toolUseId);
      if (r) consumed.add(it.toolUseId);
      paired.push({ kind: "pair", use: it, result: r });
    } else if (it.t === "tool_result") {
      if (consumed.has(it.toolUseId)) continue; // 已附在 tool_use bubble 里
      paired.push({ kind: "solo", item: it });
    } else {
      paired.push({ kind: "solo", item: it });
    }
  }
  return paired;
};

const renderTurnPage = (r: TurnDetailRecord): string => {
  const items = [...r.items].sort((a, b) => a.ts - b.ts);
  const paired = pairItems(items);
  const bodies = paired.map((p) => {
    if (p.kind === "pair") return renderToolBubble(p.use, p.result);
    const it = p.item;
    if (it.t === "text") return renderTextBubble(it);
    if (it.t === "approval") return renderApprovalItem(it);
    if (it.t === "tool_result") {
      return `<section class="bubble tool">
        <div class="bubble-head">↩ <span class="role">tool_result</span>
          <span class="compact">${escHtml(it.toolUseId)}</span>
          <span class="ts">${fmtTs(it.ts)}</span></div>
        <details open><summary>result</summary><pre><code>${escHtml(it.body)}</code></pre></details>
      </section>`;
    }
    return "";
  }).join("");
  // 出现 assistant·final 即视为本轮结束 —— closeTurn 可能滞后, 但 final 就是最后一条。
  const done = r.closed || items.some((it) => it.t === "text" && it.final === true);
  const ageMs = (done ? r.updatedAt : Date.now()) - r.createdAt;
  const statusBadge = done
    ? `<span class="badge allow">已完成 · ${fmtDuration(ageMs)}</span>`
    : `<span class="badge pending">进行中</span>`;
  const modelChip = r.model
    ? `<span class="chip model">${escHtml(r.model)}${r.modelAlt ? ` +${r.modelAlt}` : ""}</span>`
    : "";
  const u = r.usage;
  // 上下文 = 单次 API 调用送入的 input+缓存读+缓存写 的峰值 —— 窗口占用高水位。
  // 关键: 一个 turn 里 N 次调用各自重读同一缓存前缀, 累计 cacheRead 会远大于窗口实际
  // 占用 (例: 43 次调用累计 2.6M, 窗口其实只有 ~82k)。所以主指标用峰值, 不用求和。
  // Σ 前缀的 chip 是累计计费口径, 与上下文峰值语义分开。
  const ctxPeak = u ? (u.ctxPeak ?? (u.input + u.cacheRead + u.cacheWrite)) : 0;
  const win = ctxWindow(r.model);
  const pct = Math.min(100, Math.round((ctxPeak / win) * 100));
  const pres = ctxPressure(pct);
  const usageChips = u
    ? [
        `<span class="chip ctx" style="--fill:${pct}%;--fc:${pres.fill};color:${pres.text}" title="单次调用送入模型的上下文峰值 = 窗口占用高水位, 占 ${fmtTok(win)} 窗口的 ${pct}%。${u.calls} 次调用各自重读缓存前缀, 故下方 Σ 累计值远大于此。">上下文 <b>${fmtTok(ctxPeak)}</b> / ${fmtTok(win)} · ${pct}%</span>`,
        `<span class="chip mini" title="累计: 未命中缓存的新鲜输入">Σin ${fmtTok(u.input)}</span>`,
        u.cacheRead ? `<span class="chip mini cache" title="累计: 缓存命中读取 (计费约 0.1×), 含跨调用重读前缀">Σ↻ ${fmtTok(u.cacheRead)}</span>` : "",
        u.cacheWrite ? `<span class="chip mini cache" title="累计: 写入缓存 (计费约 1.25×)">Σ+ ${fmtTok(u.cacheWrite)}</span>` : "",
        `<span class="chip mini" title="累计: 生成输出">Σout ${fmtTok(u.output)}</span>`,
        u.serviceTier && u.serviceTier !== "standard" ? `<span class="chip tier">${escHtml(u.serviceTier)}</span>` : "",
        `<span class="chip muted">${u.calls} call${u.calls > 1 ? "s" : ""}</span>`,
      ].filter(Boolean).join("")
    : "";
  const turnInfo = `<div class="turn-info">${modelChip}${usageChips}</div>`;
  const metaParts = [
    fmtTs(r.createdAt),
    r.sessionId ? r.sessionId.slice(0, 8) : null,
    r.target || null,
    `${items.length} 项`,
  ].filter(Boolean) as string[];
  const typing = done ? "" : `<div class="typing">Claude 正在思考</div>`;
  // markdown-it + highlight.js from unpkg CDN. html:false 防注入; linkify + breaks 更贴聊天。
  // 未 closed 时客户端 2s 轮询同一 URL — DOMParser 抽 .bubbles 换 innerHTML, 不做整页刷新,
  // 保留滚动位置 + CDN 缓存。closed 时 body[data-closed=1], 轮询自终止。
  const script = `
(function(){
  var render = function(scope){
    if(!window.markdownit) return;
    var hl = function(str,lang){
      if(lang && window.hljs){
        try{return window.hljs.highlight(str,{language:lang,ignoreIllegals:true}).value}catch(e){}
      }
      if(window.hljs){try{return window.hljs.highlightAuto(str).value}catch(e){}}
      return '';
    };
    var md = window.markdownit({html:false, linkify:true, breaks:true, highlight:hl});
    scope.querySelectorAll('.bubble').forEach(function(b){
      var src = b.querySelector('script.md-src');
      var body = b.querySelector('.md-body');
      if(src && body){ body.innerHTML = md.render(src.textContent||''); }
    });
  };
  render(document);
  if(document.body.dataset.closed === '1') return;
  var url = location.href;
  var tick = function(){
    fetch(url, {cache:'no-store'}).then(function(r){return r.text()}).then(function(html){
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var newBubbles = doc.querySelector('.bubbles');
      var curBubbles = document.querySelector('.bubbles');
      if(newBubbles && curBubbles){
        curBubbles.innerHTML = newBubbles.innerHTML;
        render(curBubbles);
      }
      var newBadge = doc.querySelector('header .badge');
      var curBadge = document.querySelector('header .badge');
      if(newBadge && curBadge){ curBadge.outerHTML = newBadge.outerHTML; }
      var newInfo = doc.querySelector('.turn-info');
      var curInfo = document.querySelector('.turn-info');
      if(newInfo && curInfo){ curInfo.outerHTML = newInfo.outerHTML; }
      var nowClosed = doc.body.dataset.closed === '1';
      if(nowClosed){ document.body.dataset.closed = '1'; return; }
      setTimeout(tick, 2000);
    }).catch(function(){ setTimeout(tick, 2000); });
  };
  setTimeout(tick, 2000);
})();
`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>本轮工具调用</title>
<link rel="stylesheet" href="https://unpkg.com/highlight.js@11/styles/github.min.css">
<style>${SHARED_CSS}${TURN_CSS}</style>
<script src="https://unpkg.com/markdown-it@14/dist/markdown-it.min.js"></script>
<script src="https://unpkg.com/@highlightjs/cdn-assets@11/highlight.min.js"></script>
</head><body data-closed="${done ? "1" : "0"}"><div class="wrap">
<header><h1><span class="accent">本轮工具调用</span></h1>${statusBadge}</header>
${turnInfo}
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
<div class="bubbles">${bodies}${typing}</div>
</div>
<script>${script}</script>
</body></html>`;
};

export const renderDetailPage = (r: DetailRecord): string => {
  if (r.kind === "tool") return renderToolPage(r);
  if (r.kind === "turn") return renderTurnPage(r);
  return renderApprovalPage(r);
};

export const renderNotFound = (id: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;background:#f6f8fa;color:#1f2328;padding:60px 20px;text-align:center"><p style="color:#656d76">未找到 <code style="background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:2px 6px;font-family:ui-monospace,monospace">${escHtml(id)}</code></p></body>`;
