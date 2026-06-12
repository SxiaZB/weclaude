// Persisted principal → claude session_id map. Single JSON file, write-through.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";

export interface SessionStore {
  get: (principal: string) => string | undefined;
  set: (principal: string, sessionId: string) => void;
  drop: (principal: string) => void;
  all: () => Record<string, string>;
}

export const loadSessionStore = (filePath: string): SessionStore => {
  const abs = expandHome(filePath);
  let map: Record<string, string> = {};
  if (existsSync(abs)) {
    try {
      map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, string>;
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
    set: (p, sid) => {
      map[p] = sid;
      persist();
    },
    drop: (p) => {
      delete map[p];
      persist();
    },
    all: () => ({ ...map }),
  };
};
