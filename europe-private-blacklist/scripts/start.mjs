#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { inspect } from "node:util";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function isAbortNoise(args) {
  // inspect() shows name, message, code and the whole cause chain of any error
  // object (JSON.stringify shows none of them).
  const text = args
    .map((item) => {
      if (!item) return "";
      if (typeof item === "string") return item;
      try {
        return inspect(item, { depth: 3, breakLength: Infinity });
      } catch {
        return String(item);
      }
    })
    .join(" ");
  return /AbortError|aborted|ECONNRESET|EPIPE|socket hang up|premature close|Invalid server action param for serverFnId/i.test(text);
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

// HTTP protection (per-IP limit, load shedding, slow connections, broken URLs)
// lives in the server itself: server/plugins/http-guards.ts.

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cut = line.indexOf("=");
    if (cut <= 0) continue;
    const key = line.slice(0, cut).trim();
    if (!key) continue;
    let value = line.slice(cut + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

loadDotEnv(join(root, ".env"));
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
if (!process.env.HOST && !process.env.NITRO_HOST) process.env.HOST = "0.0.0.0";

const prep = spawnSync(process.execPath, [join(root, "scripts/ensure-build.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (prep.status) process.exit(prep.status ?? 1);
await import(pathToFileURL(join(root, ".output/server/index.mjs")).href);
