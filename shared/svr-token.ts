// svr bearer token 的唯一落盘点。两个进程都要认同一个值: svr 用它校验 POST /d,
// daemon 用它签发 (init 把它写进 secrets.json 的 daemon.detailRemoteToken)。
// 谁先跑谁生成, 后来者读文件 —— 顺序无关, 不会分叉出两个 token。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { expandHome } from "./paths.js";

export const loadOrCreateSvrToken = (tokenFile: string, explicit?: string): string => {
  if (explicit && explicit.length > 0) return explicit;
  const abs = expandHome(tokenFile);
  if (existsSync(abs)) {
    const t = readFileSync(abs, "utf8").trim();
    if (t.length > 0) return t;
  }
  const t = randomBytes(24).toString("hex");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${t}\n`, { mode: 0o600 });
  return t;
};
