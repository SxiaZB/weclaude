// CLI backend descriptors. Claude Code / claude-internal forks / CodeBuddy
// all share the headless stream-json + hook protocol shape, but differ in:
//   - binary name + config home (~/.claude vs ~/.claude-internal vs ~/.codebuddy)
//   - on-disk project-dir encoding (Claude: leading `-`; CodeBuddy: none)
//   - jsonl transcript schema (CodeBuddy splits tool_use / tool_result into
//     independent top-level records; Claude Code nests them in message.content)
//   - slash-command injection tag dialect: verified identical (<command-name> /
//     <system-reminder>), so no tag-regex dispatch needed.
//
// normalizeTranscriptLine maps a backend's raw jsonl line into the Claude Code
// TranscriptLine shape that mirror-bridge's renderLine consumes. Claude backends
// are identity; codebuddy does the schema adapter work.

export type CliBackendName = "claude" | "claude-internal" | "codebuddy";

// Normalized transcript line — structurally compatible with mirror-bridge's
// TranscriptLine. Defined here (not imported from mirror-bridge) to keep the
// shared layer free of daemon dependencies. mirror-bridge casts the return
// value to its own TranscriptLine; the shapes match field-for-field.
export interface NormalizedContentBlock {
  type?: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string; tool_name?: string }>;
}

export interface NormalizedTranscriptLine {
  type?: string;
  /** Present on `type:"system"` lines — e.g. "local_command" for slash-command
   *  invocation records (Claude Code only; codebuddy has no system lines). */
  subtype?: string;
  /** Top-level content for `type:"system"` lines. */
  content?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: string | NormalizedContentBlock[];
    stop_reason?: string;
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
    };
  };
  isMeta?: boolean;
  isSidechain?: boolean;
}

export interface CliBackend {
  /** Stable identifier used in config + logs. */
  name: CliBackendName;
  /** Executable name (resolved via $PATH) or absolute path. */
  bin: string;
  /** Config home, e.g. `~/.claude`. Locates settings.json + projects/. */
  homeDir: string;
  /** Transcript root: `<projectsDir>/<encoded(cwd)>/<sid>.jsonl`. */
  projectsDir: string;
  /** settings.json path inside the home dir. */
  settingsPath: string;
  /** Hook env var exporting the project cwd to child processes. */
  projectDirEnv: "CLAUDE_PROJECT_DIR" | "CODEBUDDY_PROJECT_DIR";
  /** Plugin root env var (for hooks.json `${VAR}` resolution). */
  pluginRootEnv: "CLAUDE_PLUGIN_ROOT" | "CODEBUDDY_PLUGIN_ROOT";
  /** Args required to emit `stream_event` content_block_delta lines in
   *  headless `-p --output-format stream-json` mode. Claude Code enables
   *  streaming via `--verbose`; CodeBuddy needs `--include-partial-messages`.
   *  Without these, cc-bridge falls back to the whole-assistant-message path
   *  (no typewriter effect, but still functional). */
  headlessStreamingArgs: readonly string[];
  /** Encode an absolute cwd path into the on-disk project dir segment. */
  encodeProjectDir: (absCwd: string) => string;
  /** Map a raw parsed jsonl line into the Claude Code TranscriptLine shape
   *  that mirror-bridge's renderLine consumes. Returns null to drop the line
   *  (e.g. codebuddy's reasoning / file-history-snapshot / ai-title records).
   *  Claude backends are identity — their jsonl is already in the target shape. */
  normalizeTranscriptLine: (raw: unknown) => NormalizedTranscriptLine | null;
}

// Claude + claude-internal: `/` and `.` → `-`, yields a leading `-`
// (e.g. /Users/zyy/foo → -Users-zyy-foo). Verified against ~/.claude/projects.
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");

// CodeBuddy: same char mapping but trims the leading separator first, so no
// leading `-` (e.g. /Users/zyy/foo → Users-zyy-foo).
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

// Module-level encoder, bound once at daemon boot via bindCliBackend(). Defaults
// to Claude's dialect so the daemon works out-of-the-box for claude / claude-
// internal. mirror-bridge + spawn-tmux import this instead of defining their
// own, so a backend switch (claude → codebuddy) flips every call site at once.
let _encodeProjectDir: (absCwd: string) => string = encodeClaude;
export const encodeProjectDir = (absCwd: string): string => _encodeProjectDir(absCwd);

const makeClaude = (name: CliBackendName, bin: string): CliBackend => {
  const homeDir = name === "claude-internal" ? "~/.claude-internal" : "~/.claude";
  return {
    name,
    bin,
    homeDir,
    projectsDir: `${homeDir}/projects`,
    settingsPath: `${homeDir}/settings.json`,
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    pluginRootEnv: "CLAUDE_PLUGIN_ROOT",
    headlessStreamingArgs: ["--verbose"],
    encodeProjectDir: encodeClaude,
    // Claude Code jsonl is already in the TranscriptLine shape — identity pass.
    normalizeTranscriptLine: (raw) => raw as NormalizedTranscriptLine,
  };
};

// CodeBuddy jsonl adapter. Verified schema (2026-07-24, GLM-5.2 session):
//   message              → { type:"message", role:"user"|"assistant",
//                            content:[{type:"input_text"|"output_text", text}],
//                            id, parentId, status?, providerData:{agent,model,usage,...} }
//   function_call        → { type:"function_call", callId, name, arguments(JSON string),
//                            id(==host assistant msg id), parentId }
//   function_call_result → { type:"function_call_result", callId, name, status,
//                            output:{type:"text", text}, id, parentId }
//   reasoning | file-history-snapshot | ai-title | summary → drop
//
// Key structural differences from Claude Code:
//   1. content block types are input_text/output_text, not "text".
//   2. tool_use / tool_result are independent top-level records, not nested in
//      a message.content array. Adapter synthesizes assistant/user messages
//      around them so renderLine sees the Claude shape.
//   3. id/parentId → uuid/parentUuid.
//   4. Subagents live in <sid>/subagents/agent-<id>.jsonl — NOT inlined into
//      the main transcript — so no isSidechain filtering needed here.
//   5. Slash-command tags (<command-name> / <system-reminder>) are identical
//      to Claude Code — no tag-regex dialect dispatch needed.
//   6. /goal marker shape on disk: UNVERIFIED (blocker). The non-isMeta
//      fallback path in renderLine (goalStartOf on string content) should
//      catch it if codebuddy uses the same marker text, but this needs
//      confirmation from a real /goal session.
const normalizeCodebuddy = (raw: unknown): NormalizedTranscriptLine | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type as string | undefined;
  const id = r.id as string | undefined;
  const parentId = r.parentId as string | null | undefined;
  const providerData = (r.providerData ?? {}) as Record<string, unknown>;

  const uuids = { uuid: id, parentUuid: parentId ?? undefined };

  if (type === "message") {
    const role = r.role as string;
    const content = r.content as Array<{ type: string; text?: string }> | undefined;
    if (role === "user") {
      // Join input_text blocks into a single string. renderLine's string path
      // handles slash-command stripping, /goal marker detection, task-notification
      // rendering, and the isOwnInject dedup — all driven by string content.
      const text = (content ?? []).map((b) => b.text ?? "").join("");
      return { type: "user", ...uuids, message: { role: "user", content: text } };
    }
    if (role === "assistant") {
      const blocks: NormalizedContentBlock[] = (content ?? []).map((b) => ({
        type: "text",
        text: b.text ?? "",
      }));
      const msg = {
        role: "assistant",
        content: blocks,
        id: providerData.messageId as string | undefined,
        model: providerData.model as string | undefined,
        usage: providerData.usage as NormalizedTranscriptLine["message"] extends { usage?: infer U } ? U : undefined,
      };
      // Map codebuddy status:"completed" → stop_reason:"end_turn" so brief-mode's
      // turn-end flush fires. Other status values left undefined (defer to the
      // timeout-based turn-end fallback in the caller).
      const status = r.status as string | undefined;
      if (status === "completed") (msg as { stop_reason?: string }).stop_reason = "end_turn";
      return { type: "assistant", ...uuids, message: msg };
    }
    return null;
  }

  if (type === "function_call") {
    const callId = r.callId as string;
    const name = r.name as string;
    const argsRaw = r.arguments as string;
    let input: unknown;
    try {
      input = argsRaw ? JSON.parse(argsRaw) : {};
    } catch {
      input = {};
    }
    return {
      type: "assistant",
      ...uuids,
      message: { role: "assistant", content: [{ type: "tool_use", id: callId, name, input }] },
    };
  }

  if (type === "function_call_result") {
    const callId = r.callId as string;
    const output = r.output as { type?: string; text?: string } | undefined;
    const text = output?.text ?? "";
    return {
      type: "user",
      ...uuids,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text }] },
    };
  }

  // reasoning / file-history-snapshot / ai-title / summary → drop.
  return null;
};

const makeCodebuddy = (bin: string): CliBackend => ({
  name: "codebuddy",
  bin,
  homeDir: "~/.codebuddy",
  projectsDir: "~/.codebuddy/projects",
  settingsPath: "~/.codebuddy/settings.json",
  projectDirEnv: "CODEBUDDY_PROJECT_DIR",
  pluginRootEnv: "CODEBUDDY_PLUGIN_ROOT",
  // CodeBuddy: --verbose is a no-op for streaming; --include-partial-messages
  // is what emits stream_event content_block_delta lines. Keep --verbose too
  // for log parity — it's harmless and may surface diagnostics in debug mode.
  headlessStreamingArgs: ["--verbose", "--include-partial-messages"],
  encodeProjectDir: encodeCodebuddy,
  normalizeTranscriptLine: normalizeCodebuddy,
});

// Built-in defaults. `bin` is the default executable name; users override via
// `wrc.cliBackends.<name>.bin` in config.jsonc (or the legacy `wrc.claudeBin`
// for the claude / claude-internal backends — see resolveCliBackend).
export const CLI_BACKEND_DEFAULTS: Record<CliBackendName, CliBackend> = {
  claude: makeClaude("claude", "claude"),
  "claude-internal": makeClaude("claude-internal", "claude-internal"),
  codebuddy: makeCodebuddy("codebuddy"),
};

/** Minimal slice of Wrc that resolveCliBackend needs. */
export interface CliBackendsConfig {
  /** Active backend. Defaults to "claude". */
  defaultCli?: CliBackendName;
  /** Per-backend bin overrides. */
  cliBackends?: Partial<Record<CliBackendName, { bin?: string }>>;
  /** Legacy pre-v0.3 single-binary config — still honored for back-compat. */
  claudeBin?: string;
}

// Infer the default backend name from a legacy `claudeBin` basename. Only
// recognizes the two known forks; unknown bins fall back to "claude" (with
// the custom bin still preserved via the override path below).
const inferDefaultFromClaudeBin = (bin: string): CliBackendName => {
  const base = bin.split("/").pop() ?? bin;
  if (base === "claude-internal") return "claude-internal";
  if (base === "codebuddy") return "codebuddy";
  return "claude";
};

/**
 * Resolve the active backend, applying user overrides + legacy back-compat.
 *
 * Back-compat ladder (in priority order):
 *   1. Explicit `cliBackends.<name>.bin` override wins.
 *   2. `defaultCli` missing → infer from `claudeBin` basename (claude / claude-
 *      internal / codebuddy), else "claude".
 *   3. Legacy `claudeBin` set to a non-default value AND defaultCli points at
 *      the matching backend → carry `claudeBin` as the bin override. Preserves
 *      both `claudeBin: "/absolute/claude"` and `claudeBin: "claude-internal"`.
 */
export const resolveCliBackend = (cfg: CliBackendsConfig): CliBackend => {
  const name: CliBackendName = cfg.defaultCli ?? inferDefaultFromClaudeBin(cfg.claudeBin ?? "claude");
  const base = CLI_BACKEND_DEFAULTS[name];
  if (!base) throw new Error(`unknown CLI backend: ${name}`);
  const explicit = cfg.cliBackends?.[name]?.bin;
  if (explicit) return { ...base, bin: explicit };

  // Legacy `claudeBin` carries a non-default value → treat as bin override for
  // the backend it points at (matched by name, not by basename equality —
  // `/usr/local/bin/claude-internal` should still map to claude-internal).
  if (cfg.claudeBin && cfg.claudeBin !== "claude") {
    const inferred = inferDefaultFromClaudeBin(cfg.claudeBin);
    if (inferred === name) return { ...base, bin: cfg.claudeBin };
  }
  return base;
};

/**
 * Bind the active backend's dialect (encodeProjectDir) into module-level state.
 * Call once at daemon boot after loadConfig — flips mirror-bridge + spawn-tmux
 * to the resolved backend's project-dir encoding. Idempotent; re-binding on
 * daemon reload picks up a changed defaultCli without restart.
 */
export const bindCliBackend = (cfg: CliBackendsConfig): CliBackend => {
  const backend = resolveCliBackend(cfg);
  _encodeProjectDir = backend.encodeProjectDir;
  return backend;
};
