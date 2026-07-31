// Static web assets (web/*.css, web/*.js) — the front end lives in real files
// instead of template literals inside TS, so it gets syntax highlighting, no
// backslash escaping, and edits that don't need a `tsc` pass.
//
// 解析路径要同时命中三种布局: 源码跑 (tsx: shared/ → ../web)、编译后跑
// (dist/shared/ → ../../web)、npm 包安装 (同后者, 见 package.json files[])。
// 内容按 mtime 缓存: 命中时零 IO, 改文件即时生效 (daemon 不必重启)。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const WEB_DIR = [join(HERE, "..", "web"), join(HERE, "..", "..", "web")]
  .find((p) => existsSync(join(p, "chat.js")));

export interface Asset { body: string; type: string; etag: string }

const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const cache = new Map<string, { mtimeMs: number; asset: Asset }>();

/** 读一个 web/ 下的资源; 文件缺失 (打包遗漏) 返回 undefined 而不是抛 —— 页面
 *  少个样式表也好过整个 daemon 起不来。 */
export const readAsset = (name: string): Asset | undefined => {
  if (!WEB_DIR || /[/\\]/.test(name)) return undefined;
  const path = join(WEB_DIR, name);
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return undefined; }
  const hit = cache.get(name);
  if (hit && hit.mtimeMs === mtimeMs) return hit.asset;
  try {
    const body = readFileSync(path, "utf8");
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const asset: Asset = {
      body,
      type: TYPES[ext] ?? "application/octet-stream",
      etag: `W/"${mtimeMs.toString(36)}-${body.length.toString(36)}"`,
    };
    cache.set(name, { mtimeMs, asset });
    return asset;
  } catch {
    return undefined;
  }
};
