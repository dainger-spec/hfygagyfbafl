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
  // Behind Cloudflare the proxies in front of us all look like Cloudflare's own
  // IPs; Cloudflare puts the visitor's real address in CF-Connecting-IP.
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
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

// Load shedding. Event-loop lag (how late a 100 ms timer fires) shows how busy
// the process is; the bot runs in the same process, so when pages start to
// choke it, extra page/API traffic is turned away fast with 503 instead of
// being rendered. Mild overload: only busy addresses are turned away; severe:
// everyone except Telegram's webhook.
const SHED_LAG_MS = Number(process.env.EPB_SHED_LAG_MS || 150);
const SHED_HARD_LAG_MS = Number(process.env.EPB_SHED_HARD_LAG_MS || 600);
const SHED_INFLIGHT = Number(process.env.EPB_SHED_INFLIGHT || 300);
const SHED_HARD_INFLIGHT = Number(process.env.EPB_SHED_HARD_INFLIGHT || 800);
const SHED_BUSY_IP = 40; // requests in the current 10 s window
let loopLag = 0;
let inflight = 0;
{
  let last = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - 100);
    last = now;
    // fast to rise, slow to fall
    loopLag = lag > loopLag ? lag : loopLag * 0.8 + lag * 0.2;
  }, 100);
  tick.unref?.();
}

function shouldShed(req) {
  if ((req.url || "").startsWith("/api/telegram/webhook")) return false;
  const hard = loopLag > SHED_HARD_LAG_MS || inflight > SHED_HARD_INFLIGHT;
  if (hard) return true;
  const soft = loopLag > SHED_LAG_MS || inflight > SHED_INFLIGHT;
  if (!soft) return false;
  const h = floodHits.get(clientIp(req));
  return Boolean(h && h.n > SHED_BUSY_IP);
}

// Slow-connection attacks (headers or bodies dribbled in to hold sockets open)
// are cut off; oversized bodies are refused up front.
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  try {
    this.headersTimeout = 15_000;
    this.requestTimeout = 120_000;
    this.keepAliveTimeout = 5_000;
    this.maxHeadersCount = 100;
    if (!this.maxConnections) this.maxConnections = 4000;
  } catch {
    /* ignore */
  }
  return origListen.apply(this, args);
};

function reject(res, code, text, extra = {}) {
  try {
    res.statusCode = code;
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.setHeader("connection", "close");
    res.end(text);
  } catch {
    /* ignore */
  }
  return true;
}

const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === "request" && req && typeof req.url === "string") {
    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) return reject(res, 413, "too large");
    if (shouldShed(req)) return reject(res, 503, "busy, try again shortly", { "retry-after": "10" });
    inflight += 1;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        inflight -= 1;
      }
    };
    res.once("close", finish);
    res.once("finish", finish);
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
