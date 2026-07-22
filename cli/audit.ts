// Slash-command entry: `weclaude audit [tag]`.
//   - With a tag: ask the daemon for the newest-by-mtime mirror whose target
//     carries `#<tag>` and audit THAT session (regardless of which CLI/pane
//     the command was fired from). Fails hard when the daemon is down or no
//     match — falling back to "current session" would silently mis-answer.
//   - Without a tag: resolve the caller's own session (via
//     $CLAUDE_CODE_SESSION_ID or newest-mtime jsonl under the project dir),
//     print locally, and — when the daemon is up and this session is
//     mirrored — also push the report into WeCom.
// WeCom-side `/audit` doesn't go through here; daemon/inbound.ts intercepts
// it and calls computeAuditReport directly (bypasses the flaky tmux paste path).
import { readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { computeAuditReport } from "../daemon/audit.js";

const DAEMON_BASE = process.env.WECLAUDE_DAEMON_BASE || "http://127.0.0.1:17890";

const PROJECT_BASES = [
  join(homedir(), ".claude-internal", "projects"),
  join(homedir(), ".claude", "projects"),
];

const findProjectDir = (cwd: string): string | null => {
  let probe = cwd;
  while (probe) {
    const enc = probe.replace(/[/.]/g, "-");
    for (const base of PROJECT_BASES) {
      const p = join(base, enc);
      if (existsSync(p)) return p;
    }
    if (probe === "/") break;
    const parent = probe.slice(0, probe.lastIndexOf("/")) || "/";
    if (parent === probe) break;
    probe = parent;
  }
  return null;
};

const resolveSessionId = (proj: string): string | null => {
  const envSid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (envSid && existsSync(join(proj, `${envSid}.jsonl`))) return envSid;
  let latest: { sid: string; mtime: number } | null = null;
  for (const f of readdirSync(proj)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = join(proj, f);
    try {
      const st = statSync(fp);
      if (!latest || st.mtimeMs > latest.mtime) {
        latest = { sid: basename(f, ".jsonl"), mtime: st.mtimeMs };
      }
    } catch { /* ignore */ }
  }
  return latest?.sid ?? null;
};

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

interface MirrorRef { sessionId: string; jsonlPath: string; target: string; }

// Ask daemon for all live mirrors, then filter to targets carrying `#<tag>`
// and pick the newest by jsonl mtime. Returns null when daemon is unreachable
// or no mirror matches.
const findMirrorByTag = async (tag: string): Promise<MirrorRef | null> => {
  const wanted = tag.replace(/^#/, "");
  try {
    const res = await fetch(`${DAEMON_BASE}/mirror/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const status = (await res.json()) as { mirrors?: MirrorRef[] };
    const matches = (status.mirrors ?? []).filter((m) => (m.target.split("#")[1] ?? "") === wanted);
    if (matches.length === 0) return null;
    const ranked = matches
      .map((m) => {
        let mt = 0;
        try { mt = statSync(expandHome(m.jsonlPath)).mtimeMs; } catch { /* ignore */ }
        return { m, mt };
      })
      .sort((a, b) => b.mt - a.mt);
    return ranked[0]?.m ?? null;
  } catch { return null; }
};

// Slash-command output goes into the jsonl as a `tool_result` under a user turn;
// mirror-bridge only tails `assistant` lines, so WeCom never sees it. Ask the
// daemon to push directly to whichever chat mirrors this session. Silent-fail
// when the daemon is down or no mirror is bound — local stdout is enough.
const pushToWeCom = async (sid: string, markdown: string): Promise<void> => {
  try {
    const statusRes = await fetch(`${DAEMON_BASE}/mirror/status`, { signal: AbortSignal.timeout(2000) });
    if (!statusRes.ok) return;
    const status = (await statusRes.json()) as { mirrors?: MirrorRef[] };
    const target = (status.mirrors ?? []).find((m) => m.sessionId === sid)?.target;
    if (!target) return;
    await fetch(`${DAEMON_BASE}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat: target, markdown }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* daemon unreachable — local stdout is enough */ }
};

const main = async (): Promise<void> => {
  const tag = (process.argv.slice(2).join(" ") || "").trim().replace(/^#/, "");

  if (tag) {
    const mirror = await findMirrorByTag(tag);
    if (!mirror) {
      console.error(`no mirror found for tag \`${tag}\` (daemon down or session not attached)`);
      process.exit(1);
    }
    const jsonlPath = expandHome(mirror.jsonlPath);
    if (!existsSync(jsonlPath)) {
      console.error(`mirror jsonl missing: ${jsonlPath}`);
      process.exit(1);
    }
    const report = computeAuditReport({ sessionId: mirror.sessionId, jsonlPath, tag });
    console.log(report);
    await pushToWeCom(mirror.sessionId, report);
    return;
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const proj = findProjectDir(cwd);
  if (!proj) {
    console.error(`no claude project dir for cwd: ${cwd}`);
    process.exit(1);
  }
  const sid = resolveSessionId(proj);
  if (!sid) {
    console.error(`no .jsonl under ${proj}`);
    process.exit(1);
  }
  const jsonlPath = join(proj, `${sid}.jsonl`);
  if (!existsSync(jsonlPath)) {
    console.error(`main jsonl missing: ${jsonlPath}`);
    process.exit(1);
  }
  const report = computeAuditReport({ sessionId: sid, jsonlPath });
  console.log(report);
  await pushToWeCom(sid, report);
};

main();
