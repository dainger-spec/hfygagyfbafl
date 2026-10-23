#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
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
  return /aborted|ECONNRESET|EPIPE|socket hang up|premature close|Invalid server action param for serverFnId/i.test(text);
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

// Scanners send paths with broken %-escapes (e.g. "/%E0%A4%A"). The framework
// throws while decoding them, outside any handler, so the request would hang
// and log an uncaught exception. Answer those with 400 before they get there.
// Per-IP flood guard: more than FLOOD_MAX requests in FLOOD_WINDOW from one
// address gets 429 for FLOOD_BLOCK, before any page is rendered. A normal visit
// is a few dozen requests. Telegram's webhook calls are never limited.
const FLOOD_WINDOW = 10_000;
const FLOOD_MAX = 300;
const FLOOD_BLOCK = 60_000;
const floodHits = new Map();

function clientIp(req) {
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The right-most entry is the one our own proxy added (the others can be forged).
  if (xff.length) return xff[xff.length - 1];
  return req.socket?.remoteAddress || "";
}

function floodBlocked(req) {
  if ((req.url || "").startsWith("/api/telegram/webhook")) return false;
  const ip = clientIp(req);
  if (!ip) return false;
  const now = Date.now();
  let h = floodHits.get(ip);
  if (!h || now - h.start > FLOOD_WINDOW) {
    if (h && h.blockedUntil > now) return true;
    h = { start: now, n: 0, blockedUntil: h?.blockedUntil || 0 };
    floodHits.set(ip, h);
  }
  if (h.blockedUntil > now) return true;
  h.n += 1;
  if (h.n > FLOOD_MAX) {
    h.blockedUntil = now + FLOOD_BLOCK;
    return true;
  }
  if (floodHits.size > 50_000) floodHits.clear();
  return false;
}

const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === "request" && req && typeof req.url === "string") {
    if (floodBlocked(req)) {
      try {
        res.statusCode = 429;
        res.setHeader("retry-after", "60");
        res.end("too many requests");
      } catch {
        /* ignore */
      }
      return true;
    }
    try {
      decodeURI(req.url.split("?")[0]);
    } catch {
      try {
        res.statusCode = 400;
        res.end("bad request");
      } catch {
        /* ignore */
      }
      return true;
    }
  }
  return origEmit.call(this, event, req, res, ...rest);
};

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
