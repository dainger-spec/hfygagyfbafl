import http from "node:http";
import { EventEmitter } from "node:events";
import { definePlugin } from "nitro";

// HTTP protection installed inside the server itself, so it is on however the
// server is started (scripts/start.mjs or .output/server/index.mjs directly).
// If an older scripts/start.mjs already installed the same guards, this does
// nothing (they would otherwise count every request twice).
function installHttpGuards() {
  const proto = http.Server.prototype as any;
  if (proto.emit !== EventEmitter.prototype.emit) return false; // already guarded
  // Per-IP flood guard: more than FLOOD_MAX requests in FLOOD_WINDOW from one
  // address gets 429 for FLOOD_BLOCK, before any page is rendered. A normal visit
  // is a few dozen requests. Telegram's webhook calls are never limited.
  const FLOOD_WINDOW = 10_000;
  // Generous: mobile carriers put many people behind one address (CGNAT).
  const FLOOD_MAX = Number(process.env.EPB_FLOOD_MAX || 500);
  const FLOOD_BLOCK = 60_000;
  const floodHits = new Map<string, { start: number; n: number; blockedUntil: number }>();

  function clientIp(req: any): string {
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
    const direct = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    // Only a private/loopback address and no forwarding header: that is the
    // hosting's own proxy, shared by every visitor. Limiting it would block
    // everyone at once, so per-address limits are skipped (load shedding stays).
    if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(direct)) return "";
    return direct;
  }

  function floodBlocked(req: any): boolean {
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

  function shouldShed(req: any): boolean {
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
  const origListen = proto.listen;
  proto.listen = function (this: any, ...args: unknown[]) {
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

  // A one-line traffic summary in the log once a minute when there is a lot of
  // it or anything was turned away: tells a flood (many 429s, one busy address)
  // from a slow hosting/network (normal counts, low lag, yet pages are slow).
  const stats = { total: 0, r429: 0, r503: 0, r413: 0, maxLag: 0, maxInflight: 0 };
  {
    const t = setInterval(() => {
      stats.maxLag = Math.max(stats.maxLag, loopLag);
      if (stats.total > 600 || stats.r429 || stats.r503) {
        let top = "";
        let topN = 0;
        for (const [ip, h] of floodHits) if (h.n > topN) [top, topN] = [ip, h.n];
        console.log(
          `[epb] http last minute: ${stats.total} requests, 429: ${stats.r429}, 503: ${stats.r503}, 413: ${stats.r413}, ` +
            `max lag ${Math.round(stats.maxLag)} ms, max in flight ${stats.maxInflight}, busiest address ${top || "-"} (${topN}/10s)`,
        );
      }
      stats.total = stats.r429 = stats.r503 = stats.r413 = stats.maxLag = stats.maxInflight = 0;
    }, 60_000);
    t.unref?.();
    const lagT = setInterval(() => (stats.maxLag = Math.max(stats.maxLag, loopLag)), 1000);
    lagT.unref?.();
  }

  function reject(res: any, code: number, text: string, extra: Record<string, string> = {}): boolean {
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

  const origEmit = proto.emit;
  const guardedEmit = function (this: any, event: string, req: any, res: any, ...rest: unknown[]) {
    if (event === "request" && req && typeof req.url === "string") {
      stats.total += 1;
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
        stats.r413 += 1;
        return reject(res, 413, "too large");
      }
      if (shouldShed(req)) {
        stats.r503 += 1;
        return reject(res, 503, "busy, try again shortly", { "retry-after": "10" });
      }
      inflight += 1;
      if (inflight > stats.maxInflight) stats.maxInflight = inflight;
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
        stats.r429 += 1;
        try {
          res.statusCode = 429;
          res.setHeader("retry-after", "60");
          res.end("too many requests");
        } catch {
          /* ignore */
        }
        return true;
      }
      // Scanners send paths with broken %-escapes (e.g. "/%E0%A4%A"). The framework
      // throws while decoding them, outside any handler, so the request would hang
      // and log an uncaught exception. Answer those with 400 before they get there.
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
  (guardedEmit as any).__epbGuard = true;
  proto.emit = guardedEmit;
  return true;
}

export default definePlugin(() => {
  if (installHttpGuards()) console.log("[epb] HTTP guards on");
});
