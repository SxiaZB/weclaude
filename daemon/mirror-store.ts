// Persisted mirror attachments: principal (e.g. "chat:xxx" / "user:xxx") →
// { sessionId, jsonlPath, tmuxSession?, tmuxPane? }. Survives daemon reload so
// the next inbound for a known chat resumes the prior Claude session instead
// of spawning a fresh one. Single-file write-through, same shape/style as
// sessions.ts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";

export interface MirrorAttachment {
  sessionId: string;
  jsonlPath: string;
  tmuxSession?: string;
  /** Snapshot at attach time. Pane ids are not stable across daemon restarts;
   * restore re-derives the live pane from `tmuxSession` via `list-panes`. */
  tmuxPane?: string;
}

export interface MirrorStore {
  get: (principal: string) => MirrorAttachment | undefined;
  set: (principal: string, rec: MirrorAttachment) => void;
  drop: (principal: string) => void;
  all: () => Record<string, MirrorAttachment>;
}

export const loadMirrorStore = (filePath: string): MirrorStore => {
  const abs = expandHome(filePath);
  let map: Record<string, MirrorAttachment> = {};
  if (existsSync(abs)) {
    try {
      map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, MirrorAttachment>;
    } catch {
      map = {};
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  const persist = (): void => {
    writeFileSync(abs, JSON.stringify(map, null, 2), "utf8");
  };
  return {
    get: (p) => map[p],
    set: (p, rec) => {
      map[p] = rec;
      persist();
    },
    drop: (p) => {
      delete map[p];
      persist();
    },
    all: () => ({ ...map }),
  };
};
