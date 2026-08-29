#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function isAbortNoise(args) {
  const text = args
    .map((item) => {
      if (!item) return "";
      if (item instanceof Error) {
        const cause = item.cause instanceof Error ? `${item.cause.message} ${item.cause.code || ""}` : String(item.cause || "");
        return `${item.message} ${item.code || ""} ${item.stack || ""} ${cause}`;
      }
      try {
        return typeof item === "string" ? item : JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");
  return /aborted|ECONNRESET|EPIPE|socket hang up|premature close/i.test(text);
}

const origError = console.error.bind(console);
console.error = (...args) => {
  if (isAbortNoise(args)) return;
  origError(...args);
};

for (const ev of ["uncaughtException", "unhandledRejection"]) {
  process.on(ev, (err) => {
    if (isAbortNoise([err])) return;
    origError("[epb]", err);
  });
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prep = spawnSync(process.execPath, [join(root, "scripts/ensure-build.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (prep.status) process.exit(prep.status ?? 1);
await import(pathToFileURL(join(root, ".output/server/index.mjs")).href);
