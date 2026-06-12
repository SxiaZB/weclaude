// Surgical edits to ~/.weclaude/config.jsonc and secrets.json — preserves
// comments + formatting via jsonc-parser's `modify` patches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type JSONPath } from "jsonc-parser";
import { expandHome } from "./paths.js";

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

const readText = (abs: string): string =>
  existsSync(abs) ? readFileSync(abs, "utf8") : "{}\n";

const writeText = (abs: string, txt: string): void => {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, txt.endsWith("\n") ? txt : `${txt}\n`, "utf8");
};

/** Apply a sequence of (path, value) patches to a JSONC file. value=undefined deletes. */
export const patchJsonc = (
  filePath: string,
  patches: Array<{ path: JSONPath; value: unknown }>,
): void => {
  const abs = expandHome(filePath);
  let txt = readText(abs);
  for (const { path, value } of patches) {
    const edits = modify(txt, path, value, { formattingOptions: FORMAT });
    txt = applyEdits(txt, edits);
  }
  writeText(abs, txt);
};

/** Append `value` into a string array at `path`, deduped. No-op if already present. */
export const appendUnique = (filePath: string, path: JSONPath, value: string): void => {
  const abs = expandHome(filePath);
  const txt = readText(abs);
  const tree = (parseJsonc(txt) ?? {}) as Record<string, unknown>;
  const cur = path.reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[String(key)];
    return undefined;
  }, tree);
  const arr = Array.isArray(cur) ? (cur as string[]).slice() : [];
  if (arr.includes(value)) return;
  arr.push(value);
  patchJsonc(filePath, [{ path, value: arr }]);
};
