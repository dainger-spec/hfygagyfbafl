import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { definePlugin } from "nitro";

// Addresses whose forwarding headers are believed: the hosting's own proxy
// (private and loopback ranges) and Cloudflare's edge. Anyone else could write
// any address into X-Forwarded-For / CF-Connecting-IP and slip past the
// per-address limits, so for them the socket's own address is used.
// Cloudflare's published ranges (cloudflare.com/ips); extra ones can be added
// with EPB_TRUSTED_PROXIES="1.2.3.0/24,…".
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16"];
const PRIVATE_V6 = ["::1/128", "fc00::/7", "fe80::/10"];

function blockList(v4: string[], v6: string[]) {
  const list = new net.BlockList();
  for (const [cidrs, type] of [[v4, "ipv4"], [v6, "ipv6"]] as const) {
    for (const cidr of cidrs) {
      const [addr, bits] = cidr.split("/");
      try {
        list.addSubnet(addr!, Number(bits), type);
      } catch {
        /* a malformed extra range is skipped */
      }
    }
  }
  return list;
}
const extra = String(process.env.EPB_TRUSTED_PROXIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const cloudflare = blockList(CLOUDFLARE_V4, CLOUDFLARE_V6);
const privateNets = blockList(
  [...PRIVATE_V4, ...extra.filter((c) => net.isIPv4(c.split("/")[0]!))],
  [...PRIVATE_V6, ...extra.filter((c) => net.isIPv6(c.split("/")[0]!))],
);

function plainIp(ip: string): string {
  return ip.replace(/^::ffff:/i, "");
}
function inList(list: net.BlockList, ip: string): boolean {
  const kind = net.isIP(ip);
  if (!kind) return false;
  try {
    return list.check(ip, kind === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}
const isCloudflare = (ip: string) => inList(cloudflare, ip);
const isPrivate = (ip: string) => inList(privateNets, ip);
const isTrustedProxy = (ip: string) => isPrivate(ip) || isCloudflare(ip);

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

  // The visitor's address. Forwarding headers count only when the connection
  // comes from a trusted proxy (see above); the X-Forwarded-For chain is read
  // from the right, skipping our own proxies, so the first foreign address is
  // the one a trusted proxy saw. "" = the visitor can't be told apart from the
  // others behind the hosting's proxy (per-address limits are then skipped).
  function clientIp(req: any): string {
    if (req.__epbIp !== undefined) return req.__epbIp;
    const peer = plainIp(String(req.socket?.remoteAddress || ""));
    let ip = peer;
    if (isTrustedProxy(peer)) {
      ip = "";
      const chain = String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .map((s) => plainIp(s.trim()))
        .filter((s) => net.isIP(s));
      let viaCloudflare = isCloudflare(peer);
      for (let k = chain.length - 1; k >= 0; k--) {
        const hop = chain[k]!;
        if (isCloudflare(hop)) viaCloudflare = true;
        if (!isTrustedProxy(hop)) {
          ip = hop;
          break;
        }
      }
      if (!ip && viaCloudflare) {
        const cf = plainIp(String(req.headers["cf-connecting-ip"] || "").trim());
        if (net.isIP(cf)) ip = cf;
      }
      if (!ip) {
        const real = plainIp(String(req.headers["x-real-ip"] || "").trim());
        if (net.isIP(real) && !isTrustedProxy(real)) ip = real;
      }
    }
    req.__epbIp = ip;
    return ip;
  }

  // Telegram's own update calls carry the webhook secret: only those skip the
  // limits (anyone else posting to the webhook path is limited like any visitor).
  let secretFor = "";
  let secret = "";
  function webhookSecret(): string {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || "");
    if (token !== secretFor) {
      secretFor = token;
      secret = token ? `epb-${createHash("sha256").update(token).digest("hex").slice(0, 24)}` : "";
    }
    return secret;
  }
  function isTelegramCall(req: any): boolean {
    if (!(req.url || "").startsWith("/api/telegram/webhook")) return false;
    const expected = webhookSecret();
    if (!expected) return false;
    return req.headers["x-telegram-bot-api-secret-token"] === expected || req.headers["x-epb-poller"] === expected;
  }

  // Paths only scanners ask for (this app has no PHP, WordPress or dotfiles):
  // answered at once, and they count heavily towards the address's limit.
  const SCANNER_PATH = /\.(?:php\d?|asp|aspx|jsp|cgi|env|git|sql|bak|ini|yml|yaml|log)(?:$|[/?])|\/(?:wp-|wordpress|phpmyadmin|pma|cgi-bin|\.git|\.env|vendor\/|actuator|server-status|xmlrpc|boaform|HNAP1)/i;
  const SCANNER_WEIGHT = 25;

  function floodBlocked(req: any, weight = 1): boolean {
    if (isTelegramCall(req)) return false;
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
    h.n += weight;
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
    if (isTelegramCall(req)) return false;
    // the cached home page costs next to nothing: still served when busy
    if (homeCacheHit(req)) return false;
    const hard = loopLag > SHED_HARD_LAG_MS || inflight > SHED_HARD_INFLIGHT;
    if (hard) return true;
    const soft = loopLag > SHED_LAG_MS || inflight > SHED_INFLIGHT;
    if (!soft) return false;
    const h = floodHits.get(clientIp(req));
    return Boolean(h && h.n > SHED_BUSY_IP);
  }

  // Slow-connection attacks (headers or bodies dribbled in to hold sockets open)
  // are cut off; oversized bodies are refused up front.
  // The home page is the same for every visitor (Telegram passes the user in
  // the URL fragment, which never reaches the server) and costs a few ms to
  // render: kept for a few seconds, so a flood of it is answered from memory.
  // Not for requests with cookies or with the install-tutorial parameters.
  const HOME_TTL = Number(process.env.EPB_HOME_CACHE_MS || 3000);
  const homeCache = new Map<string, { at: number; status: number; headers: Record<string, string | string[]>; body: Buffer }>();
  function homeKey(req: any): string {
    const method = req.method || "GET";
    if (HOME_TTL <= 0 || (method !== "GET" && method !== "HEAD")) return "";
    const [path, query = ""] = String(req.url || "").split("?");
    if (path !== "/" || /(?:^|&)(?:install|platform)=/.test(query) || req.headers.cookie) return "";
    return `h:${String(req.headers.host || "").toLowerCase().slice(0, 100)}`;
  }
  function homeCacheHit(req: any): boolean {
    const key = homeKey(req);
    const hit = key ? homeCache.get(key) : undefined;
    return Boolean(hit && Date.now() - hit.at < HOME_TTL);
  }
  function serveHome(req: any, res: any): boolean {
    const key = homeKey(req);
    const hit = key ? homeCache.get(key) : undefined;
    if (!hit || Date.now() - hit.at >= HOME_TTL) return false;
    try {
      res.writeHead(hit.status, { ...hit.headers, "content-length": String(hit.body.length), "x-epb-cache": "hit" });
      res.end(req.method === "HEAD" ? undefined : hit.body);
    } catch {
      /* ignore */
    }
    return true;
  }
  const SKIP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "date", "set-cookie"]);
  function captureHome(req: any, res: any) {
    const key = homeKey(req);
    if (!key || req.method !== "GET") return;
    const chunks: Buffer[] = [];
    let size = 0;
    let broken = false;
    const write = res.write;
    const end = res.end;
    const writeHead = res.writeHead;
    // headers handed straight to writeHead() are not visible through getHeaders()
    const headed: Record<string, string | string[]> = {};
    res.writeHead = function (status: number, ...args: unknown[]) {
      const obj = args.find((a) => a && typeof a === "object") as Record<string, unknown> | unknown[] | undefined;
      if (Array.isArray(obj)) {
        for (let k = 0; k + 1 < obj.length; k += 2) headed[String(obj[k]).toLowerCase()] = String(obj[k + 1]);
      } else if (obj) {
        for (const [name, value] of Object.entries(obj)) if (value != null) headed[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
      }
      return writeHead.call(this, status, ...args);
    };
    const keep = (chunk: unknown, enc?: unknown) => {
      if (broken || chunk == null || typeof chunk === "function") return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof enc === "string" ? (enc as BufferEncoding) : undefined);
      size += buf.length;
      if (size > 512 * 1024) broken = true;
      else chunks.push(buf);
    };
    res.write = function (chunk: unknown, enc?: unknown, cb?: unknown) {
      keep(chunk, enc);
      return write.call(this, chunk, enc, cb);
    };
    res.end = function (chunk?: unknown, enc?: unknown, cb?: unknown) {
      keep(chunk, enc);
      const all: Record<string, string | string[]> = { ...headed };
      for (const [name, value] of Object.entries(res.getHeaders() as Record<string, unknown>)) {
        if (value != null) all[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
      }
      const ok = !broken && res.statusCode === 200 && /text\/html/.test(String(all["content-type"] || "")) && !all["set-cookie"];
      if (ok) {
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(all)) if (!SKIP_HEADERS.has(name)) headers[name] = value;
        if (homeCache.size >= 16 && !homeCache.has(key)) homeCache.delete(homeCache.keys().next().value!);
        homeCache.set(key, { at: Date.now(), status: 200, headers, body: Buffer.concat(chunks) });
      }
      return end.call(this, chunk, enc, cb);
    };
  }

  // Cloudflare-only mode (EPB_CLOUDFLARE_ONLY=1, for a domain behind Cloudflare):
  // connections that don't come from Cloudflare (or the hosting's proxy) are
  // dropped before a byte is read, so the server can't be hit around Cloudflare.
  const CLOUDFLARE_ONLY = process.env.EPB_CLOUDFLARE_ONLY === "1";
  // Open connections per address: a flood of idle sockets from one address
  // can't use up the server's connections. Proxies (shared by everyone) are exempt.
  const CONN_PER_IP = Number(process.env.EPB_CONN_PER_IP || 64);
  const openConns = new Map<string, number>();
  const connStats = { dropped: 0 };
  function onConnection(socket: any): boolean {
    const peer = plainIp(String(socket?.remoteAddress || ""));
    if (CLOUDFLARE_ONLY && !isTrustedProxy(peer)) {
      connStats.dropped += 1;
      socket.destroy();
      return false;
    }
    if (!peer || isTrustedProxy(peer)) return true;
    const n = (openConns.get(peer) || 0) + 1;
    if (n > CONN_PER_IP) {
      connStats.dropped += 1;
      socket.destroy();
      return false;
    }
    openConns.set(peer, n);
    socket.once("close", () => {
      const left = (openConns.get(peer) || 1) - 1;
      if (left <= 0) openConns.delete(peer);
      else openConns.set(peer, left);
    });
    return true;
  }

  const MAX_BODY_BYTES = 3 * 1024 * 1024;
  const origListen = proto.listen;
  proto.listen = function (this: any, ...args: unknown[]) {
    try {
      this.headersTimeout = 15_000;
      this.requestTimeout = 120_000;
      this.keepAliveTimeout = 5_000;
      this.maxHeadersCount = 100;
      // one connection can't pipeline an endless stream of requests
      this.maxRequestsPerSocket = 200;
      if (!this.maxConnections) this.maxConnections = 4000;
    } catch {
      /* ignore */
    }
    return origListen.apply(this, args);
  };

  // A one-line traffic summary in the log once a minute when there is a lot of
  // it or anything was turned away: tells a flood (many 429s, one busy address)
  // from a slow hosting/network (normal counts, low lag, yet pages are slow).
  const stats = { total: 0, r429: 0, r503: 0, r413: 0, maxLag: 0, maxInflight: 0, cached: 0, scanners: 0 };
  {
    const t = setInterval(() => {
      stats.maxLag = Math.max(stats.maxLag, loopLag);
      if (stats.total > 600 || stats.r429 || stats.r503 || connStats.dropped) {
        let top = "";
        let topN = 0;
        for (const [ip, h] of floodHits) if (h.n > topN) [top, topN] = [ip, h.n];
        console.log(
          `[epb] http last minute: ${stats.total} requests, 429: ${stats.r429}, 503: ${stats.r503}, 413: ${stats.r413}, ` +
            `max lag ${Math.round(stats.maxLag)} ms, max in flight ${stats.maxInflight}, busiest address ${top || "-"} (${topN}/10s), ` +
            `home from cache: ${stats.cached}, scanner paths: ${stats.scanners}, connections dropped: ${connStats.dropped}`,
        );
      }
      stats.total = stats.r429 = stats.r503 = stats.r413 = stats.maxLag = stats.maxInflight = stats.cached = stats.scanners = 0;
      connStats.dropped = 0;
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
    if (event === "connection" && req && typeof req.destroy === "function" && this instanceof http.Server) {
      if (!onConnection(req)) return true;
    }
    if (event === "request" && req && typeof req.url === "string") {
      stats.total += 1;
      // behind a hosting proxy the socket check above can't see Cloudflare:
      // then the address the proxy forwards must be Cloudflare's
      if (CLOUDFLARE_ONLY && !isTelegramCall(req)) {
        const peer = plainIp(String(req.socket?.remoteAddress || ""));
        if (isPrivate(peer)) {
          const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => plainIp(x.trim())).filter((x) => net.isIP(x));
          const outer = [...hops].reverse().find((x) => !isPrivate(x));
          if (outer && !isCloudflare(outer)) return reject(res, 403, "forbidden");
        }
      }
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
        stats.r413 += 1;
        return reject(res, 413, "too large");
      }
      if (SCANNER_PATH.test(req.url)) {
        stats.scanners += 1;
        floodBlocked(req, SCANNER_WEIGHT);
        return reject(res, 404, "not found");
      }
      if (homeCacheHit(req)) {
        if (floodBlocked(req)) {
          stats.r429 += 1;
          return reject(res, 429, "too many requests", { "retry-after": "60" });
        }
        stats.cached += 1;
        return serveHome(req, res);
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
      captureHome(req, res);
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
