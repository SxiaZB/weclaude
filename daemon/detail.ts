// 工具调用详情 store + 本地 HTML 渲染。
// 两类记录:
//   • tool      ← 镜像 tail 抓到 tool_use / tool_result 时落库, 镜像消息把工具行渲染为
//                 🔧 [name ...](http://host:port/detail?id=<toolUseId>) 的 markdown 链接,
//                 用户在 WeCom 桌面端点链接 → 系统浏览器打开本机 URL → 看完整 input/result。
//   • approval  ← 授权卡片落库, 卡片 jump_list 多一个 "🔍 详情", 点开看完整入参 / 决策。
// 持久化: append-only JSONL → stateDir/details.jsonl, 启动 replay; 文件超过 COMPACT_BYTES
// 时按 store 重写以丢弃过期 / 被覆盖的旧行。TTL 24h, 上限 1000 条 LRU。
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Decision } from "./pending.js";
import type { Handler } from "./http.js";
import { expandHome } from "../shared/paths.js";

type Kind = "tool" | "approval";

interface BaseRecord {
  kind: Kind;
  id: string;
  createdAt: number;
}

export interface ToolDetailRecord extends BaseRecord {
  kind: "tool";
  toolName: string;
  toolInput: unknown;
  toolResult?: string;
  resultAt?: number;
  target?: string;
  sessionId?: string;
}

export interface ApprovalDetailRecord extends BaseRecord {
  kind: "approval";
  toolName: string;
  toolInput: unknown;
  cwd: string;
  sessionId: string;
  transcriptTail: string;
  decision?: Decision | "timeout" | "swept";
  decidedBy?: string;
  decidedAt?: number;
}

type DetailRecord = ToolDetailRecord | ApprovalDetailRecord;

const store = new Map<string, DetailRecord>();
const TTL_MS = 24 * 3600_000;
const MAX = 1000;
const COMPACT_BYTES = 5 * 1024 * 1024;
let logPath = "";

const gc = (): void => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of store) if (v.createdAt < cutoff) store.delete(k);
  if (store.size > MAX) {
    const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < sorted.length - MAX; i++) store.delete(sorted[i]![0]);
  }
};

// 每次 record* 落地一行最新快照, replay 时同 id "末次写入获胜"。失败静默 — 持久化
// 是 nice-to-have, 出错不该阻塞工具调用主流程。
const persist = (rec: DetailRecord): void => {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(rec)}\n`);
  } catch {
    /* ignore */
  }
};

const compact = (): void => {
  if (!logPath) return;
  const lines = [...store.values()].map((r) => JSON.stringify(r));
  try {
    writeFileSync(logPath, lines.length ? `${lines.join("\n")}\n` : "");
  } catch {
    /* ignore */
  }
};

const maybeCompact = (): void => {
  if (!logPath) return;
  try {
    if (statSync(logPath).size > COMPACT_BYTES) compact();
  } catch {
    /* ignore */
  }
};

export const initDetailPersistence = (stateDir: string, log?: Logger): void => {
  const dir = expandHome(stateDir);
  mkdirSync(dir, { recursive: true });
  logPath = join(dir, "details.jsonl");
  if (!existsSync(logPath)) {
    log?.info({ logPath }, "detail persistence: fresh log");
    return;
  }
  const cutoff = Date.now() - TTL_MS;
  let replayed = 0, dropped = 0;
  try {
    const text = readFileSync(logPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as DetailRecord;
        if (!r?.id || (r.kind !== "tool" && r.kind !== "approval")) continue;
        if (typeof r.createdAt !== "number" || r.createdAt < cutoff) { dropped++; continue; }
        store.set(r.id, r); // last write wins
        replayed++;
      } catch {
        /* skip malformed line */
      }
    }
  } catch (e) {
    log?.warn({ err: (e as Error).message }, "detail persistence: replay failed");
  }
  // replay 后强制 gc + 顺手 compact, 把过期行从磁盘清掉
  gc();
  compact();
  log?.info({ logPath, replayed, dropped, kept: store.size }, "detail persistence: replay done");
};

// ── tool ──────────────────────────────────────────────────────────────
export const recordTool = (rec: Omit<ToolDetailRecord, "kind" | "createdAt"> & { createdAt?: number }): void => {
  const full: ToolDetailRecord = { kind: "tool", ...rec, createdAt: rec.createdAt ?? Date.now() };
  store.set(rec.id, full);
  if (store.size > MAX) gc();
  persist(full);
  maybeCompact();
};

export const recordToolResult = (toolUseId: string, full: string): void => {
  const r = store.get(toolUseId);
  if (!r || r.kind !== "tool") return;
  const next: ToolDetailRecord = { ...r, toolResult: full, resultAt: Date.now() };
  store.set(toolUseId, next);
  persist(next);
};

// ── approval ──────────────────────────────────────────────────────────
export const recordApproval = (
  rec: Omit<ApprovalDetailRecord, "kind" | "createdAt" | "decision" | "decidedAt" | "decidedBy"> & { createdAt?: number },
): void => {
  const full: ApprovalDetailRecord = { kind: "approval", ...rec, createdAt: rec.createdAt ?? Date.now() };
  store.set(rec.id, full);
  if (store.size > MAX) gc();
  persist(full);
  maybeCompact();
};

export const recordApprovalDecision = (
  reqId: string,
  decision: ApprovalDetailRecord["decision"],
  decidedBy?: string,
): void => {
  const r = store.get(reqId);
  if (!r || r.kind !== "approval") return;
  const next: ApprovalDetailRecord = { ...r, decision, decidedBy, decidedAt: Date.now() };
  store.set(reqId, next);
  persist(next);
};

export const getDetail = (id: string): DetailRecord | undefined => store.get(id);

// ── URL helper ────────────────────────────────────────────────────────
// forceInnerBrowser=1 / ww_vw / ww_vh: WeCom 桌面端识别参数, 让链接在内置浏览器打开,
// 同时把视口宽高带回服务端 (此处仅占位, 由 WeCom 客户端注入实际值)。
export const buildDetailUrl = (
  publicBase: string,
  fallbackHost: string,
  fallbackPort: number,
  id: string,
): string => {
  const root = publicBase && publicBase.length > 0
    ? publicBase.replace(/\/+$/, "")
    : `http://${fallbackHost === "0.0.0.0" ? "127.0.0.1" : fallbackHost}:${fallbackPort}`;
  const params = new URLSearchParams({
    id,
    forceInnerBrowser: "1",
    ww_vw: "1000",
    ww_vh: "800",
  });
  return `${root}/detail?${params.toString()}`;
};

// ── HTML rendering ────────────────────────────────────────────────────
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

const decisionBadge = (d?: ApprovalDetailRecord["decision"]): { label: string; cls: string } => {
  if (!d) return { label: "待审批", cls: "pending" };
  if (d === "deny") return { label: "拒绝", cls: "deny" };
  if (d === "timeout") return { label: "超时", cls: "warn" };
  if (d === "allow_window") return { label: "通过 · 窗口", cls: "allow" };
  if (d === "allow_session") return { label: "通过 · 会话", cls: "allow" };
  if (d === "swept") return { label: "通过 · 批量", cls: "allow" };
  if (d === "allow") return { label: "通过", cls: "allow" };
  return { label: String(d), cls: "pending" };
};

// 服务端正则高亮: 不引外部 JS / CSS, 离线可用。
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
  try {
    return JSON.stringify(v, null, 2) ?? "null";
  } catch {
    return String(v);
  }
};

const SHARED_CSS = `
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

// ── git-style diff ────────────────────────────────────────────────────
type DiffOp = { tag: "eq" | "del" | "add"; text: string };

// LCS-based 行级 diff。m*n DP, 输入超过 LCS_LIMIT 行就降级为 del-then-add,
// 避免 Write 巨型文件 / 跑大 input 时 OOM。
const LCS_LIMIT = 1500;
const lineDiff = (a: string, b: string): DiffOp[] => {
  const A = a === "" ? [] : a.split("\n");
  const B = b === "" ? [] : b.split("\n");
  const m = A.length, n = B.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return B.map((t) => ({ tag: "add" as const, text: t }));
  if (n === 0) return A.map((t) => ({ tag: "del" as const, text: t }));
  if (m > LCS_LIMIT || n > LCS_LIMIT) {
    return [
      ...A.map((t) => ({ tag: "del" as const, text: t })),
      ...B.map((t) => ({ tag: "add" as const, text: t })),
    ];
  }
  // dp[i][j] = LCS length of A[i..] vs B[j..]
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ tag: "eq", text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ tag: "del", text: A[i]! }); i++; }
    else { out.push({ tag: "add", text: B[j]! }); j++; }
  }
  while (i < m) out.push({ tag: "del", text: A[i++]! });
  while (j < n) out.push({ tag: "add", text: B[j++]! });
  return out;
};

// 把连续 eq 行折叠成 hunk。CTX 行数控制紧邻变更的上下文保留量。
interface HunkRow { tag: DiffOp["tag"] | "hunk"; text: string; oldLn?: number; newLn?: number }
const CTX = 3;
const buildHunks = (ops: DiffOp[]): HunkRow[] => {
  // 给所有 op 打上左右行号
  let oa = 1, nb = 1;
  type Annotated = DiffOp & { oa?: number; nb?: number };
  const ann: Annotated[] = ops.map((o) => {
    const r: Annotated = { ...o };
    if (o.tag === "eq") { r.oa = oa++; r.nb = nb++; }
    else if (o.tag === "del") { r.oa = oa++; }
    else { r.nb = nb++; }
    return r;
  });
  // 找出每个变更附近 CTX 行的窗口, 合并相邻窗口
  const keep = new Array<boolean>(ann.length).fill(false);
  ann.forEach((o, idx) => {
    if (o.tag !== "eq") {
      for (let k = Math.max(0, idx - CTX); k <= Math.min(ann.length - 1, idx + CTX); k++) keep[k] = true;
    }
  });
  const out: HunkRow[] = [];
  let inHunk = false, hunkStartOa = 1, hunkStartNb = 1, hunkOa = 0, hunkNb = 0;
  let pendingRows: HunkRow[] = [];
  const flushHunk = (): void => {
    if (pendingRows.length === 0) return;
    out.push({
      tag: "hunk",
      text: `@@ -${hunkStartOa},${hunkOa} +${hunkStartNb},${hunkNb} @@`,
    });
    out.push(...pendingRows);
    pendingRows = [];
    inHunk = false;
  };
  ann.forEach((o, idx) => {
    if (!keep[idx]) {
      flushHunk();
      return;
    }
    if (!inHunk) {
      hunkStartOa = o.oa ?? (o.tag === "add" ? Math.max(1, (ann[idx]?.nb ?? 1)) : 1);
      hunkStartNb = o.nb ?? 1;
      // pure-add 起点的 oa 用前一行 oa+1, pure-del 起点的 nb 同理 — 只是 header 显示, 不严
      hunkOa = 0; hunkNb = 0;
      inHunk = true;
    }
    pendingRows.push({ tag: o.tag, text: o.text, oldLn: o.oa, newLn: o.nb });
    if (o.tag !== "add") hunkOa++;
    if (o.tag !== "del") hunkNb++;
  });
  flushHunk();
  return out;
};

const renderDiffRows = (rows: HunkRow[]): string => {
  return rows.map((r) => {
    if (r.tag === "hunk") {
      return `<div class="row hunk">${escHtml(r.text)}</div>`;
    }
    const sign = r.tag === "add" ? "+" : r.tag === "del" ? "-" : " ";
    const oldLn = r.oldLn !== undefined ? r.oldLn : "";
    const newLn = r.newLn !== undefined ? r.newLn : "";
    return `<div class="row ${r.tag}"><div class="ln">${oldLn}</div><div class="ln">${newLn}</div><div class="sign">${sign}</div><div class="txt">${escHtml(r.text) || "&nbsp;"}</div></div>`;
  }).join("");
};

interface DiffBlock { path: string; oldStr: string; newStr: string; label?: string }

const renderDiffBlock = (b: DiffBlock): string => {
  const ops = lineDiff(b.oldStr, b.newStr);
  const rows = buildHunks(ops);
  const adds = ops.filter((o) => o.tag === "add").length;
  const dels = ops.filter((o) => o.tag === "del").length;
  const head = b.label ? `${escHtml(b.label)} · ` : "";
  return `<section>
    <h2>${head}<span style="color:#1a7f37">+${adds}</span> <span style="color:#cf222e">-${dels}</span>${b.path ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0">${escHtml(b.path)}</span>` : ""}</h2>
    <div class="diff">${renderDiffRows(rows)}</div>
  </section>`;
};

// 从 Edit / MultiEdit / Write 入参里抽 DiffBlock 列表。识别失败返回 [] → 走通用 JSON 渲染。
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


const renderToolPage = (r: ToolDetailRecord): string => {
  const inputJson = highlightJson(toJson(r.toolInput));
  const hasResult = typeof r.toolResult === "string" && r.toolResult.length > 0;
  const resultBlock = hasResult
    ? `<section><h2>result</h2><pre><code>${escHtml(r.toolResult!)}</code></pre></section>`
    : `<section><h2>result</h2><pre style="color:#656d76;font-style:italic"><code>(尚未捕获)</code></pre></section>`;
  const status = hasResult
    ? `<span class="badge allow">完成${r.resultAt ? ` · ${fmtDuration(r.resultAt - r.createdAt)}` : ""}</span>`
    : `<span class="badge pending">运行中</span>`;
  const diffBlocks = extractDiffBlocks(r.toolName, r.toolInput);
  const diffSection = diffBlocks.map(renderDiffBlock).join("");
  const inputSection = diffBlocks.length > 0
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

const notFound = (id: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;background:#f6f8fa;color:#1f2328;padding:60px 20px;text-align:center"><p style="color:#656d76">未找到 <code style="background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:2px 6px;font-family:ui-monospace,monospace">${escHtml(id)}</code></p></body>`;

export const makeDetailHandler = (log: Logger): Handler => {
  return (_req, res, url) => {
    const id = url.searchParams.get("id") ?? "";
    if (!id) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("missing ?id=");
      return;
    }
    const rec = getDetail(id);
    if (!rec) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(notFound(id));
      log.info({ id }, "detail not found");
      return;
    }
    const html = rec.kind === "tool" ? renderToolPage(rec) : renderApprovalPage(rec);
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(html);
  };
};
