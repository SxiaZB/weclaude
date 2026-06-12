// Logger: pino, dual sink (stdout pretty in TTY, file always).
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";
import { expandHome } from "./paths.js";

const ensureDir = (filePath: string): void => {
  const d = dirname(filePath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
};

export interface MakeLoggerOpts {
  logFile: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  name: string;
}

export const makeLogger = ({ logFile, logLevel, name }: MakeLoggerOpts): Logger => {
  const abs = expandHome(logFile);
  ensureDir(abs);
  const fileStream = createWriteStream(abs, { flags: "a" });
  const opts: LoggerOptions = { name, level: logLevel, base: { pid: process.pid } };
  return pino(opts, fileStream);
};
