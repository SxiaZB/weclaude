// Path utilities — kept tiny and pure.
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand leading `~` and normalize. */
export const expandHome = (p: string): string =>
  p.startsWith("~") ? resolve(homedir(), p.slice(p.startsWith("~/") ? 2 : 1)) : resolve(p);

// IM principals ("user:xxx" / "chat:xxx") get pasted around — copy-paste from
// WeCom UI sometimes drags along zero-width / invisible-separator chars
// (U+200B-U+200D, U+2060-U+206F, U+FEFF). They render identical but break
// `===` matches between allowFrom and the wire-side principal.
const INVISIBLE = /[​-‍⁠-⁯﻿]/g;
export const sanitizeId = (s: string): string => s.replace(INVISIBLE, "").trim();
