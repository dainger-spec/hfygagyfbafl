import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, appendFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_NAME, CHANNEL_URL, KNOWN_TELEGRAM_IDS, parseDamageAmount, parseTelegramInput } from "@/lib/telegram";
import type { Application, ComplaintHistoryItem, Currency, EvidenceItem, PersonRef } from "@/lib/types";
import { scammerAccounts } from "@/lib/types";
import { WELCOME_JPEG_BASE64 } from "@/lib/welcome-card";
import { isLocale, tb, type BotMsg, type Locale } from "@/lib/i18n";

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

let warnedMissingToken = false;
function requireToken() {
  const token = botToken();
  if (!token && !warnedMissingToken) {
    warnedMissingToken = true;
    console.warn("[epb] TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

export function isDisconnectError(err: unknown) {
  const any = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = String(any?.code || any?.cause?.code || "");
  const msg = `${any?.message || ""} ${any?.cause?.message || ""} ${err || ""}`;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECONNABORTED" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    /aborted|socket hang up|ECONNRESET|premature close/i.test(msg)
  );
}

function installDisconnectGuards() {
  const swallow = (err: unknown) => {
    if (isDisconnectError(err)) return;
    console.error("[epb]", err);
  };
  process.on("uncaughtException", swallow);
  process.on("unhandledRejection", swallow);
}
installDisconnectGuards();
function botApi() {
  return `https://api.telegram.org/bot${requireToken()}`;
}
export const BOT_USERNAME = "EuropeBlack_bot";
export function webhookSecret() {
  return `epb-${createHash("sha256").update(botToken()).digest("hex").slice(0, 24)}`;
}

export function webhookSecretMatches(header: string | null | undefined): boolean {
  const expected = webhookSecret();
  const got = String(header || "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const BINDINGS_PATH = join(DATA_DIR, "telegram-bindings.json");
const REQUESTED_ARBITER = process.env.TELEGRAM_ARBITER_CHAT_ID || "-5422557027";
const PINNED_ARBITER_CHAT = "-1003904954808";
const PINNED_CHANNEL = "-1003958415589";
const DEFAULT_PUBLIC_URL = "https://europe.bothost.tech";

type RelayChat = {
  id: string;
  title?: string;
  type?: string;
  status: "pending" | "on" | "off";
  requestedAt?: number;
  // Last "not enough rights" notice, so admins are not spammed on every post.
  rightsNoticeAt?: number;
  // Public handle / invite link, shown on the "Sponsors" page (filled lazily).
  username?: string;
  link?: string;
};

// A promo banner shown at the top of the mini app. "video" covers real videos
// and GIFs (Telegram animations are mp4), which the app plays muted and looped.
type Banner = {
  id: string;
  type: "image" | "video";
  file: string;
  mime: string;
  link: string;
  title?: string;
  // Media pixel size, so the app reserves the right box before the media loads.
  width?: number;
  height?: number;
  createdAt: number;
};

// A user added to the counterparty-check blacklist by hand (not via a complaint),
// e.g. from a third-party source. Shown in search under its own "source" label.
type ManualBlacklistEntry = {
  id: string;
  username?: string;
  telegramId?: string;
  source: string;
  note?: string;
  addedAt: number;
};

type Bindings = {
  arbiterChatId?: string;
  channelId?: string;
  miniAppUrl?: string;
  cards?: Partial<Record<"welcome" | "submitted" | "published", string>>;
  cardStamp?: string;
  relayChats?: RelayChat[];
  checkChannels?: { id: string; title?: string; username?: string; addedAt: number }[];
  userbotApi?: { apiId: number; apiHash: string };
  blacklistCleanupStamp?: string;
  checkEnabled?: boolean;
  banners?: Banner[];
  manualBlacklist?: ManualBlacklistEntry[];
  // Baseline total audience shown in the stats line (owner can set it).
  audienceBase?: number;
  webhookStamp?: string;
  lastBroadcast?: { at: number; total: number; sent: number; noRights: number; gone: number; failed: number };
};

// Relay chats are also kept in their own file, so replacing telegram-bindings.json
// on deploy can never wipe the list of chats that receive the broadcast.
const RELAY_PATH = join(DATA_DIR, "telegram-relay-chats.json");
const BACKUP_DIR = join(DATA_DIR, "backups");

// Write to a temp file and rename: a crash mid-write never leaves a truncated JSON.
function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function latestBackup(prefix: string): string | null {
  try {
    const names = readdirSync(BACKUP_DIR)
      .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".json"))
      .sort();
    return names.length ? join(BACKUP_DIR, names[names.length - 1]!) : null;
  } catch {
    return null;
  }
}

// One copy per day, the last 30 days are kept.
function backupDaily(prefix: string, value: unknown) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const path = join(BACKUP_DIR, `${prefix}-${day}.json`);
    writeJsonAtomic(path, value);
    const old = readdirSync(BACKUP_DIR)
      .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".json"))
      .sort();
    for (const name of old.slice(0, Math.max(0, old.length - 30))) unlinkSync(join(BACKUP_DIR, name));
  } catch {
    /* ignore */
  }
}

function mergeRelayLists(...lists: (RelayChat[] | null | undefined)[]): RelayChat[] {
  const out: RelayChat[] = [];
  for (const list of lists) {
    for (const chat of list || []) {
      if (!chat?.id) continue;
      const idx = out.findIndex((c) => sameChat(c.id, chat.id));
      if (idx < 0) out.push({ ...chat, id: String(chat.id) });
      // A chat that is "on" anywhere stays "on": never silently switch a chat off.
      else if (out[idx]!.status !== "on" && chat.status === "on") out[idx] = { ...out[idx]!, ...chat };
    }
  }
  return out;
}

let bindingsLoadFailed = false;
let bindings: Bindings = loadBindings();
let profileReady = false;
let commandsStamp = "";
const COMMANDS_STAMP = "eu-blacklist-bot-v4-admin";

function loadBindings(): Bindings {
  let raw = readJson<Bindings>(BINDINGS_PATH);
  if (!raw && existsSync(BINDINGS_PATH)) {
    // The file exists but is broken: fall back to the last backup instead of starting empty.
    const backup = latestBackup("telegram-bindings");
    raw = backup ? readJson<Bindings>(backup) : null;
    if (!raw) {
      if (!bindingsLoadFailed) console.error("[epb] telegram-bindings.json is unreadable and there is no backup; it will not be overwritten");
      bindingsLoadFailed = true;
    }
  }
  const loaded = raw || {};
  const relayFile = readJson<RelayChat[]>(RELAY_PATH);
  const relayBackup = relayFile ? null : readJson<RelayChat[]>(latestBackup("telegram-relay-chats") || "");
  loaded.relayChats = mergeRelayLists(loaded.relayChats, relayFile, relayBackup);
  return loaded;
}

function saveBindings() {
  // Never overwrite a file we could not read: it may still hold the relay list.
  if (bindingsLoadFailed) return;
  try {
    writeJsonAtomic(BINDINGS_PATH, bindings);
    writeJsonAtomic(RELAY_PATH, bindings.relayChats || []);
    backupDaily("telegram-bindings", bindings);
    backupDaily("telegram-relay-chats", bindings.relayChats || []);
  } catch {
    // Read-only filesystem - in-memory bindings still work for this instance.
  }
}

const ID_CACHE_PATH = join(DATA_DIR, "telegram-ids-verified.json");
const PENDING_PATH = join(DATA_DIR, "telegram-pending.json");
const LOCALES_PATH = join(DATA_DIR, "telegram-locales.json");

let userLocales: Record<string, Locale> = {};
try {
  if (existsSync(LOCALES_PATH)) {
    const raw = JSON.parse(readFileSync(LOCALES_PATH, "utf8")) as Record<string, string>;
    for (const [id, value] of Object.entries(raw || {})) {
      if (isLocale(value)) userLocales[id] = value;
    }
  }
} catch {
  userLocales = {};
}

function saveLocales() {
  try {
    writeJsonAtomic(LOCALES_PATH, userLocales);
  } catch {
    /* ignore */
  }
}

function langOf(userId: string | number | undefined): Locale {
  const saved = userLocales[String(userId || "")];
  return saved === "en" ? "en" : "ru";
}

function hasLang(userId: string | number | undefined): boolean {
  return isLocale(userLocales[String(userId || "")]);
}

function setLang(userId: string | number, locale: Locale) {
  userLocales[String(userId)] = locale;
  saveLocales();
}

export function saveUserLocaleServer(userId: string | number, locale: Locale) {
  if (!isLocale(locale)) return;
  setLang(userId, locale);
}

function btUser(userId: string | number | undefined, key: BotMsg, vars?: Record<string, string | number>) {
  return tb(langOf(userId), key, vars);
}

type MediaRef = { type: "photo" | "video" | "document"; file_id: string };
type PendingPost = {
  username: string;
  id: string;
  accounts?: { username: string; id: string }[];
  story: string;
  summary?: string;
  amount: string;
  currency: string;
  files: MediaRef[];
  victimId?: string;
  victimUsername?: string;
  createdAt?: number;
  status?: "pending" | "published" | "rejected";
  // Set only when the post actually reached the EPB channel.
  channelPosted?: boolean;
  // The channel and message ids of that post, to verify it still exists.
  channelChatId?: string;
  channelMsgIds?: number[];
  // Where the broadcast delivered this post, so it can be deleted everywhere later.
  relayDeliveries?: { chatId: string; messageIds: number[] }[];
  // The arbiter deleted this post from the channel and all relay chats.
  deletedEverywhere?: boolean;
  // The arbiter removed this complaint from the counterparty check.
  removedFromCheck?: boolean;
  // Post body edited by an arbiter (Telegram HTML); replaces the summary in the post.
  postHtml?: string;
  // Where the review message with the buttons is, so the admin panel can point to it.
  reviewChatId?: string;
  reviewMessageId?: number;
};

// Only pairs confirmed by Telegram (user objects in updates, getChat, MTProto) go here.
// The old telegram-ids.json also took pairs typed by users, so it is kept only as hints.
let idCache: Record<string, string> = {};
let legacyIds: Record<string, string> = {};
let pendingPosts: Record<string, PendingPost> = {};

legacyIds = readJson<Record<string, string>>(join(DATA_DIR, "telegram-ids.json")) || {};
idCache = { ...KNOWN_TELEGRAM_IDS, ...(readJson<Record<string, string>>(ID_CACHE_PATH) || {}) };
try {
  pendingPosts = JSON.parse(readFileSync(PENDING_PATH, "utf8")) as Record<string, PendingPost>;
} catch {
  pendingPosts = {};
}
// Before the channelPosted marker existed, "published" already meant "posted to channel".
for (const rec of Object.values(pendingPosts)) {
  if (rec.status === "published" && rec.channelPosted === undefined) rec.channelPosted = true;
}

// One-time cleanup: remove test blacklist entries for these usernames from the check.
const BLACKLIST_CLEANUP = ["hugos", "mkcrd", "annuit1", "ballin812"];
const BLACKLIST_CLEANUP_STAMP = "cleanup-v2";
if (bindings.blacklistCleanupStamp !== BLACKLIST_CLEANUP_STAMP) {
  let changed = false;
  for (const rec of Object.values(pendingPosts)) {
    if (rec.removedFromCheck) continue;
    const names = pendingAccounts(rec).map((a) => a.username.replace(/^@/, "").toLowerCase());
    if (names.some((n) => BLACKLIST_CLEANUP.includes(n))) {
      rec.removedFromCheck = true;
      changed = true;
    }
  }
  if (changed) savePending();
  bindings.blacklistCleanupStamp = BLACKLIST_CLEANUP_STAMP;
  saveBindings();
}

let idCacheTimer: ReturnType<typeof setTimeout> | null = null;
// Debounced: busy chats would otherwise rewrite the file on every new username.
function saveIdCache() {
  if (idCacheTimer) return;
  idCacheTimer = setTimeout(() => {
    idCacheTimer = null;
    try {
      writeJsonAtomic(ID_CACHE_PATH, idCache);
    } catch {
      /* ignore */
    }
  }, 2000);
}

function savePending() {
  try {
    const entries = Object.entries(pendingPosts);
    if (entries.length > 1200) {
      const drop = entries
        .filter(([, rec]) => rec.status === "published" || rec.status === "rejected")
        .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
      const extra = entries.length - 1000;
      for (const [key] of drop.slice(0, Math.max(0, extra))) delete pendingPosts[key];
    }
    writeJsonAtomic(PENDING_PATH, pendingPosts);
  } catch {
    /* ignore */
  }
}

function rememberUser(user?: { id?: number; username?: string } | null) {
  if (!user?.id || !user.username) return;
  rememberHandle(user.username, String(user.id));
}

function rememberHandle(username: string, id: string) {
  const key = username.replace(/^@/, "").toLowerCase();
  if (!key || !id || !/^\d{5,15}$/.test(id)) return;
  if (idCache[key] === id) return;
  idCache[key] = id;
  const keys = Object.keys(idCache);
  if (keys.length > 8000) {
    for (const extra of keys.slice(0, keys.length - 7000)) delete idCache[extra];
  }
  saveIdCache();
}

const EVIDENCE_DIR = join(DATA_DIR, "evidence");

const MAX_EVIDENCE_FILE = 1024 * 1024 * 1024;
const MAX_EVIDENCE_CHUNK = 2 * 1024 * 1024;

function sanitizeEvidenceId(id: string): string | null {
  const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe.length < 8 || safe.length > 80) return null;
  if (safe === ".." || safe.startsWith(".")) return null;
  return safe;
}

function evidenceOwnerPath(id: string) {
  return join(EVIDENCE_DIR, `${id}.own`);
}

function writeEvidenceOwner(id: string, userId: string) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(evidenceOwnerPath(id), String(userId || ""));
}

function readEvidenceOwner(id: string): string {
  try {
    return readFileSync(evidenceOwnerPath(id), "utf8").trim();
  } catch {
    return "";
  }
}

export function evidenceOwnedBy(id: string | undefined, userId: string): boolean {
  const safe = sanitizeEvidenceId(id || "");
  if (!safe || !userId) return false;
  return readEvidenceOwner(safe) === userId && Boolean(uploadedEvidencePath(safe));
}

function evidenceHmacKey() {
  return createHmac("sha256", "EvidenceGet").update(botToken() || "none").digest();
}

function evidenceSig(key: string, exp: number): string {
  return createHmac("sha256", evidenceHmacKey()).update(`${key}.${exp}`).digest("hex").slice(0, 32);
}

export function verifyEvidenceDownload(key: string, exp: string, sig: string): boolean {
  const safe = sanitizeEvidenceId(key);
  if (!safe) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  if (expMs > Date.now() + 48 * 60 * 60 * 1000) return false;
  const expect = evidenceSig(safe, expMs);
  const a = Buffer.from(expect, "hex");
  const b = Buffer.from(String(sig || ""), "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function isAllowedEvidenceMagic(bytes: Buffer): boolean {
  if (!bytes.length) return false;
  const head = bytes.subarray(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<?php") ||
    head.startsWith("#!") ||
    head.startsWith("import ") ||
    head.startsWith("function ") ||
    head.startsWith("const ") ||
    head.startsWith("var ") ||
    head.startsWith("{")
  ) {
    return false;
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return false;
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return false;
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) return false;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") return true;
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    (bytes.subarray(8, 12).toString("ascii") === "WEBP" || bytes.subarray(8, 12).toString("ascii") === "AVI ")
  ) {
    return true;
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return true;
  return false;
}

export function saveUploadedEvidence(userId: string, bytes: Buffer) {
  if (!userId) throw new Error("telegram auth required");
  if (bytes.length > MAX_EVIDENCE_FILE) throw new Error("file too large");
  if (!isAllowedEvidenceMagic(bytes)) throw new Error("not media");
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const id = randomUUID();
  writeFileSync(join(EVIDENCE_DIR, id), bytes);
  writeEvidenceOwner(id, userId);
  pruneEvidenceDir();
  return id;
}

const chunkCursor = new Map<string, number>();

export function appendEvidenceChunk(userId: string, requestedId: string, index: number, total: number, bytes: Buffer) {
  if (!userId) throw new Error("telegram auth required");
  if (index < 0 || total < 1 || index >= total) throw new Error("bad chunk");
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const safe = index === 0 ? randomUUID() : sanitizeEvidenceId(requestedId);
  if (!safe) throw new Error("bad chunk");
  if (index === 0 && !isAllowedEvidenceMagic(bytes)) throw new Error("not media");
  if (index > 0 && readEvidenceOwner(safe) !== userId) throw new Error("forbidden");
  if (index === 0) writeEvidenceOwner(safe, userId);
  const part = join(EVIDENCE_DIR, `${safe}.part`);
  const dest = join(EVIDENCE_DIR, safe);
  const idxPath = join(EVIDENCE_DIR, `${safe}.idx`);
  if (existsSync(dest) && readEvidenceOwner(safe) === userId) return safe;
  const expected = chunkCursor.get(safe) ?? (existsSync(idxPath) ? Number(readFileSync(idxPath, "utf8") || 0) : 0);
  if (index < expected) return safe;
  if (index !== expected) throw new Error("chunk order");
  if (bytes.length > MAX_EVIDENCE_CHUNK) throw new Error("chunk too large");
  if (index === 0) {
    if (existsSync(part)) unlinkSync(part);
    if (existsSync(dest)) unlinkSync(dest);
  }
  const already = existsSync(part) ? statSync(part).size : 0;
  if (already + bytes.length > MAX_EVIDENCE_FILE) {
    try {
      unlinkSync(part);
    } catch {
      /* ignore */
    }
    chunkCursor.delete(safe);
    throw new Error("file too large");
  }
  appendFileSync(part, bytes);
  const next = index + 1;
  chunkCursor.set(safe, next);
  writeFileSync(idxPath, String(next));
  if (index !== total - 1) return safe;
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(part, dest);
  try {
    unlinkSync(idxPath);
  } catch {
    /* ignore */
  }
  chunkCursor.delete(safe);
  pruneEvidenceDir();
  return safe;
}

export function evidenceBytesOnDisk(id?: string): number {
  const path = id ? uploadedEvidencePath(id) : null;
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const rateHits = new Map<string, number[]>();

function tooMany(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (rateHits.size > 4000) {
    for (const [k, hits] of rateHits) {
      const keep = hits.filter((t) => now - t < 6 * 60 * 60 * 1000);
      if (!keep.length) rateHits.delete(k);
      else rateHits.set(k, keep);
    }
  }
  const keep = (rateHits.get(key) || []).filter((t) => now - t < windowMs);
  if (keep.length >= max) {
    rateHits.set(key, keep);
    return true;
  }
  keep.push(now);
  rateHits.set(key, keep);
  return false;
}

export function verifyTelegramInitData(initData: string): { id: string; username?: string } | null {
  if (!botToken() || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash") || "";
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(botToken()).digest();
    const calc = createHmac("sha256", secret).update(dataCheck).digest("hex");
    const a = Buffer.from(calc, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86_400) return null;
    const user = JSON.parse(params.get("user") || "{}") as { id?: number; username?: string };
    if (!user?.id) return null;
    return { id: String(user.id), username: user.username };
  } catch {
    return null;
  }
}

// Files of one upload (data, .own, .part, .idx) are removed together, oldest first,
// and uploads touched in the last 30 minutes are never removed mid-transfer.
function pruneEvidenceDir() {
  try {
    if (!existsSync(EVIDENCE_DIR)) return;
    const groups = new Map<string, { paths: string[]; mtime: number; size: number }>();
    for (const name of readdirSync(EVIDENCE_DIR)) {
      const path = join(EVIDENCE_DIR, name);
      const st = statSync(path);
      const key = name.replace(/\.(own|part|idx)$/, "");
      const group = groups.get(key) || { paths: [], mtime: 0, size: 0 };
      group.paths.push(path);
      group.mtime = Math.max(group.mtime, st.mtimeMs);
      group.size += st.size;
      groups.set(key, group);
    }
    const list = [...groups.values()].sort((a, b) => a.mtime - b.mtime);
    let total = list.reduce((sum, g) => sum + g.size, 0);
    const maxBytes = 8 * 1024 * 1024 * 1024;
    const maxUploads = 400;
    const fresh = Date.now() - 30 * 60 * 1000;
    let count = list.length;
    for (const group of list) {
      if (count <= maxUploads && total <= maxBytes) break;
      if (group.mtime > fresh) break;
      for (const path of group.paths) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
      total -= group.size;
      count -= 1;
    }
  } catch {
    /* ignore */
  }
}

export function allowEvidenceUpload(initData: string, bytes = 1): { ok: true; userId: string } | { ok: false; error: string } {
  if (bytes < 0) return { ok: false, error: "file required" };
  if (bytes > MAX_EVIDENCE_CHUNK) return { ok: false, error: "chunk too large" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`up:${user.id}`, 40, 60 * 60 * 1000)) return { ok: false, error: "too many uploads" };
  if (tooMany(`upchunk:${user.id}`, 600, 60 * 1000)) return { ok: false, error: "upload too fast" };
  if (tooMany("up:global", 2000, 60 * 60 * 1000)) return { ok: false, error: "server busy" };
  return { ok: true, userId: user.id };
}

export function allowEvidenceDownload(): boolean {
  return !tooMany("evget:global", 240, 60 * 1000);
}

export function allowEvidenceChunk(initData: string, bytes: number): { ok: true; userId: string } | { ok: false; error: string } {
  if (bytes > MAX_EVIDENCE_CHUNK) return { ok: false, error: "chunk too large" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`upchunk:${user.id}`, 600, 60 * 1000)) return { ok: false, error: "upload too fast" };
  if (tooMany("upchunk:global", 2000, 60 * 1000)) return { ok: false, error: "server busy" };
  return { ok: true, userId: user.id };
}

function allowNewComplaint(userId: string, storyLen: number): string | null {
  const loc = langOf(userId);
  if (storyLen > 5000) return tb(loc, "storyLong");
  if (tooMany(`app:${userId}`, 3, 6 * 60 * 60 * 1000)) return tb(loc, "tooManyUser");
  if (tooMany("app:global", 40, 60 * 60 * 1000)) return tb(loc, "tooManyGlobal");
  return null;
}

function readUploadedEvidence(id: string): Buffer | null {
  const path = uploadedEvidencePath(id);
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function uploadedEvidencePath(id: string): string | null {
  const safe = sanitizeEvidenceId(id);
  if (!safe) return null;
  const path = join(EVIDENCE_DIR, safe);
  if (!path.startsWith(EVIDENCE_DIR)) return null;
  return existsSync(path) ? path : null;
}

// ---- Promo banners (top of the mini app) --------------------------------
const BANNER_DIR = join(DATA_DIR, "banners");
// Bot API getFile can only download files up to 20 MB.
const MAX_BANNER_BYTES = 20 * 1024 * 1024;
const MAX_BANNERS = 20;

function sanitizeBannerId(id: string): string | null {
  const safe = String(id || "").replace(/[^a-zA-Z0-9]/g, "");
  if (safe.length < 10 || safe.length > 40) return null;
  return safe;
}

function newBannerId(): string {
  return createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24);
}

function saveBannerFile(id: string, bytes: Buffer) {
  mkdirSync(BANNER_DIR, { recursive: true });
  writeFileSync(join(BANNER_DIR, id), bytes);
}

// Sponsor chat avatars are downloaded from Telegram and cached on disk, keyed by
// a hash of the photo's file_id (a new avatar -> new key -> re-download).
const SPONSOR_AVATAR_DIR = join(DATA_DIR, "sponsor-avatars");

function sanitizeAvatarKey(k: string): string | null {
  const safe = String(k || "").replace(/[^a-f0-9]/g, "");
  return safe.length >= 8 && safe.length <= 64 ? safe : null;
}

export function sponsorAvatarPath(key: string): string | null {
  const safe = sanitizeAvatarKey(key);
  if (!safe) return null;
  const path = join(SPONSOR_AVATAR_DIR, safe);
  if (!path.startsWith(SPONSOR_AVATAR_DIR)) return null;
  return existsSync(path) ? path : null;
}

// Returns an avatar URL for a chat photo, downloading+caching it once. "" if none.
async function sponsorAvatarUrl(smallFileId?: string): Promise<string> {
  if (!smallFileId) return "";
  const key = createHash("sha256").update(smallFileId).digest("hex").slice(0, 24);
  const path = join(SPONSOR_AVATAR_DIR, key);
  if (!existsSync(path)) {
    const bytes = await downloadTelegramFile(smallFileId);
    if (!bytes) return "";
    try {
      mkdirSync(SPONSOR_AVATAR_DIR, { recursive: true });
      writeFileSync(path, bytes);
    } catch {
      return "";
    }
  }
  return `/api/telegram/sponsor-avatar?a=${key}`;
}

export function bannerById(id: string): Banner | null {
  const safe = sanitizeBannerId(id);
  if (!safe) return null;
  return (bindings.banners || []).find((b) => b.id === safe) || null;
}

export function bannerFilePath(id: string): string | null {
  const safe = sanitizeBannerId(id);
  if (!safe) return null;
  const path = join(BANNER_DIR, safe);
  if (!path.startsWith(BANNER_DIR)) return null;
  return existsSync(path) ? path : null;
}

// What the mini app shows. Media is served from our own origin so the bot
// token never reaches the browser.
export function listBanners() {
  return (bindings.banners || []).map((b) => ({
    id: b.id,
    type: b.type,
    link: b.link,
    width: b.width,
    height: b.height,
    src: `/api/telegram/banner?id=${encodeURIComponent(b.id)}`,
  }));
}

// Sponsors = the chats that receive the broadcast. Shown on a page in the app:
// chat title + a link that an admin set by hand (never auto-pulled). Chats
// without an admin-set link are shown by name only.
type SponsorItem = { id: string; title: string; link: string; avatar: string };
let sponsorsCache: { at: number; value: SponsorItem[] } | null = null;

function invalidateSponsors() {
  sponsorsCache = null;
  statsCache = null;
}

const AUDIENCE_DEFAULT = 20178;
let statsCache: { at: number; value: { chats: number; audience: number } } | null = null;

// How many chats receive the broadcast and their combined audience. The audience
// is at least the owner-set baseline (default ~20178), plus any real member count.
export async function sponsorStats(): Promise<{ chats: number; audience: number }> {
  if (statsCache && Date.now() - statsCache.at < 10 * 60 * 1000) return statsCache.value;
  const chats = (bindings.relayChats || []).filter((c) => c.status === "on" && isGroupOrChannel(c));
  let sum = 0;
  await Promise.all(
    chats.map(async (c) => {
      const n = await tgSoft<number>("getChatMemberCount", { chat_id: c.id });
      if (typeof n === "number" && n > 0) sum += n;
    }),
  );
  const base = typeof bindings.audienceBase === "number" ? bindings.audienceBase : AUDIENCE_DEFAULT;
  const value = { chats: chats.length, audience: Math.max(base, sum) };
  statsCache = { at: Date.now(), value };
  return value;
}

// Owner sets the baseline audience number shown in the app.
export function setAudienceBase(n: number): boolean {
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return false;
  bindings.audienceBase = Math.round(n);
  saveBindings();
  statsCache = null;
  return true;
}

export async function listSponsors(): Promise<SponsorItem[]> {
  if (sponsorsCache && Date.now() - sponsorsCache.at < 10 * 60 * 1000) return sponsorsCache.value;
  const chats = (bindings.relayChats || []).filter((c) => c.status === "on" && isGroupOrChannel(c));
  const value = await Promise.all(
    chats.map(async (c) => {
      // getChat gives the current title and the chat photo; the link is never auto-set.
      const chat = await tgSoft<{ title?: string; photo?: { small_file_id?: string } }>("getChat", { chat_id: c.id });
      const title = chat?.title || c.title || "Чат";
      const avatar = await sponsorAvatarUrl(chat?.photo?.small_file_id);
      return { id: String(c.id), title, link: c.link || "", avatar };
    }),
  );
  sponsorsCache = { at: Date.now(), value };
  return value;
}

// Admin sets (or clears with "") a chat's sponsor link. Only https / t.me links.
export function setSponsorLink(chatId: string | number, raw: string): "set" | "cleared" | "bad" {
  const relay = findRelay(chatId);
  if (!relay) return "bad";
  const text = (raw || "").trim();
  if (text === "-" || text === "—" || text === "") {
    delete relay.link;
    saveBindings();
    invalidateSponsors();
    return "cleared";
  }
  const ok = /^https:\/\/[^\s]+$/i.test(text) || /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s]+$/i.test(text);
  if (!ok) return "bad";
  relay.link = text.startsWith("http") ? text : `https://${text}`;
  saveBindings();
  invalidateSponsors();
  return "set";
}

function removeBannerById(id: string) {
  const safe = sanitizeBannerId(id);
  if (!safe) return;
  bindings.banners = (bindings.banners || []).filter((b) => b.id !== safe);
  saveBindings();
  try {
    const path = join(BANNER_DIR, safe);
    if (path.startsWith(BANNER_DIR) && existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

// Downloads a Telegram file by file_id into memory (<= 20 MB).
async function downloadTelegramFile(fileId: string): Promise<Buffer | null> {
  const info = await tgSoft<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!info?.file_path) return null;
  if (info.file_size && info.file_size > MAX_BANNER_BYTES) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${requireToken()}/${info.file_path}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BANNER_BYTES) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Picks banner media out of an incoming message. A Telegram "animation" (GIF)
// is really an mp4, so it is treated as a looping video.
function extractBannerMedia(
  msg: TgMessage,
): { type: "image" | "video"; fileId: string; mime: string; width?: number; height?: number } | null {
  if (msg.animation?.file_id)
    return { type: "video", fileId: msg.animation.file_id, mime: msg.animation.mime_type || "video/mp4", width: msg.animation.width, height: msg.animation.height };
  if (msg.video?.file_id)
    return { type: "video", fileId: msg.video.file_id, mime: msg.video.mime_type || "video/mp4", width: msg.video.width, height: msg.video.height };
  if (msg.photo?.length) {
    const ph = msg.photo.at(-1)!;
    return { type: "image", fileId: ph.file_id, mime: "image/jpeg", width: ph.width, height: ph.height };
  }
  const doc = msg.document;
  if (doc?.file_id && doc.mime_type) {
    // SVG is an image but can carry scripts; never accept it as banner media.
    if (doc.mime_type.startsWith("image/") && doc.mime_type !== "image/svg+xml")
      return { type: "image", fileId: doc.file_id, mime: doc.mime_type };
    if (doc.mime_type.startsWith("video/")) return { type: "video", fileId: doc.file_id, mime: doc.mime_type };
  }
  return null;
}

function normalizeBannerLink(raw: string): string | null {
  const text = raw.trim();
  if (text === "-" || text === "—" || text.toLowerCase() === "нет") return "";
  if (/^https:\/\/[^\s]+$/i.test(text)) return text;
  if (/^tg:\/\/[^\s]+$/i.test(text)) return text;
  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s]+$/i.test(text)) {
    return text.startsWith("http") ? text : `https://${text}`;
  }
  return null;
}

type TgResult<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      description: string;
      error_code?: number;
      parameters?: { retry_after?: number; migrate_to_chat_id?: number };
    };

class TgError extends Error {
  code?: number;
  retryAfter?: number;
  migrateTo?: string;
  constructor(json: Extract<TgResult<unknown>, { ok: false }>, method: string) {
    super(json.description || method);
    this.code = json.error_code;
    this.retryAfter = json.parameters?.retry_after;
    this.migrateTo = json.parameters?.migrate_to_chat_id ? String(json.parameters.migrate_to_chat_id) : undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tgOnce<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${botApi()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) throw new TgError(json, method);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Retries on flood limits (429) and follows a group that was upgraded to a supergroup.
async function tg<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  let payload = body;
  for (let attempt = 0; ; attempt++) {
    try {
      return await tgOnce<T>(method, payload);
    } catch (err) {
      if (!(err instanceof TgError) || attempt >= 3) throw err;
      if (err.migrateTo && payload.chat_id != null) {
        onChatMigrated(String(payload.chat_id), err.migrateTo);
        payload = { ...payload, chat_id: err.migrateTo };
        continue;
      }
      if (err.code === 429 && (err.retryAfter ?? 0) <= 60) {
        await sleep(((err.retryAfter ?? 1) + 1) * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function tgSoft<T>(method: string, body: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await tg<T>(method, body);
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;");
}

function withHundredPrefix(id: string): string | null {
  if (!id.startsWith("-") || id.startsWith("-100")) return null;
  return `-100${id.slice(1)}`;
}

function chatIdKey(id: string | number): string {
  return String(id).trim().replace(/^-100/, "-").replace(/^-/, "");
}

function sameChat(a: string | number | undefined, b: string | number | undefined): boolean {
  if (a == null || b == null) return false;
  return chatIdKey(a) === chatIdKey(b);
}

const OFFICIAL_ARBITER_IDS = [
  PINNED_ARBITER_CHAT,
  REQUESTED_ARBITER,
  withHundredPrefix(REQUESTED_ARBITER),
].filter((id): id is string => Boolean(id));

function isOfficialArbiterChat(id: string | number | undefined): boolean {
  if (id == null) return false;
  return OFFICIAL_ARBITER_IDS.some((allowed) => sameChat(allowed, id));
}

function arbiterCandidates(): string[] {
  const ids = [PINNED_ARBITER_CHAT, bindings.arbiterChatId, ...OFFICIAL_ARBITER_IDS].filter(
    (id): id is string => Boolean(id) && isOfficialArbiterChat(id),
  );
  return [...new Set(ids)];
}

function isOfficialChannel(id: string | number | undefined): boolean {
  if (id == null) return false;
  if (sameChat(id, PINNED_CHANNEL)) return true;
  return Boolean(bindings.channelId && sameChat(bindings.channelId, id));
}

if (!isOfficialArbiterChat(bindings.arbiterChatId)) {
  bindings.arbiterChatId = PINNED_ARBITER_CHAT;
}
if (!bindings.channelId) {
  bindings.channelId = PINNED_CHANNEL;
}
if (bindings.cardStamp !== "new-bot-v1") {
  bindings.cards = {};
  bindings.cardStamp = "new-bot-v1";
}
saveBindings();

function channelCandidates(): string[] {
  const ids = [bindings.channelId, process.env.TELEGRAM_CHANNEL_ID].filter(
    (id): id is string => Boolean(id),
  );
  return [...new Set(ids)];
}

async function chatReachable(id: string) {
  return tgSoft<{ id: number; title?: string; type: string; username?: string }>("getChat", { chat_id: id });
}

function refreshBindings() {
  bindings = { ...bindings, ...loadBindings() };
}

function isGatedHost(url: string) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)grok\.me$/i.test(host) || /(^|\.)grok-sandbox\.com$/i.test(host);
  } catch {
    return true;
  }
}

function publicMiniAppUrl(): string | undefined {
  refreshBindings();
  const url = bindings.miniAppUrl || DEFAULT_PUBLIC_URL;
  if (!url.startsWith("https://") || isGatedHost(url)) return undefined;
  return url.replace(/\/$/, "");
}

let lastMenuUrl = "";

async function applyMenuButton() {
  const url = publicMiniAppUrl() || "";
  if (url === lastMenuUrl) return;
  lastMenuUrl = url;
  if (url) {
    await tgSoft("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Открыть",
        web_app: { url },
      },
    });
    return;
  }
  await tgSoft("setChatMenuButton", { menu_button: { type: "commands" } });
}

function publicSiteUrl(): string | undefined {
  const fromEnv = (process.env.PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/$/, "");
  if (fromEnv.startsWith("https://") && !isGatedHost(fromEnv)) return fromEnv;
  return publicMiniAppUrl();
}

async function ensureProductionWebhook() {
  const site = publicSiteUrl();
  if (!site) return;
  const hook = `${site}/api/telegram/webhook`;
  const info = await tgSoft<{ url?: string }>("getWebhookInfo");
  // The secret is derived from the token: after a token change the URL is the same
  // but Telegram still sends the old secret, so the stamp forces a fresh setWebhook.
  if (info?.url === hook && bindings.webhookStamp === webhookStamp()) {
    await applyMenuButton();
    return;
  }
  await registerMiniAppUrl(site);
}

function webhookStamp() {
  return createHash("sha256").update(webhookSecret()).digest("hex").slice(0, 16);
}

async function ensurePolling() {
  if (process.env.PUBLIC_URL || process.env.NODE_ENV === "production") {
    await ensureProductionWebhook();
    return;
  }
  const info = await tgSoft<{ url?: string }>("getWebhookInfo");
  if (info?.url) {
    await tgSoft("deleteWebhook", { drop_pending_updates: false });
  }
  if (bindings.miniAppUrl && isGatedHost(bindings.miniAppUrl)) {
    delete bindings.miniAppUrl;
    saveBindings();
  }
  await applyMenuButton();
}

async function ensureBotProfile() {
  if (profileReady && commandsStamp === COMMANDS_STAMP) return;
  await ensurePolling();
  if (commandsStamp !== COMMANDS_STAMP) {
    commandsStamp = COMMANDS_STAMP;
    await tgSoft("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть приложение" },
        { command: "apply", description: "Подать жалобу в чате" },
        { command: "cancel", description: "Отменить заявку" },
        { command: "lang", description: "Язык / Language" },
      ],
      scope: { type: "all_private_chats" },
    });
    await tgSoft("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть приложение" },
        { command: "apply", description: "Подать жалобу в чате" },
        { command: "cancel", description: "Отменить заявку" },
        { command: "lang", description: "Язык / Language" },
      ],
      language_code: "ru",
      scope: { type: "all_private_chats" },
    });
    await tgSoft("setMyCommands", {
      commands: [
        { command: "start", description: "Open the app" },
        { command: "apply", description: "File a complaint in chat" },
        { command: "cancel", description: "Cancel the complaint" },
        { command: "lang", description: "Language / Язык" },
      ],
      language_code: "en",
      scope: { type: "all_private_chats" },
    });
    await tgSoft("deleteMyCommands", { scope: { type: "default" } });
    await tgSoft("deleteMyCommands", { scope: { type: "all_group_chats" } });
    await tgSoft("deleteMyCommands", { scope: { type: "all_chat_administrators" } });
    // Only the arbiter chat gets the admin commands in its "/" menu.
    for (const chat_id of arbiterCandidates()) {
      await tgSoft("setMyCommands", {
        commands: [
          { command: "admin", description: "Панель управления" },
          { command: "relays", description: "Чаты рассылки" },
          { command: "channel", description: "Канал для постов" },
          { command: "id", description: "ID этого чата" },
        ],
        scope: { type: "chat", chat_id },
      });
    }
  }
  profileReady = true;
}

let statusCache: { at: number; value: Promise<{ bot: string; arbiterOk: boolean; channelOk: boolean }> } | null = null;

// Public endpoint: cached so it cannot be used to hammer the Telegram API.
export function getBotStatus() {
  if (!statusCache || Date.now() - statusCache.at > 60_000) {
    statusCache = { at: Date.now(), value: computeBotStatus() };
  }
  return statusCache.value;
}

async function computeBotStatus() {
  await ensureBotProfile();
  const me = await tgSoft<{ username: string; first_name: string }>("getMe");

  let arbiterOk = false;
  for (const id of arbiterCandidates()) {
    const chat = await chatReachable(id);
    if (!chat) continue;
    arbiterOk = true;
    break;
  }

  let channelOk = false;
  for (const id of channelCandidates()) {
    const chat = await chatReachable(id);
    if (chat) {
      channelOk = true;
      break;
    }
  }

  return {
    bot: me ? `@${me.username}` : `@${BOT_USERNAME}`,
    arbiterOk,
    channelOk,
  };
}

type MtprotoClient = {
  invoke: (req: unknown) => Promise<unknown>;
  connected?: boolean;
  session?: { save: () => string };
  disconnect?: () => Promise<void>;
  destroy?: () => Promise<void>;
};
let mtClient: Promise<{ client: MtprotoClient; Api: any }> | null = null;
let mtIdleTimer: ReturnType<typeof setTimeout> | null = null;
// While Telegram says FLOOD_WAIT, MTProto is not touched at all (no lookups, no logins).
let mtBlockedUntil = 0;
const mtMisses = new Map<string, number>();
const mtInflight = new Map<string, Promise<Lookup>>();
// Saved login: restarts reuse it instead of logging in as the bot again.
const MT_SESSION_PATH = join(DATA_DIR, "mtproto.session");

// One logged-in client is reused: logging in as the bot on every lookup is slow
// and quickly runs into FLOOD_WAIT from Telegram.
function mtproto() {
  if (!mtClient) {
    mtClient = (async () => {
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      const { Api } = await import("telegram/tl/index.js");
      const { Logger } = await import("telegram/extensions/Logger.js");
      const apiId = Number(process.env.TELEGRAM_API_ID || 2040);
      const apiHash = process.env.TELEGRAM_API_HASH || "b18441a1ff607e10a989891a5462e627";
      let saved = "";
      try {
        const [stamp, value] = readFileSync(MT_SESSION_PATH, "utf8").split("\n");
        // A session belongs to one token: after /revoke it is useless.
        if (stamp === webhookStamp() && value) saved = value.trim();
      } catch {
        /* no saved session */
      }
      const client = new TelegramClient(new StringSession(saved), apiId, apiHash, {
        connectionRetries: 1,
        timeout: 12,
        // Never sleep inside a request (a lookup would hang); we handle FLOOD_WAIT ourselves.
        floodSleepThreshold: 0,
        deviceModel: "EPB",
        systemVersion: "Linux",
        appVersion: "1.0",
        autoReconnect: false,
        baseLogger: new Logger("none" as never),
      });
      // A login that hangs must not block every later lookup on the same promise.
      await withTimeout(client.start({ botAuthToken: botToken() }), 20_000, "mtproto login timeout");
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(MT_SESSION_PATH, `${webhookStamp()}\n${(client.session as unknown as { save: () => string }).save()}`, { mode: 0o600 });
      } catch {
        /* ignore */
      }
      return { client: client as unknown as MtprotoClient, Api };
    })();
    mtClient.catch(() => dropMtproto());
  }
  if (mtIdleTimer) clearTimeout(mtIdleTimer);
  mtIdleTimer = setTimeout(() => dropMtproto(), 30 * 60_000);
  return mtClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function dropMtproto() {
  const pending = mtClient;
  mtClient = null;
  if (mtIdleTimer) clearTimeout(mtIdleTimer);
  mtIdleTimer = null;
  pending
    ?.then(async ({ client }) => {
      await client.disconnect?.().catch(() => {});
      await client.destroy?.().catch(() => {});
    })
    .catch(() => {});
}

function floodSeconds(err: unknown): number {
  const e = err as { seconds?: number; errorMessage?: string; message?: string };
  if (typeof e?.seconds === "number" && e.seconds > 0) return e.seconds;
  const text = `${e?.errorMessage || ""} ${e?.message || ""}`;
  const m = text.match(/FLOOD_WAIT_(\d+)|A wait of (\d+) seconds/);
  return m ? Number(m[1] || m[2]) : 0;
}

// ---------- Userbot: a connected user account for reading channels the bot is not in ----------
// A user account (unlike a bot) can read channel history, including old posts, in every
// channel it is subscribed to. The owner logs in once with scripts/login-user.mjs, which
// writes the session string to data/user-session.txt (or env TELEGRAM_USER_SESSION).

const USER_SESSION_PATH = join(DATA_DIR, "user-session.txt");

function userSession(): string {
  const env = (process.env.TELEGRAM_USER_SESSION || "").trim();
  if (env) return env;
  try {
    return readFileSync(USER_SESSION_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

export function hasUserbot(): boolean {
  return Boolean(userSession());
}

type UserClient = {
  invoke: (req: unknown) => Promise<unknown>;
  getInputEntity: (ref: unknown) => Promise<unknown>;
  connected?: boolean;
  disconnect?: () => Promise<void>;
  destroy?: () => Promise<void>;
};
let userClient: Promise<{ client: UserClient; Api: any }> | null = null;
let userIdleTimer: ReturnType<typeof setTimeout> | null = null;
let userBlockedUntil = 0;

function userApiCreds() {
  const apiId = Number(process.env.TELEGRAM_API_ID || bindings.userbotApi?.apiId || 0);
  const apiHash = (process.env.TELEGRAM_API_HASH || bindings.userbotApi?.apiHash || "").trim();
  return { apiId, apiHash };
}

const OWNER_ID = "1457986905";
function isOwner(id: string | number | undefined): boolean {
  return String(id || "") === OWNER_ID;
}

// Blacklist search (counterparty check) is ON by default. The owner can still
// hide it with /checkoff, or the host with EPB_CHECK_ENABLED=0.
function checkEnabled(): boolean {
  if (typeof bindings.checkEnabled === "boolean") return bindings.checkEnabled;
  if (process.env.EPB_CHECK_ENABLED === "0") return false;
  return true;
}
export function featuresEnabled() {
  return { check: checkEnabled() };
}

function saveUserSession(session: string) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_SESSION_PATH, session, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function clearUserSession() {
  dropUserbot();
  try {
    if (existsSync(USER_SESSION_PATH)) unlinkSync(USER_SESSION_PATH);
  } catch {
    /* ignore */
  }
}

function userbot() {
  if (!userClient) {
    userClient = (async () => {
      const session = userSession();
      if (!session) throw new Error("no user session");
      const { apiId, apiHash } = userApiCreds();
      if (!apiId || !apiHash) throw new Error("set TELEGRAM_API_ID and TELEGRAM_API_HASH for the userbot");
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      const { Api } = await import("telegram/tl/index.js");
      const { Logger } = await import("telegram/extensions/Logger.js");
      const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 1,
        timeout: 15,
        floodSleepThreshold: 0,
        autoReconnect: false,
        baseLogger: new Logger("none" as never),
      });
      await withTimeout(client.connect(), 20_000, "userbot connect timeout");
      return { client: client as unknown as UserClient, Api };
    })();
    userClient.catch(() => dropUserbot());
  }
  if (userIdleTimer) clearTimeout(userIdleTimer);
  userIdleTimer = setTimeout(() => dropUserbot(), 20 * 60_000);
  return userClient;
}

// A fresh client from a saved session only knows the channels whose access
// hashes were in that session. Private channels (no @username) can't be resolved
// by id until the dialog list is loaded once; we then re-save the session so the
// access hashes persist for the next process.
let userEntitiesLoaded = false;
async function ensureUserEntities(client: UserClient): Promise<void> {
  if (userEntitiesLoaded) return;
  userEntitiesLoaded = true;
  try {
    await withTimeout((client as unknown as { getDialogs: (o: unknown) => Promise<unknown> }).getDialogs({ limit: 300 }), 25_000, "dialogs timeout");
    const saved = (client as unknown as { session?: { save?: () => string } }).session?.save?.();
    if (typeof saved === "string" && saved) saveUserSession(saved);
  } catch {
    userEntitiesLoaded = false; // allow a later retry
  }
}

// Resolve a channel to an input peer, loading the dialog list once if a private
// channel isn't cached yet.
async function userInputPeer(client: UserClient, ref: string | number): Promise<unknown> {
  try {
    return await client.getInputEntity(ref);
  } catch {
    await ensureUserEntities(client);
    return client.getInputEntity(ref);
  }
}

function dropUserbot() {
  const pending = userClient;
  userClient = null;
  userEntitiesLoaded = false;
  if (userIdleTimer) clearTimeout(userIdleTimer);
  userIdleTimer = null;
  pending
    ?.then(async ({ client }) => {
      await client.disconnect?.().catch(() => {});
      await client.destroy?.().catch(() => {});
    })
    .catch(() => {});
}

// Does the userbot session work at all? Used by the admin panel.
export async function userbotStatus(): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (!userSession()) return { ok: false, error: "нет сессии" };
  const { apiId, apiHash } = userApiCreds();
  if (!apiId || !apiHash) return { ok: false, error: "нет TELEGRAM_API_ID / TELEGRAM_API_HASH" };
  try {
    const { client, Api } = await userbot();
    const me = (await withTimeout(client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] })), 12_000, "timeout")) as {
      username?: string;
      firstName?: string;
    }[];
    const u = me?.[0];
    return { ok: true, name: u?.username ? `@${u.username}` : u?.firstName || "аккаунт" };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || "ошибка" };
  }
}

// Resolve a channel ref (@username or -100id) to a stored entry using the userbot.
export async function resolveChannelAsUser(ref: string): Promise<CheckChannel | null> {
  if (!userSession()) return null;
  try {
    const { client } = await userbot();
    const entity = (await withTimeout(client.getInputEntity(ref), 12_000, "timeout")) as {
      channelId?: unknown;
      className?: string;
    };
    const chan = entity as { channelId?: { toString(): string } };
    if (!chan?.channelId) return null;
    const id = `-100${chan.channelId.toString()}`;
    // getEntity for the title/username.
    const full = (await (client as unknown as { getEntity: (r: unknown) => Promise<unknown> }).getEntity(ref).catch(() => null)) as {
      title?: string;
      username?: string;
    } | null;
    return { id, title: full?.title, username: full?.username, addedAt: Date.now() };
  } catch {
    return null;
  }
}

function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!needle) return flat.slice(0, 180);
  const i = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return flat.slice(0, 180);
  const from = Math.max(0, i - 60);
  return (from > 0 ? "…" : "") + flat.slice(from, from + 180).trim() + (from + 180 < flat.length ? "…" : "");
}

// Whether a complaint's channel post was deleted. Only the user account can check this;
// without it we cannot know, so we keep showing the complaint. Result cached briefly.
const deletedCache = new Map<string, { at: number; deleted: boolean }>();

type UserClientFull = UserClient & { getMessages: (ref: unknown, opts: { ids: number[] }) => Promise<unknown[]> };

async function channelPostDeleted(rec: PendingPost): Promise<boolean> {
  if (!userSession() || Date.now() < userBlockedUntil) return false;
  const ids = rec.channelMsgIds || [];
  const chat = rec.channelChatId || bindings.channelId || "";
  if (!ids.length || !chat) return false;
  const cacheKey = `${chat}:${ids.join(",")}`;
  const cached = deletedCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.deleted;
  try {
    const { client } = await userbot();
    const peer = await userInputPeer(client, chat);
    const msgs = (await withTimeout(
      (client as unknown as UserClientFull).getMessages(peer, { ids }),
      12_000,
      "getMessages timeout",
    )) as ({ id?: number; className?: string } | undefined)[];
    // A deleted message comes back as empty / without a real id.
    const anyAlive = (msgs || []).some((m) => m && m.id && m.className !== "MessageEmpty");
    const deleted = !anyAlive;
    deletedCache.set(cacheKey, { at: Date.now(), deleted });
    return deleted;
  } catch (err) {
    const wait = floodSeconds(err);
    if (wait) userBlockedUntil = Date.now() + (wait + 5) * 1000;
    else if (!(err as { errorMessage?: string })?.errorMessage) dropUserbot();
    return false;
  }
}

// Full-history search of one channel for a query, via the user account.
type UserClientSearch = UserClient & {
  getMessages: (entity: unknown, opts: { search?: string; limit?: number; ids?: number[] }) => Promise<{ id?: number; message?: string; date?: number }[]>;
};

// Telegram's full-text search splits on underscores/punctuation, so a username
// like "black_art_services" as one token matches nothing. We search the
// word-tokenized form ("black art services" — posts containing all the words)
// and then keep only messages that actually contain the username/id.
function searchQueryFor(raw: string): string {
  const tokenized = raw.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return tokenized || raw;
}

function bodyMatchesNeedle(body: string, needle: string): boolean {
  const b = body.toLowerCase();
  const n = needle.toLowerCase().replace(/^@/, "");
  if (!n) return false;
  if (b.includes(n)) return true;
  // Also match when the post spells the username with spaces instead of _.
  const words = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 1 && words.every((w) => b.includes(w));
}

async function userSearchChannel(channel: CheckChannel, query: string, needle: string): Promise<CheckHit[]> {
  if (Date.now() < userBlockedUntil) return [];
  try {
    const { client } = await userbot();
    const ref: string | number = channel.username ? `@${channel.username.replace(/^@/, "")}` : channel.id;
    const peer = await userInputPeer(client, ref);
    // High-level search: gramjs builds messages.Search with the right types.
    const msgs = (await withTimeout(
      (client as unknown as UserClientSearch).getMessages(peer, { search: searchQueryFor(query), limit: 40 }),
      15_000,
      "search timeout",
    )) as { id?: number; message?: string; date?: number }[];
    const out: CheckHit[] = [];
    for (const m of msgs || []) {
      const body = m.message || "";
      if (!m.id || !body || !bodyMatchesNeedle(body, needle)) continue;
      out.push({
        channelId: channel.id,
        channelTitle: channel.title || "канал",
        messageId: m.id,
        link: messageLink(channel, m.id),
        date: (m.date || 0) * 1000,
        snippet: snippetAround(body, needle),
      });
    }
    return out;
  } catch (err) {
    const wait = floodSeconds(err);
    if (wait) {
      userBlockedUntil = Date.now() + (wait + 5) * 1000;
      console.warn(`[epb] userbot FLOOD_WAIT ${wait}s`);
    } else if (!(err as { errorMessage?: string })?.errorMessage) {
      dropUserbot();
    }
    return [];
  }
}

// Diagnostic for the owner: runs a real username search across the configured
// channels and reports what came back (or the exact error), so a failing search
// is no longer silent.
export async function diagnoseUserSearch(input: string): Promise<string> {
  const parsed = parseTelegramInput(input);
  const uname = parsed.username.replace(/^@/, "").toLowerCase();
  const id = parsed.id;
  const q = uname || id;
  if (!q) return "Укажите @username или ID для проверки.";
  if (!hasUserbot()) return "Юзербот не подключён (нет сессии). Подключите: /userbot.";
  const channels = checkChannels();
  if (!channels.length) return "Не выбрано ни одного канала для поиска. Выберите: /userbot → каналы.";
  const st = await userbotStatus();
  if (!st.ok) return `Аккаунт не отвечает: ${st.error || "ошибка"}`;
  const lines: string[] = [`Аккаунт: ${st.name || "ок"}. Каналов: ${channels.length}. Ищу «${q}»…`];
  let total = 0;
  for (const ch of channels) {
    const ref = ch.username ? `@${ch.username.replace(/^@/, "")}` : ch.id;
    try {
      const { client } = await userbot();
      const peer = await userInputPeer(client, ref);
      const msgs = (await withTimeout(
        (client as unknown as UserClientSearch).getMessages(peer, { search: searchQueryFor(q), limit: 40 }),
        15_000,
        "search timeout",
      )) as { id?: number; message?: string }[];
      const matched = (msgs || []).filter((m) => m.id && bodyMatchesNeedle(m.message || "", q));
      total += matched.length;
      lines.push(`• ${ch.title || ch.username || ch.id}: просмотрено ${(msgs || []).length}, совпало ${matched.length}`);
    } catch (err) {
      lines.push(`• ${ch.title || ch.username || ch.id}: ошибка — ${(err as Error)?.message || String(err)}`);
    }
  }
  lines.push(`Итого совпадений: ${total}.`);
  return lines.join("\n");
}



// "busy" = not looked up because of limits (try again later), null = no such username.
type Lookup = { username: string; id: string } | null | "busy";

async function resolveUsernameMtproto(username: string, userId = ""): Promise<Lookup> {
  const key = username.toLowerCase();
  if (!botToken()) return null;
  if (Date.now() < mtBlockedUntil) return "busy";
  // Usernames that do not exist are not asked again for 30 minutes.
  if (Date.now() - (mtMisses.get(key) || 0) < 30 * 60_000) return null;
  const running = mtInflight.get(key);
  if (running) return running;
  // One person can't use up the shared budget for everybody else.
  if (userId && tooMany(`mtproto:user:${userId}`, 8, 60_000)) return "busy";
  // Own budget, well below what Telegram tolerates for bots.
  if (tooMany("mtproto:resolve", 30, 60_000) || tooMany("mtproto:resolve:h", 400, 60 * 60_000)) return "busy";
  const job = (async (): Promise<Lookup> => {
    try {
      const ask = async () => {
        const { client, Api } = await mtproto();
        // Telegram or the hosting network may close an idle connection: start a new one.
        if (client.connected === false) throw new Error("mtproto disconnected");
        return withTimeout(client.invoke(new Api.contacts.ResolveUsername({ username })), 10_000, "mtproto request timeout");
      };
      let raw: unknown;
      try {
        raw = await ask();
      } catch (err) {
        // Connection problem (not an answer from Telegram): one retry on a fresh connection.
        if ((err as { errorMessage?: string })?.errorMessage || floodSeconds(err)) throw err;
        dropMtproto();
        raw = await ask();
      }
      const result = raw as {
        peer?: { userId?: unknown };
        users?: { id?: unknown; username?: string }[];
      };
      const user = result.users?.[0];
      const id = String(user?.id ?? result.peer?.userId ?? "");
      if (!/^\d{5,15}$/.test(id)) {
        mtMisses.set(key, Date.now());
        return null;
      }
      return { username: user?.username || username, id };
    } catch (err) {
      const wait = floodSeconds(err);
      if (wait) {
        mtBlockedUntil = Date.now() + (wait + 5) * 1000;
        console.warn(`[epb] MTProto FLOOD_WAIT ${wait}s, lookups paused`);
        return "busy";
      }
      const rpc = (err as { errorMessage?: string })?.errorMessage;
      if (rpc && /USERNAME_(NOT_OCCUPIED|INVALID)/.test(rpc)) {
        mtMisses.set(key, Date.now());
        return null;
      }
      // An RPC answer means the connection works; only a broken connection is rebuilt.
      if (!rpc) dropMtproto();
      return null;
    } finally {
      mtInflight.delete(key);
      if (mtMisses.size > 5000) mtMisses.clear();
    }
  })();
  mtInflight.set(key, job);
  return job;
}

// Username -> id through Telegram itself (cache of verified pairs, Bot API, MTProto).
async function lookupVerifiedId(username: string, userId = ""): Promise<Lookup> {
  const key = username.replace(/^@/, "").toLowerCase();
  if (!key) return null;
  const cached = idCache[key];
  if (cached) return { username, id: cached };
  const chat = await tgSoft<{ id: number; username?: string }>("getChat", { chat_id: `@${key}` });
  if (chat?.id) {
    rememberHandle(chat.username || username, String(chat.id));
    return { username: chat.username || username, id: String(chat.id) };
  }
  const mt = await resolveUsernameMtproto(key, userId);
  if (mt && mt !== "busy" && mt.id) {
    rememberHandle(mt.username, mt.id);
    return mt;
  }
  return mt === "busy" ? "busy" : null;
}

export type AccountCheck = "ok" | "mismatch" | "unknown";

// Does @username really belong to this id? Used to warn arbiters about forged pairs.
export async function verifyAccountPair(username: string, id: string): Promise<{ check: AccountCheck; realId?: string }> {
  const handle = username.replace(/^@/, "").trim();
  if (!handle || !id) return { check: "unknown" };
  const found = await lookupVerifiedId(handle);
  if (!found || found === "busy") return { check: "unknown" };
  return found.id === id ? { check: "ok" } : { check: "mismatch", realId: found.id };
}

export async function resolveHandleServer(input: string, userId = ""): Promise<{
  username: string;
  id: string;
  source: "telegram" | "parsed" | "unresolved";
  busy?: boolean;
} | null> {
  const parsed = parseTelegramInput(input);
  if (!parsed.username && !parsed.id) return null;
  if (tooMany("resolve:global", 80, 60_000)) {
    const cached = parsed.username ? idCache[parsed.username.toLowerCase()] : "";
    if (cached && (!parsed.id || cached === parsed.id)) return { username: parsed.username, id: cached, source: "telegram" };
    return { username: parsed.username, id: parsed.id, source: parsed.id ? "parsed" : "unresolved" };
  }
  if (parsed.id) {
    if (parsed.username) {
      // Typed "@name 123": the pair is only trusted when Telegram confirms it.
      const pair = await verifyAccountPair(parsed.username, parsed.id);
      if (pair.check === "mismatch" && pair.realId) return { username: parsed.username, id: pair.realId, source: "telegram" };
      return { username: parsed.username, id: parsed.id, source: pair.check === "ok" ? "telegram" : "parsed" };
    }
    const chat = await tgSoft<{ id: number; username?: string }>("getChat", { chat_id: parsed.id });
    if (chat?.username) rememberHandle(chat.username, parsed.id);
    return { username: chat?.username || "", id: parsed.id, source: chat?.username ? "telegram" : "parsed" };
  }
  const username = parsed.username;
  const found = await lookupVerifiedId(username, userId);
  if (found && found !== "busy") return { username: found.username, id: found.id, source: "telegram" };
  // Old cache from before verification existed: only a hint, never "telegram".
  const legacy = legacyIds[username.toLowerCase()];
  if (legacy) return { username, id: legacy, source: "parsed" };
  return { username, id: "", source: "unresolved", busy: found === "busy" };
}

function pendingAccounts(record?: PendingPost, fallbackUser = "", fallbackId = ""): { username: string; id: string }[] {
  if (record?.accounts?.length) return record.accounts;
  if (record?.username || record?.id) return [{ username: record.username, id: record.id }];
  if (fallbackUser || fallbackId) return [{ username: fallbackUser, id: fallbackId }];
  return [];
}

function formatAccountLine(username: string, id: string, html = false) {
  const handle = username.replace(/^@/, "");
  const name = handle ? `@${handle}` : "";
  if (html) {
    return `${name ? `${escapeHtml(name)} · ` : ""}<code>${escapeHtml(id)}</code>`;
  }
  return [name, id ? `Id: ${id}` : ""].filter(Boolean).join("\n");
}

// Earlier posts about the same account, so arbiters don't publish the same scam twice.
function previousPosts(accounts: { username?: string; id?: string; telegramId?: string }[], exceptKey = ""): string {
  const ids = new Set(accounts.map((a) => a.id || a.telegramId || "").filter(Boolean));
  const names = new Set(accounts.map((a) => (a.username || "").replace(/^@/, "").toLowerCase()).filter(Boolean));
  const hits = Object.entries(pendingPosts)
    .filter(([key, rec]) => key !== exceptKey && rec.status === "published")
    .filter(([, rec]) =>
      pendingAccounts(rec).some((a) => (a.id && ids.has(a.id)) || (a.username && names.has(a.username.replace(/^@/, "").toLowerCase()))),
    )
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  if (!hits.length) return "";
  const list = hits
    .slice(0, 3)
    .map(([key, rec]) => `${escapeHtml(key)} (${new Date(rec.createdAt || 0).toLocaleDateString("ru-RU")})`)
    .join(", ");
  return `⚠️ По этому аккаунту уже был пост: ${list}${hits.length > 3 ? ` и ещё ${hits.length - 3}` : ""}`;
}

// Shown to arbiters only: tells them whether the username/id pair is genuine.
function accountCheckHtml(a: PersonRef): string {
  if (!a.username) return "❔ указан только ID, проверить по username нельзя";
  if (a.check === "ok") return "✅ username и ID совпадают (проверено в Telegram)";
  if (a.check === "mismatch")
    return `⚠️ Заявитель указал чужой ID <code>${escapeHtml(a.claimedId || "?")}</code> — заменён на настоящий ID @${escapeHtml(a.username.replace(/^@/, ""))}`;
  return "❔ связку username и ID проверить не удалось";
}

function applicationBriefHtml(app: Application): string {
  const victimUser = escapeHtml(app.victim.username.replace(/^@/, ""));
  const victim = `${victimUser ? `@${victimUser}` : "без username"} · <code>${escapeHtml(app.victim.telegramId)}</code>`;
  const accounts = scammerAccounts(app);
  const scammer = accounts
    .map((a) => `${formatAccountLine(a.username, a.telegramId, true)}\n${accountCheckHtml(a)}`)
    .join("\n");
  const brief = (app.summary || app.story).trim();
  return [
    `<b>Заявка ${escapeHtml(app.id)}</b>`,
    "",
    `<b>Пострадавший</b>\n${victim}`,
    `<b>Аккаунт</b>\n${scammer}`,
    ...(previousPosts(accounts) ? [previousPosts(accounts)] : []),
    `<b>Ущерб</b>\n${escapeHtml(app.damageAmount)} ${escapeHtml(app.damageCurrency)}`,
    "",
    `<b>Кратко (в пост)</b>\n${escapeHtml(brief)}`,
  ].join("\n");
}

function applicationDetailHtml(app: Application): string {
  const detail = app.story.trim();
  const brief = (app.summary || "").trim();
  if (!detail || detail === brief) return "";
  return `<b>Подробно</b>\n${escapeHtml(detail)}`;
}

function applicationHtml(app: Application): string {
  const extra = applicationDetailHtml(app);
  return extra ? `${applicationBriefHtml(app)}\n\n${extra}` : applicationBriefHtml(app);
}

function formatScamAmount(amount: string, currency: string) {
  const value = amount.trim();
  if (!value) return "";
  if (currency === "USD") return `scam ${escapeHtml(value)}$`;
  return `scam ${escapeHtml(value)} ${escapeHtml(currency)}`.trim();
}

function formatChannelAccounts(
  accounts: { username: string; id: string }[],
  amount = "",
  currency = "",
): string[] {
  const scam = formatScamAmount(amount, currency);
  const multi = accounts.length > 1;
  return accounts.map((a, i) => {
    const handle = a.username.replace(/^@/, "");
    const name = handle ? `@${escapeHtml(handle)}` : "";
    const id = a.id ? `Id: ${escapeHtml(a.id)}` : "";
    const last = i === accounts.length - 1;
    if (multi) {
      const head = [name, id].filter(Boolean).join(" ");
      if (!last) return `${head} ;`;
      return scam ? `${head} - ${scam}` : head;
    }
    if (id && scam) return [name, `${id} - ${scam}`].filter(Boolean).join("\n");
    return [name, id].filter(Boolean).join("\n");
  });
}

function channelHtml(
  accounts: { username: string; id: string }[],
  story: string,
  amount = "",
  currency = "",
  bodyHtml = "",
): string {
  const people = formatChannelAccounts(accounts, amount, currency);
  const subscribe = `<b>Subscribe:</b> <b><a href="${CHANNEL_URL}">Europe Private Blacklist</a></b>`;
  return [...people, "", bodyHtml.trim() || escapeHtml(story.trim()), "", subscribe]
    .filter((line, i, arr) => line !== "" || (arr[i - 1] !== "" && i !== 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function applicationCaption(app: Application): string {
  const accounts = scammerAccounts(app);
  const scamLine = accounts
    .map((a) => formatAccountLine(a.username, a.telegramId, true))
    .join("\n");
  const victimUser = app.victim.username.replace(/^@/, "");
  return [
    `<b>Жалоба ${escapeHtml(app.id)}</b>`,
    `Пострадавший: ${victimUser ? `@${escapeHtml(victimUser)} · ` : ""}<code>${escapeHtml(app.victim.telegramId)}</code>`,
    `Аккаунт:\n${scamLine}`,
    `Ущерб: ${escapeHtml(app.damageAmount)} ${escapeHtml(app.damageCurrency)}`,
  ].join("\n").slice(0, 1024);
}

// Splits Telegram HTML into messages without cutting through a tag or an entity:
// tags still open at a cut are closed and reopened in the next part.
function splitHtml(html: string, max = 4090): string[] {
  if (html.length <= max) return [html];
  const tokens = html.match(/<[^>]*>|&[#a-zA-Z0-9]+;|[\s\S]/g) || [];
  const parts: string[] = [];
  type Open = { name: string; tag: string };
  const closers = (stack: Open[]) => stack.map((t) => `</${t.name}>`).reverse().join("");
  const openers = (stack: Open[]) => stack.map((t) => t.tag).join("");
  let stack: Open[] = [];
  let cur = "";
  type Break = { at: number; stack: Open[]; next: number };
  let lastNl: Break | null = null;
  let lastSpace: Break | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (cur.length + token.length + closers(stack).length > max && cur.trim()) {
      // Prefer a line break, then a space; cut hard only inside a giant word.
      const lastBreak = lastNl && lastNl.at > max / 3 ? lastNl : lastSpace && lastSpace.at > max / 3 ? lastSpace : null;
      lastNl = null;
      lastSpace = null;
      if (lastBreak) {
        parts.push(cur.slice(0, lastBreak.at) + closers(lastBreak.stack));
        stack = [...lastBreak.stack];
        cur = openers(stack);
        i = lastBreak.next - 1;
        continue;
      }
      parts.push(cur + closers(stack));
      cur = openers(stack);
    }
    const tag = token.match(/^<(\/)?([a-zA-Z0-9-]+)/);
    if (tag) {
      const name = tag[2]!.toLowerCase();
      if (tag[1]) {
        const idx = stack.map((t) => t.name).lastIndexOf(name);
        if (idx >= 0) stack = stack.slice(0, idx);
      } else if (!token.endsWith("/>")) {
        stack = [...stack, { name, tag: token }];
      }
    }
    cur += token;
    if (token === "\n") lastNl = { at: cur.length - 1, stack: [...stack], next: i + 1 };
    else if (token === " ") lastSpace = { at: cur.length - 1, stack: [...stack], next: i + 1 };
  }
  if (cur.replace(/<[^>]*>/g, "").trim()) parts.push(cur);
  return parts.map((p) => p.replace(/^\n+/, ""));
}

function reviewKeyboard(appId = "") {
  return {
    inline_keyboard: [
      [
        { text: "Опубликовать", callback_data: appId ? `pub:${appId}` : "pub" },
        { text: "Отклонить", callback_data: appId ? `rej:${appId}` : "rej" },
      ],
    ],
  };
}

function publishChoiceKeyboard(key = "") {
  const suffix = key ? `:${key}` : "";
  const rows = [
    [{ text: "Опубликовать с рассылкой", callback_data: `puball${suffix}`.slice(0, 64) }],
    [{ text: "Опубликовать без рассылки", callback_data: `pubch${suffix}`.slice(0, 64) }],
  ];
  if (key && pendingPosts[key]) {
    rows.push([
      { text: "✏ Изменить текст", callback_data: `pedit:${key}` },
      { text: "👁 Предпросмотр", callback_data: `pview:${key}` },
    ]);
    if (pendingPosts[key]!.postHtml) rows.push([{ text: "↩ Вернуть исходный текст", callback_data: `porig:${key}` }]);
  }
  return { inline_keyboard: rows };
}

async function tgForm<T>(method: string, form: FormData): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${botApi()}/${method}`, { method: "POST", body: form, signal: ctrl.signal });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) throw new Error(json.description || method);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

const TG_UPLOAD_MAX = 49 * 1024 * 1024;

function mediaSize(file: EvidenceItem) {
  return file.size || evidenceBytesOnDisk(file.storageKey);
}

function evidencePublicUrl(storageKey?: string) {
  if (!storageKey || !sanitizeEvidenceId(storageKey)) return "";
  const site = publicSiteUrl();
  if (!site) return "";
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const sig = evidenceSig(storageKey, exp);
  return `${site}/api/telegram/evidence?key=${encodeURIComponent(storageKey)}&exp=${exp}&sig=${sig}`;
}

async function sendMediaFile(
  chatId: string,
  file: EvidenceItem,
  opts: { caption?: string; replyMarkup?: unknown; replyTo?: number } = {},
): Promise<{ message_id: number; chat: { id: number }; fileId?: string; kind: "photo" | "video" }> {
  const size = mediaSize(file);
  if (file.kind === "video" && size > TG_UPLOAD_MAX) {
    return sendLargeVideo(chatId, file, opts);
  }
  const blob = evidenceBlob(file);
  if (!blob) throw new Error("empty file");
  if (blob.size > TG_UPLOAD_MAX && file.kind === "video") {
    return sendLargeVideo(chatId, file, opts);
  }
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (opts.caption) {
    form.set("caption", opts.caption);
    form.set("parse_mode", "HTML");
  }
  if (opts.replyMarkup) form.set("reply_markup", JSON.stringify(opts.replyMarkup));
  if (opts.replyTo) form.set("reply_to_message_id", String(opts.replyTo));
  if (file.kind === "video") {
    form.set("video", blob, file.name || "video.mp4");
    const sent = await tgForm<{ message_id: number; chat: { id: number }; video?: { file_id: string } }>(
      "sendVideo",
      form,
    );
    return { ...sent, fileId: sent.video?.file_id, kind: "video" };
  }
  form.set("photo", blob, file.name || "photo.jpg");
  const sent = await tgForm<{ message_id: number; chat: { id: number }; photo?: { file_id: string }[] }>(
    "sendPhoto",
    form,
  );
  return { ...sent, fileId: sent.photo?.at(-1)?.file_id, kind: "photo" };
}

async function sendLargeVideo(
  chatId: string,
  file: EvidenceItem,
  opts: { caption?: string; replyMarkup?: unknown; replyTo?: number } = {},
): Promise<{ message_id: number; chat: { id: number }; fileId?: string; kind: "photo" | "video" }> {
  const url = evidencePublicUrl(file.storageKey);
  const extra: Record<string, unknown> = {
    chat_id: chatId,
  };
  if (opts.caption) {
    extra.caption = opts.caption;
    extra.parse_mode = "HTML";
  }
  if (opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
  if (opts.replyTo) extra.reply_to_message_id = opts.replyTo;
  if (url) {
    const video = await tgSoft<{ message_id: number; chat: { id: number }; video?: { file_id: string } }>("sendVideo", {
      ...extra,
      video: url,
      supports_streaming: true,
    });
    if (video) return { ...video, fileId: video.video?.file_id, kind: "video" };
    const doc = await tgSoft<{ message_id: number; chat: { id: number }; document?: { file_id: string } }>(
      "sendDocument",
      { ...extra, document: url },
    );
    if (doc) return { message_id: doc.message_id, chat: doc.chat, fileId: doc.document?.file_id, kind: "video" };
  }
  const link = url || file.name || "видео";
  const sent = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
    chat_id: chatId,
    text: [opts.caption, `Видео: ${escapeHtml(file.name || "файл")}`, url ? `<a href="${url}">скачать</a>` : link]
      .filter(Boolean)
      .join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: opts.replyMarkup,
    reply_to_message_id: opts.replyTo,
  });
  return { ...sent, kind: "video" };
}

type CopiedMedia = {
  chatId: number;
  messageId: number;
  fileId?: string;
  kind?: "photo" | "video" | "document";
};

function storePending(app: Application, files: MediaRef[]) {
  const accounts = scammerAccounts(app).map((a) => ({
    username: a.username.replace(/^@/, ""),
    id: a.telegramId,
  }));
  const first = accounts[0] || { username: app.scammer.username, id: app.scammer.telegramId };
  pendingPosts[app.id] = {
    username: first.username,
    id: first.id,
    accounts,
    story: app.story,
    summary: app.summary || "",
    amount: app.damageAmount,
    currency: app.damageCurrency,
    files,
    victimId: app.victim.telegramId,
    victimUsername: app.victim.username,
    createdAt: app.createdAt || Date.now(),
    status: "pending",
  };
  savePending();
}

function scamLabel(record: PendingPost | undefined) {
  const accounts = pendingAccounts(record);
  if (!accounts.length) return "аккаунт";
  return accounts
    .map((a) => (a.username ? `@${a.username.replace(/^@/, "")}` : a.id ? `ID ${a.id}` : ""))
    .filter(Boolean)
    .join(", ");
}

async function notifyApplicant(record: PendingPost | undefined, appId: string, kind: "pending" | "published" | "rejected") {
  const chatId = record?.victimId;
  if (!chatId) return;
  const scam = scamLabel(record);
  const text =
    kind === "pending"
      ? btUser(chatId, "pendingNotice", { id: appId, scam })
      : kind === "published"
        ? btUser(chatId, "publishedNotice", { id: appId, scam })
        : btUser(chatId, "rejectedNotice", { id: appId, scam });
  await tgSoft("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

export function listComplaintsForUser(telegramId: string): ComplaintHistoryItem[] {
  const uid = String(telegramId || "").trim();
  if (!uid) return [];
  return Object.entries(pendingPosts)
    .filter(([, c]) => c.victimId === uid)
    .map(([id, c]) => ({
      id,
      scammerUsername: pendingAccounts(c)
        .map((a) => a.username)
        .filter(Boolean)
        .join(" · ") || c.username || "",
      scammerId: pendingAccounts(c)
        .map((a) => a.id)
        .filter(Boolean)
        .join(", ") || c.id || "",
      amount: c.amount || "",
      currency: c.currency || "",
      status: c.status || "pending",
      createdAt: c.createdAt || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- Owner userbot setup (connect an account, pick channels to parse) ----------
// Only the bot owner (OWNER_ID) can do this, in a private chat with the bot.

type LoginStep = "apiId" | "apiHash" | "phone" | "code" | "password";
type LoginState = {
  step: LoginStep;
  apiId?: number;
  apiHash?: string;
  phone?: string;
  phoneCodeHash?: string;
  // The gramjs client, kept alive between the code request and sign-in.
  client?: any;
  Api?: any;
  touched: number;
};
const loginStates = new Map<string, LoginState>();

function ownerLoginActive(chatId: string | number): boolean {
  const st = loginStates.get(String(chatId));
  if (!st) return false;
  if (Date.now() - st.touched > 10 * 60_000) {
    void st.client?.disconnect?.().catch(() => {});
    loginStates.delete(String(chatId));
    return false;
  }
  return true;
}

async function sendOwnerPanel(chatId: string | number) {
  const st = await userbotStatus();
  const connected = st.ok;
  const channels = checkChannels();
  const rows: { text: string; callback_data: string }[][] = [];
  if (connected) {
    rows.push([{ text: "📡 Выбрать каналы для поиска", callback_data: "ub:chans" }]);
    rows.push([{ text: "🔌 Переподключить аккаунт", callback_data: "ub:connect" }]);
    rows.push([{ text: "❌ Отключить аккаунт", callback_data: "ub:off" }]);
  } else {
    rows.push([{ text: "➕ Подключить аккаунт", callback_data: "ub:connect" }]);
  }
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: [
      "<b>Юзербот для поиска по блеклистам</b>",
      connected ? `Аккаунт: ${escapeHtml(st.name || "подключён")} ✅` : "Аккаунт не подключён",
      `Каналов выбрано для поиска: ${channels.length}`,
      "",
      connected
        ? "Поиск в мини-приложении идёт по выложенным жалобам EPB и по выбранным каналам (через аккаунт, по username, включая старые посты)."
        : "Подключите свой аккаунт Telegram, затем выберите каналы, по которым искать. Понадобятся api_id и api_hash с my.telegram.org.",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function startOwnerLogin(chatId: string | number) {
  const existing = loginStates.get(String(chatId));
  if (existing?.client) await existing.client.disconnect?.().catch(() => {});
  loginStates.set(String(chatId), { step: "apiId", touched: Date.now() });
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: [
      "<b>Подключение аккаунта</b>",
      "",
      "Нужны api_id и api_hash: зайдите на https://my.telegram.org → API development tools.",
      "",
      "Пришлите <b>api_id</b> (число).",
      "Отмена: /cancel_userbot",
    ].join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// Handles the owner's text replies during login. Returns true when consumed.
async function handleOwnerLogin(chatId: string | number, text: string): Promise<boolean> {
  const key = String(chatId);
  const st = loginStates.get(key);
  if (!st) return false;
  st.touched = Date.now();
  const value = text.trim();
  const fail = async (msg: string) => {
    await tgSoft("sendMessage", { chat_id: chatId, text: msg });
  };
  try {
    if (st.step === "apiId") {
      const n = Number(value);
      if (!n || !Number.isInteger(n)) return (await fail("api_id — это число. Пришлите ещё раз."), true);
      st.apiId = n;
      st.step = "apiHash";
      await tgSoft("sendMessage", { chat_id: chatId, text: "Теперь пришлите <b>api_hash</b>.", parse_mode: "HTML" });
      return true;
    }
    if (st.step === "apiHash") {
      if (!/^[a-f0-9]{16,}$/i.test(value)) return (await fail("Похоже, это не api_hash. Пришлите ещё раз."), true);
      st.apiHash = value;
      st.step = "phone";
      await tgSoft("sendMessage", { chat_id: chatId, text: "Пришлите номер телефона аккаунта в формате +7999…" });
      return true;
    }
    if (st.step === "phone") {
      if (!/^\+?\d{7,15}$/.test(value.replace(/\s/g, ""))) return (await fail("Неверный номер. Пример: +79991234567"), true);
      st.phone = value.replace(/\s/g, "");
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      const { Api } = await import("telegram/tl/index.js");
      const { Logger } = await import("telegram/extensions/Logger.js");
      st.client = new TelegramClient(new StringSession(""), st.apiId!, st.apiHash!, {
        connectionRetries: 2,
        baseLogger: new Logger("none" as never),
      });
      st.Api = Api;
      await withTimeout(st.client.connect(), 25_000, "connect timeout");
      const sent = (await withTimeout(st.client.sendCode({ apiId: st.apiId, apiHash: st.apiHash }, st.phone), 25_000, "sendCode timeout")) as { phoneCodeHash: string };
      st.phoneCodeHash = sent.phoneCodeHash;
      st.step = "code";
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: "Код отправлен в Telegram на этот аккаунт. Пришлите код. Если боитесь, что Telegram заблокирует код в сообщении — вставьте пробелы: 1 2 3 4 5.",
      });
      return true;
    }
    if (st.step === "code") {
      const code = value.replace(/\D/g, "");
      if (!code) return (await fail("Пришлите код из Telegram."), true);
      try {
        await withTimeout(
          st.client.invoke(new st.Api.auth.SignIn({ phoneNumber: st.phone, phoneCodeHash: st.phoneCodeHash, phoneCode: code })),
          25_000,
          "signin timeout",
        );
      } catch (err) {
        const m = (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message || "";
        if (/SESSION_PASSWORD_NEEDED/.test(m)) {
          st.step = "password";
          await tgSoft("sendMessage", { chat_id: chatId, text: "На аккаунте включена двухфакторная защита. Пришлите пароль." });
          return true;
        }
        if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/.test(m)) return (await fail("Код неверный или просрочен. Пришлите ещё раз, либо начните заново: /cancel_userbot."), true);
        throw err;
      }
      await finishOwnerLogin(chatId, st);
      return true;
    }
    if (st.step === "password") {
      const { computeCheck } = await import("telegram/Password.js");
      const pwd = await st.client.invoke(new st.Api.account.GetPassword());
      const check = await computeCheck(pwd, value);
      try {
        await withTimeout(st.client.invoke(new st.Api.auth.CheckPassword({ password: check })), 25_000, "password timeout");
      } catch (err) {
        const m = (err as { errorMessage?: string })?.errorMessage || "";
        if (/PASSWORD_HASH_INVALID/.test(m)) return (await fail("Пароль неверный. Пришлите ещё раз."), true);
        throw err;
      }
      await finishOwnerLogin(chatId, st);
      return true;
    }
  } catch (err) {
    loginStates.delete(key);
    await st.client?.disconnect?.().catch(() => {});
    await fail(`Не удалось подключить аккаунт: ${(err as Error)?.message || "ошибка"}. Начните заново: /userbot`);
    return true;
  }
  return true;
}

async function finishOwnerLogin(chatId: string | number, st: LoginState) {
  const session = st.client.session.save() as string;
  saveUserSession(session);
  bindings.userbotApi = { apiId: st.apiId!, apiHash: st.apiHash! };
  saveBindings();
  await st.client.disconnect?.().catch(() => {});
  loginStates.delete(String(chatId));
  dropUserbot(); // reconnect lazily with the saved session
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: "Аккаунт подключён ✅\nТеперь выберите каналы для поиска.",
  });
  await sendChannelPicker(chatId);
}

// List the account's channels with on/off toggles.
async function sendChannelPicker(chatId: string | number, editMessageId?: number) {
  const dialogs: { id: string; title: string; username?: string }[] = [];
  try {
    const { client } = await userbot();
    const list = (await withTimeout((client as any).getDialogs({ limit: 200 }), 20_000, "dialogs timeout")) as any[];
    for (const d of list) {
      const e = d?.entity;
      if (!e || e.className !== "Channel") continue; // channels and megagroups
      dialogs.push({ id: `-100${e.id?.toString?.() ?? e.id}`, title: d.title || e.title || "канал", username: e.username || undefined });
    }
  } catch (err) {
    await tgSoft("sendMessage", { chat_id: chatId, text: `Не удалось получить список каналов: ${(err as Error)?.message || "ошибка"}` });
    return;
  }
  if (!dialogs.length) {
    await tgSoft("sendMessage", { chat_id: chatId, text: "У аккаунта нет каналов. Подпишитесь на нужные каналы и откройте список снова: /userbot" });
    return;
  }
  const selected = new Set(checkChannels().map((c) => chatIdKey(c.id)));
  const rows = dialogs.slice(0, 60).map((d) => [
    { text: `${selected.has(chatIdKey(d.id)) ? "✅" : "▫️"} ${cut(d.title, 40)}`, callback_data: `ub:tgl:${d.id}` },
  ]);
  rows.push([{ text: "Готово", callback_data: "ub:done" }]);
  const text = "<b>Каналы для поиска</b>\nОтметьте, по каким каналам искать. Нажмите «Готово», когда закончите.";
  if (editMessageId) {
    await tgSoft("editMessageText", { chat_id: chatId, message_id: editMessageId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
  } else {
    await tgSoft("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
  }
  // Remember the titles/usernames so search can build links even without re-fetching.
  dialogCache.clear();
  for (const d of dialogs) dialogCache.set(chatIdKey(d.id), d);
}

const dialogCache = new Map<string, { id: string; title: string; username?: string }>();

async function toggleCheckChannel(id: string) {
  const list = [...checkChannels()];
  const idx = list.findIndex((c) => sameChat(c.id, id));
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    const d = dialogCache.get(chatIdKey(id));
    list.push({ id, title: d?.title, username: d?.username, addedAt: Date.now() });
  }
  bindings.checkChannels = list.slice(-100);
  saveBindings();
}

// Owner callbacks (ub:*). Returns true when handled.
async function handleOwnerCallback(cb: NonNullable<TgUpdate["callback_query"]>): Promise<boolean> {
  const data = cb.data || "";
  if (!data.startsWith("ub:")) return false;
  const chatId = cb.message?.chat.id;
  if (!chatId || !isOwner(cb.from?.id)) {
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Недоступно", show_alert: true });
    return true;
  }
  const [, action, ...rest] = data.split(":");
  const answer = (t = "") => tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: t || undefined });
  if (action === "connect") {
    await answer();
    await startOwnerLogin(chatId);
  } else if (action === "off") {
    clearUserSession();
    delete bindings.userbotApi;
    saveBindings();
    await answer("Аккаунт отключён");
    await sendOwnerPanel(chatId);
  } else if (action === "chans") {
    await answer();
    await sendChannelPicker(chatId);
  } else if (action === "tgl") {
    await toggleCheckChannel(rest.join(":"));
    await answer();
    await sendChannelPicker(chatId, cb.message!.message_id);
  } else if (action === "done") {
    await answer("Сохранено");
    await tgSoft("editMessageText", {
      chat_id: chatId,
      message_id: cb.message!.message_id,
      text: `Готово. Каналов для поиска: ${checkChannels().length}.`,
    });
  } else {
    await answer();
  }
  return true;
}


// ---------- Counterparty check: EPB blacklist + configured channels ----------

type CheckChannel = { id: string; title?: string; username?: string; addedAt: number };
type CheckHit = {
  channelId: string;
  channelTitle: string;
  username?: string;
  messageId: number;
  link: string;
  date: number;
  snippet: string;
};

const CHECK_INDEX_PATH = join(DATA_DIR, "telegram-check-index.json");
// token (lowercase @username or numeric id) -> posts that mention it.
const checkIndex: Record<string, CheckHit[]> = readJson<Record<string, CheckHit[]>>(CHECK_INDEX_PATH) || {};

let checkIndexTimer: ReturnType<typeof setTimeout> | null = null;
function saveCheckIndex() {
  if (checkIndexTimer) return;
  checkIndexTimer = setTimeout(() => {
    checkIndexTimer = null;
    try {
      writeJsonAtomic(CHECK_INDEX_PATH, checkIndex);
    } catch {
      /* ignore */
    }
  }, 3000);
}

function checkChannels(): CheckChannel[] {
  return bindings.checkChannels || [];
}

function isCheckChannel(id: string | number | undefined): CheckChannel | undefined {
  if (id == null) return undefined;
  return checkChannels().find((c) => sameChat(c.id, id));
}

// Pull every telegram handle and numeric id out of a post, as search tokens.
function tokensFromText(text: string): { usernames: string[]; ids: string[] } {
  const usernames = new Set<string>();
  const ids = new Set<string>();
  for (const m of text.matchAll(/@([A-Za-z][A-Za-z0-9_]{3,31})/g)) usernames.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})/gi)) usernames.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/(?:tg:\/\/user\?id=|\bid[:\s=]*)(\d{5,15})/gi)) ids.add(m[1]!);
  for (const m of text.matchAll(/\b(\d{7,15})\b/g)) ids.add(m[1]!);
  return { usernames: [...usernames], ids: [...ids] };
}

function messageLink(channel: CheckChannel, messageId: number): string {
  if (channel.username) return `https://t.me/${channel.username.replace(/^@/, "")}/${messageId}`;
  const internal = String(channel.id).replace(/^-100/, "").replace(/^-/, "");
  return `https://t.me/c/${internal}/${messageId}`;
}

function addCheckHit(token: string, hit: CheckHit) {
  const list = checkIndex[token] || (checkIndex[token] = []);
  if (list.some((h) => sameChat(h.channelId, hit.channelId) && h.messageId === hit.messageId)) return;
  list.unshift(hit);
  if (list.length > 25) list.length = 25;
}

// A post arrived in a configured check channel: index its handles and ids.
function indexCheckPost(channel: CheckChannel, messageId: number, text: string, date: number) {
  const body = (text || "").slice(0, 4096);
  if (!body.trim()) return;
  const { usernames, ids } = tokensFromText(body);
  if (!usernames.length && !ids.length) return;
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160);
  const hit: CheckHit = {
    channelId: String(channel.id),
    channelTitle: channel.title || "канал",
    messageId,
    link: messageLink(channel, messageId),
    date: date * 1000 || Date.now(),
    snippet,
  };
  for (const u of usernames) addCheckHit(`@${u}`, { ...hit, username: u });
  for (const id of ids) addCheckHit(id, hit);
  // Keep the whole index bounded.
  const keys = Object.keys(checkIndex);
  if (keys.length > 200000) for (const k of keys.slice(0, keys.length - 180000)) delete checkIndex[k];
  saveCheckIndex();
}

function removeCheckChannelFromIndex(channelId: string) {
  for (const [token, list] of Object.entries(checkIndex)) {
    const kept = list.filter((h) => !sameChat(h.channelId, channelId));
    if (kept.length) checkIndex[token] = kept;
    else delete checkIndex[token];
  }
  saveCheckIndex();
}

export type CheckResult = {
  query: { username: string; id: string };
  epb: { id: string; accounts: string; amount: string; currency: string; date: number }[];
  channels: CheckHit[];
  manual: { id: string; account: string; source: string; note?: string; date: number }[];
};

// A compact entry for the "recent blacklists" list. Deliberately light (no
// story/summary) so the list loads fast; the full text is fetched on tap.
export type BlacklistEntry = {
  kind: "epb" | "manual";
  id: string;
  account: string;
  amount?: string;
  currency?: string;
  date: number;
  source?: string;
  note?: string;
};

const DEFAULT_MANUAL_SOURCE = "Сторонний источник";

// The most recent blacklist entries, newest first: our EPB blacklist plus the
// manually added (third-party) ones. The home ticker filters to EPB only; the
// check page shows both.
export function recentBlacklist(limit = 24): BlacklistEntry[] {
  if (!checkEnabled()) return [];
  const out: BlacklistEntry[] = [];
  for (const [key, rec] of Object.entries(pendingPosts)) {
    if (rec.status !== "published" || !rec.channelPosted || rec.removedFromCheck) continue;
    out.push({
      kind: "epb",
      id: key,
      account: scamLabel(rec),
      amount: rec.amount || "",
      currency: rec.currency || "",
      date: rec.createdAt || 0,
    });
  }
  for (const e of bindings.manualBlacklist || []) {
    out.push({
      kind: "manual",
      id: e.id,
      account: e.username ? `@${e.username.replace(/^@/, "")}` : e.telegramId ? `ID ${e.telegramId}` : "",
      date: e.addedAt || 0,
      source: e.source || DEFAULT_MANUAL_SOURCE,
      note: e.note,
    });
  }
  out.sort((a, b) => b.date - a.date);
  return out.slice(0, Math.max(1, limit));
}

// Full detail for one blacklist entry, fetched when a card is opened.
export type BlacklistDetailResult = {
  kind: "epb" | "manual";
  id: string;
  account: string;
  amount?: string;
  currency?: string;
  date: number;
  summary?: string;
  story?: string;
  source?: string;
  note?: string;
} | null;

export function blacklistEntry(id: string): BlacklistDetailResult {
  if (!checkEnabled() || !id) return null;
  const rec = pendingPosts[id] || pendingPosts[id.toUpperCase()];
  if (rec && rec.status === "published" && rec.channelPosted && !rec.removedFromCheck) {
    return {
      kind: "epb",
      id,
      account: scamLabel(rec),
      amount: rec.amount || "",
      currency: rec.currency || "",
      date: rec.createdAt || 0,
      summary: rec.summary || "",
      story: rec.story || rec.summary || "",
    };
  }
  const man = (bindings.manualBlacklist || []).find((e) => e.id === id);
  if (man) {
    return {
      kind: "manual",
      id,
      account: man.username ? `@${man.username.replace(/^@/, "")}` : man.telegramId ? `ID ${man.telegramId}` : "",
      date: man.addedAt || 0,
      source: man.source || DEFAULT_MANUAL_SOURCE,
      note: man.note,
    };
  }
  return null;
}

function matchManualBlacklist(uname: string, id: string): CheckResult["manual"] {
  const out: CheckResult["manual"] = [];
  for (const e of bindings.manualBlacklist || []) {
    const eu = (e.username || "").replace(/^@/, "").toLowerCase();
    if ((uname && eu === uname) || (id && e.telegramId === id)) {
      out.push({
        id: e.id,
        account: e.username ? `@${e.username.replace(/^@/, "")}` : e.telegramId ? `ID ${e.telegramId}` : "",
        source: e.source || DEFAULT_MANUAL_SOURCE,
        note: e.note,
        date: e.addedAt || 0,
      });
    }
  }
  return out.sort((a, b) => b.date - a.date);
}

// Search the EPB blacklist (published complaints) and the configured channels.
export async function checkCounterparty(input: string): Promise<CheckResult> {
  if (!checkEnabled()) return { query: { username: "", id: "" }, epb: [], channels: [], manual: [] };
  const parsed = parseTelegramInput(input);
  const uname = parsed.username.replace(/^@/, "").toLowerCase();
  const id = parsed.id;
  const matched: { key: string; rec: PendingPost }[] = [];
  for (const [key, rec] of Object.entries(pendingPosts)) {
    // Only approved complaints that actually went out to the EPB channel and were not removed.
    if (rec.status !== "published" || !rec.channelPosted || rec.removedFromCheck) continue;
    const accounts = pendingAccounts(rec);
    const match =
      (uname && accounts.some((a) => a.username.replace(/^@/, "").toLowerCase() === uname)) ||
      (id && accounts.some((a) => a.id === id));
    if (match) matched.push({ key, rec });
  }
  // With a connected account, drop complaints whose channel post was deleted.
  const epb: CheckResult["epb"] = [];
  for (const { key, rec } of matched) {
    if (await channelPostDeleted(rec)) {
      rec.removedFromCheck = true;
      savePending();
      continue;
    }
    const accounts = pendingAccounts(rec);
    epb.push({
      id: key,
      accounts: accounts.map((a) => (a.username ? `@${a.username.replace(/^@/, "")}` : a.id ? `ID ${a.id}` : "")).filter(Boolean).join(", "),
      amount: rec.amount || "",
      currency: rec.currency || "",
      date: rec.createdAt || 0,
    });
  }
  epb.sort((a, b) => b.date - a.date);

  const hits: CheckHit[] = [];
  const seen = new Set<string>();
  const push = (list: CheckHit[]) => {
    for (const h of list) {
      const dkey = `${chatIdKey(h.channelId)}:${h.messageId}`;
      if (seen.has(dkey)) continue;
      seen.add(dkey);
      hits.push(h);
    }
  };

  const channels = checkChannels();
  if (hasUserbot() && channels.length) {
    // Live full-history search in every configured channel (old posts included).
    const queries: { q: string; needle: string }[] = [];
    if (uname) queries.push({ q: uname, needle: uname });
    if (id) queries.push({ q: id, needle: id });
    for (const channel of channels) {
      for (const { q, needle } of queries) {
        push(await userSearchChannel(channel, q, needle));
      }
    }
  } else {
    // Fallback: posts indexed by the bot since each channel was connected.
    for (const token of [uname ? `@${uname}` : "", id].filter(Boolean)) push(checkIndex[token] || []);
  }
  hits.sort((a, b) => b.date - a.date);
  return { query: { username: uname, id }, epb, channels: hits.slice(0, 30), manual: matchManualBlacklist(uname, id) };
}

export function allowCheck(initData: string): { ok: true; userId: string } | { ok: false; error: string } {
  if (!checkEnabled()) return { ok: false, error: "disabled" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`check:${user.id}`, 40, 60_000)) return { ok: false, error: "too many" };
  if (tooMany("check:global", 1500, 60_000)) return { ok: false, error: "busy" };
  return { ok: true, userId: user.id };
}

function packCaption(full: string, _fallback = "") {
  if (full.length <= 1024) return { caption: full, leftover: "" };
  return { caption: "", leftover: full };
}

async function attachReviewButtons(chatId: string, messageId: number, leftover: string, keyboard: unknown) {
  if (!leftover) {
    const sent = await tgSoft<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: "Опубликовать или отклонить:",
      reply_to_message_id: messageId,
      reply_markup: keyboard,
    });
    return sent?.message_id || messageId;
  }
  const parts = splitHtml(leftover);
  let lastId = messageId;
  for (let i = 0; i < parts.length; i++) {
    const sent = await tgSoft<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: parts[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_to_message_id: i === 0 ? messageId : undefined,
      reply_markup: i === parts.length - 1 ? keyboard : undefined,
    });
    if (sent?.message_id) lastId = sent.message_id;
  }
  return lastId;
}

function mediaRefsFromCopies(copies: CopiedMedia[]): MediaRef[] {
  return copies
    .filter((c): c is CopiedMedia & { fileId: string } => Boolean(c.fileId))
    .map((c) => ({
      type: c.kind === "video" ? "video" : c.kind === "document" ? "document" : "photo",
      file_id: c.fileId,
    }));
}

// Telegram albums: photos and videos may be mixed, documents only with documents; max 10.
function groupMedia<T extends { type?: string; kind?: string }>(files: T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentDoc = false;
  for (const file of files) {
    const isDoc = (file.type || file.kind) === "document";
    if (current.length && (current.length >= 10 || isDoc !== currentDoc)) {
      groups.push(current);
      current = [];
    }
    currentDoc = isDoc;
    current.push(file);
  }
  if (current.length) groups.push(current);
  return groups;
}

async function sendAlbumByFileIds(
  chatId: string,
  files: MediaRef[],
  caption: string,
  keyboard: unknown,
  followUp = caption,
): Promise<{ chat_id: string; message_id: number; files: MediaRef[] }> {
  if (!files.length) {
    const parts = splitHtml(followUp);
    let lastId = 0;
    let lastChat = chatId;
    for (let i = 0; i < parts.length; i++) {
      const sent = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
        chat_id: chatId,
        text: parts[i],
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: i === parts.length - 1 ? keyboard : undefined,
      });
      lastId = sent.message_id;
      lastChat = String(sent.chat.id);
    }
    return { chat_id: lastChat, message_id: lastId, files: [] };
  }
  if (files.length === 1) {
    const file = files[0]!;
    const packed = packCaption(followUp, caption);
    const method = file.type === "video" ? "sendVideo" : file.type === "document" ? "sendDocument" : "sendPhoto";
    const payload: Record<string, unknown> = {
      chat_id: chatId,
    };
    if (packed.caption) {
      payload.caption = packed.caption;
      payload.parse_mode = "HTML";
    }
    if (!packed.leftover) payload.reply_markup = keyboard;
    if (file.type === "video") payload.video = file.file_id;
    else if (file.type === "document") payload.document = file.file_id;
    else payload.photo = file.file_id;
    const sent = await tg<{ message_id: number; chat: { id: number } }>(method, payload);
    if (!packed.leftover) return { chat_id: String(sent.chat.id), message_id: sent.message_id, files };
    const actionId = await attachReviewButtons(chatId, sent.message_id, packed.leftover, keyboard);
    return { chat_id: String(sent.chat.id), message_id: actionId, files };
  }

  const packed = packCaption(followUp, caption);
  let firstId = 0;
  for (const [i, chunk] of groupMedia(files).entries()) {
    if (chunk.length === 1) {
      const file = chunk[0]!;
      const method = file.type === "video" ? "sendVideo" : file.type === "document" ? "sendDocument" : "sendPhoto";
      const payload: Record<string, unknown> = { chat_id: chatId };
      if (file.type === "video") payload.video = file.file_id;
      else if (file.type === "document") payload.document = file.file_id;
      else payload.photo = file.file_id;
      if (i === 0 && packed.caption) {
        payload.caption = packed.caption;
        payload.parse_mode = "HTML";
      }
      const sent = await tg<{ message_id: number }>(method, payload);
      if (i === 0) firstId = sent.message_id;
      continue;
    }
    const result = await tg<{ message_id: number }[]>("sendMediaGroup", {
      chat_id: chatId,
      media: chunk.map((file, idx) => ({
        type: file.type,
        media: file.file_id,
        ...(i === 0 && idx === 0 && packed.caption ? { caption: packed.caption, parse_mode: "HTML" } : {}),
      })),
    });
    if (i === 0) firstId = result[0]?.message_id || 0;
  }
  const actionId = await attachReviewButtons(chatId, firstId, packed.leftover, keyboard);
  return { chat_id: chatId, message_id: actionId, files };
}

async function sendAlbumFromBlobs(
  chatId: string,
  blobs: EvidenceItem[],
  caption: string,
  keyboard: unknown,
  followUp = caption,
): Promise<{ chat_id: string; message_id: number; files: MediaRef[] }> {
  const packed = packCaption(followUp, caption);
  const small = blobs.filter((f) => f.kind !== "video" || mediaSize(f) <= TG_UPLOAD_MAX);
  const large = blobs.filter((f) => f.kind === "video" && mediaSize(f) > TG_UPLOAD_MAX);
  const files: MediaRef[] = [];
  let firstId = 0;

  if (!small.length && large.length) {
    const sent = await sendMediaFile(chatId, large[0]!, {
      caption: packed.caption || undefined,
      replyMarkup: packed.leftover || large.length > 1 ? undefined : keyboard,
    });
    if (sent.fileId) files.push({ type: sent.kind, file_id: sent.fileId });
    for (const extra of large.slice(1)) {
      const more = await sendMediaFile(chatId, extra);
      if (more.fileId) files.push({ type: more.kind, file_id: more.fileId });
    }
    if (!packed.leftover && large.length === 1) {
      return { chat_id: String(sent.chat.id), message_id: sent.message_id, files };
    }
    const actionId = await attachReviewButtons(chatId, sent.message_id, packed.leftover, keyboard);
    return { chat_id: String(sent.chat.id), message_id: actionId, files };
  }

  if (small.length <= 1) {
    const sent = await sendMediaFile(chatId, small[0]!, {
      caption: packed.caption || undefined,
      replyMarkup: packed.leftover || large.length ? undefined : keyboard,
    });
    if (sent.fileId) files.push({ type: sent.kind, file_id: sent.fileId });
    firstId = sent.message_id;
    for (const extra of large) {
      const more = await sendMediaFile(chatId, extra);
      if (more.fileId) files.push({ type: more.kind, file_id: more.fileId });
    }
    if (!packed.leftover && !large.length) {
      return { chat_id: String(sent.chat.id), message_id: sent.message_id, files };
    }
    const actionId = await attachReviewButtons(chatId, firstId, packed.leftover, keyboard);
    return { chat_id: String(sent.chat.id), message_id: actionId, files };
  }

  for (let i = 0; i < small.length; i += 10) {
    const chunk = small.slice(i, i + 10);
    if (chunk.length === 1) {
      const sent = await sendMediaFile(chatId, chunk[0]!, i === 0 && packed.caption ? { caption: packed.caption } : {});
      if (sent.fileId) files.push({ type: sent.kind, file_id: sent.fileId });
      if (i === 0) firstId = sent.message_id;
      continue;
    }
    const form = new FormData();
    form.set("chat_id", chatId);
    const media: Record<string, unknown>[] = [];
    chunk.forEach((file, idx) => {
      const blob = evidenceBlob(file);
      if (!blob) return;
      const key = `file${i + idx}`;
      form.set(key, blob, file.name || `${key}.jpg`);
      media.push({
        type: file.kind === "video" ? "video" : "photo",
        media: `attach://${key}`,
        ...(i === 0 && idx === 0 && packed.caption ? { caption: packed.caption, parse_mode: "HTML" } : {}),
      });
    });
    form.set("media", JSON.stringify(media));
    const result = await tgForm<
      { message_id: number; photo?: { file_id: string }[]; video?: { file_id: string } }[]
    >("sendMediaGroup", form);
    if (i === 0) firstId = result[0]?.message_id || 0;
    for (const msg of result) {
      if (msg.video?.file_id) files.push({ type: "video", file_id: msg.video.file_id });
      else if (msg.photo?.length) files.push({ type: "photo", file_id: msg.photo.at(-1)!.file_id });
    }
  }
  for (const extra of large) {
    const more = await sendMediaFile(chatId, extra);
    if (more.fileId) files.push({ type: more.kind, file_id: more.fileId });
  }
  const actionId = await attachReviewButtons(chatId, firstId, packed.leftover, keyboard);
  return { chat_id: chatId, message_id: actionId, files };
}

// The full story can be up to 5000 characters, more than one Telegram message holds.
async function sendDetail(chatId: string | number, html: string, replyTo: number) {
  for (const [i, part] of splitHtml(html).entries()) {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_to_message_id: i === 0 ? replyTo : undefined,
    });
  }
}

async function deliverApplication(
  app: Application,
  copies: CopiedMedia[] = [],
): Promise<{ chat_id: string; message_id: number }> {
  const caption = applicationCaption(app);
  const briefText = applicationBriefHtml(app);
  const detailText = applicationDetailHtml(app);
  const keyboard = reviewKeyboard(app.id);
  const blobs = app.evidence.filter(
    (f) => Boolean(f.storageKey && uploadedEvidencePath(f.storageKey)) || Boolean(evidenceBlob(f)),
  );
  const copyFiles = mediaRefsFromCopies(copies);
  let lastError = "chat not found";

  for (const chat_id of arbiterCandidates()) {
    try {
      if (copyFiles.length || copies.length) {
        const sent = copyFiles.length
          ? await sendAlbumByFileIds(chat_id, copyFiles, caption, keyboard, briefText)
          : null;
        if (sent) {
          if (detailText) {
            await sendDetail(sent.chat_id, detailText, sent.message_id);
          }
          storePending(app, sent.files);
          return { chat_id: sent.chat_id, message_id: sent.message_id };
        }
      }

      if (blobs.length) {
        const sent = await sendAlbumFromBlobs(chat_id, blobs, caption, keyboard, briefText);
        if (detailText) {
          await sendDetail(sent.chat_id, detailText, sent.message_id);
        }
        storePending(app, sent.files);
        return { chat_id: sent.chat_id, message_id: sent.message_id };
      }

      const parts = splitHtml(briefText);
      let lastId = 0;
      let lastChat = chat_id;
      for (let i = 0; i < parts.length; i++) {
        const sent = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
          chat_id,
          text: parts[i],
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: i === parts.length - 1 ? keyboard : undefined,
        });
        lastId = sent.message_id;
        lastChat = String(sent.chat.id);
      }
      if (detailText) {
        await sendDetail(lastChat, detailText, lastId);
      }
      storePending(app, []);
      return { chat_id: lastChat, message_id: lastId };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

export async function sendApplicationToArbiters(
  app: Application,
  copies: CopiedMedia[] = [],
): Promise<{
  ok: boolean;
  error?: string;
}> {
  const userId = app.victim.telegramId || "";
  const blocked = allowNewComplaint(userId, app.story.length);
  if (blocked) return { ok: false, error: blocked };
  app.id = `EPB-${createHash("sha256").update(`${userId}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 6).toUpperCase()}`;
  app.evidence = (app.evidence || []).slice(0, 30).map((file) => ({
    ...file,
    name: String(file.name || "file").slice(0, 120),
    dataUrl: "",
    storageKey: evidenceOwnedBy(file.storageKey, userId) ? file.storageKey : undefined,
  }));
  if (app.evidence.length > 30) return { ok: false, error: btUser(userId, "tooManyFiles") };
  // The id typed by the applicant is never trusted: when Telegram knows the username,
  // its id replaces whatever was submitted, so a post can't name the wrong person.
  for (const account of scammerAccounts(app).slice(0, 8)) {
    account.username = String(account.username || "").replace(/^@/, "").trim();
    account.telegramId = /^\d{5,15}$/.test(String(account.telegramId || "").trim()) ? String(account.telegramId).trim() : "";
    account.check = "unknown";
    if (account.username) {
      const found = await lookupVerifiedId(account.username);
      if (found && found !== "busy") {
        if (account.telegramId && account.telegramId !== found.id) account.claimedId = account.telegramId;
        account.telegramId = found.id;
        account.check = account.claimedId ? "mismatch" : "ok";
      }
    } else if (account.telegramId) {
      const chat = await tgSoft<{ id: number; username?: string; type?: string }>("getChat", { chat_id: account.telegramId });
      if (chat?.type === "private" && chat.username) {
        account.username = chat.username;
        rememberHandle(chat.username, account.telegramId);
        account.check = "ok";
      }
    }
  }
  try {
    const sent = await deliverApplication(app, copies);
    if (isOfficialArbiterChat(sent.chat_id)) {
      bindings.arbiterChatId = sent.chat_id;
      saveBindings();
    }
    if (pendingPosts[app.id]) {
      pendingPosts[app.id]!.reviewChatId = String(sent.chat_id);
      pendingPosts[app.id]!.reviewMessageId = sent.message_id;
      savePending();
    }
    await notifyApplicant(pendingPosts[app.id], app.id, "pending");
    return { ok: true };
  } catch (err) {
    const description = err instanceof Error ? err.message : "send failed";
    if (/chat not found/i.test(description)) {
      return {
        ok: false,
        error: btUser(userId, "addBotArbiter", { bot: BOT_USERNAME }),
      };
    }
    return { ok: false, error: description };
  }
}

async function sendToFirstChat(ids: string[], html: string, extra: Record<string, unknown> = {}) {
  let lastError = "chat not found";
  for (const chat_id of ids) {
    try {
      const result = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
        chat_id,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      });
      return { ...result, chat_id: String(result.chat.id) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

function dataUrlToBlob(item: EvidenceItem): Blob | null {
  if (!item.dataUrl?.includes(",")) return null;
  const b64 = item.dataUrl.split(",")[1] || "";
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  return new Blob([new Uint8Array(buf)], { type: item.mime || "application/octet-stream" });
}

function evidenceBlob(item: EvidenceItem): Blob | null {
  const fromUrl = dataUrlToBlob(item);
  if (fromUrl) return fromUrl;
  if (!item.storageKey) return null;
  const buf = readUploadedEvidence(item.storageKey);
  if (!buf?.length) return null;
  return new Blob([new Uint8Array(buf)], { type: item.mime || "application/octet-stream" });
}

function parseAppKey(text: string, data = "") {
  const fromCb = callbackKey(data);
  if (fromCb && /^EPB-/i.test(fromCb)) return fromCb;
  const fromText = text.match(/\b(EPB-[A-Z0-9]+)\b/i);
  if (fromText?.[1]) return fromText[1];
  return parseEpbMarker(text)?.key || fromCb;
}

function stripServiceMarker(text: string) {
  return text
    .replace(/\n*#epb[^\n]*/gi, "")
    .replace(/\n*#published[^\n]*/gi, "")
    .replace(/\n*#rejected[^\n]*/gi, "")
    .replace(/\n*Статус:[^\n]*/gi, "")
    .trim();
}

function alreadyHandled(text: string) {
  return /Статус:\s*(опубликовано|отклонено)/i.test(text) || text.includes("#published") || text.includes("#rejected");
}

function parseEpbMarker(text: string): { username: string; id: string; story: string; key: string } | null {
  const marker = text.match(/#epb u=(\S*) id=(\d+)(?: k=(\S+))?/);
  if (!marker) return null;
  let story = "";
  if (text.includes("Суть обмана")) {
    story = (text.split("Суть обмана")[1] ?? "")
      .replace(/^\s*\n/, "")
      .replace(/\n#epb[\s\S]*$/, "")
      .trim();
  } else {
    story = text
      .replace(/[\s\S]*?Ущерб:[^\n]*\n+/i, "")
      .replace(/\n*#epb[\s\S]*$/, "")
      .trim();
  }
  return { username: marker[1] ?? "", id: marker[2] ?? "", story, key: marker[3] ?? "" };
}

// Error that remembers what was already delivered before the failure.
class PartialSendError extends Error {
  sentIds: number[];
  // true = Telegram answered with an error; false = no answer (timeout, network).
  answered: boolean;
  constructor(cause: unknown, sentIds: number[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.sentIds = sentIds;
    this.answered = cause instanceof TgError;
  }
}

async function sendPostToChat(chat_id: string, html: string, files: MediaRef[]): Promise<number[]> {
  const ids: number[] = [];
  try {
    return await sendPostParts(chat_id, html, files, ids);
  } catch (err) {
    throw new PartialSendError(err, ids);
  }
}

async function sendPostParts(chat_id: string, html: string, files: MediaRef[], ids: number[]): Promise<number[]> {
  const collect = (sent: unknown) => {
    for (const m of Array.isArray(sent) ? sent : [sent]) {
      const id = (m as { message_id?: number })?.message_id;
      if (id) ids.push(id);
    }
  };
  const packed = packCaption(html);
  const parts = packed.leftover ? splitHtml(packed.leftover, 4090) : [];
  if (!files.length) {
    const chunks = splitHtml(html, 4090);
    for (const part of chunks) {
      collect(
        await tg("sendMessage", {
          chat_id,
          text: part,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      );
    }
    return ids;
  }
  for (const [i, chunk] of groupMedia(files).entries()) {
    const firstCaption = i === 0 && packed.caption ? packed.caption : undefined;
    if (chunk.length === 1) {
      const file = chunk[0]!;
      const payload: Record<string, unknown> = {
        chat_id,
        caption: firstCaption,
        parse_mode: firstCaption ? "HTML" : undefined,
      };
      if (file.type === "video") payload.video = file.file_id;
      else if (file.type === "document") payload.document = file.file_id;
      else payload.photo = file.file_id;
      const method =
        file.type === "video" ? "sendVideo" : file.type === "document" ? "sendDocument" : "sendPhoto";
      collect(await tg(method, payload));
    } else {
      collect(
        await tg("sendMediaGroup", {
          chat_id,
          media: chunk.map((file, idx) => ({
            type: file.type,
            media: file.file_id,
            ...(firstCaption && idx === 0 ? { caption: firstCaption, parse_mode: "HTML" } : {}),
          })),
        }),
      );
    }
  }
  for (const part of parts) {
    collect(
      await tg("sendMessage", {
        chat_id,
        text: part,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    );
  }
  return ids;
}

function isMissingRights(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return /not enough rights|need administrator|have no rights|CHAT_WRITE_FORBIDDEN|not allowed to post|CHAT_SEND_\w+_FORBIDDEN/i.test(text);
}

function isChatGone(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return /chat not found|bot was blocked|bot is not a member|kicked|chat was deactivated|group chat was upgraded/i.test(text);
}

function isGroupOrChannel(chat: { id?: number | string; type?: string }) {
  if (chat.type === "private") return false;
  if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") return true;
  const id = Number(chat.id);
  return Number.isFinite(id) && id < 0;
}

function relayDestinations(): { id: string; title?: string; type?: string; status: "pending" | "on" | "off" }[] {
  const skip = new Set(
    [...channelCandidates(), PINNED_ARBITER_CHAT, bindings.arbiterChatId || "", ...OFFICIAL_ARBITER_IDS]
      .filter(Boolean)
      .map((id) => chatIdKey(id)),
  );
  const seen = new Set<string>();
  return (bindings.relayChats || []).filter((chat) => {
    const k = chatIdKey(chat.id);
    if (chat.status !== "on" || !isGroupOrChannel(chat) || skip.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type ChannelPost = { chatId: string; messageIds: number[]; partialError?: string };

async function sendChannelPost(html: string, files: MediaRef[]): Promise<ChannelPost> {
  const ids = channelCandidates();
  if (!ids.length) throw new Error("channel not found");
  let lastError = "channel not found";
  for (const chat_id of ids) {
    try {
      const messageIds = await sendPostToChat(chat_id, html, files);
      return { chatId: chat_id, messageIds };
    } catch (err) {
      // Something already reached the channel: that IS the post. Never retry it
      // elsewhere or again, or the channel would get it twice.
      if (err instanceof PartialSendError && err.sentIds.length) {
        return { chatId: chat_id, messageIds: err.sentIds, partialError: err.message };
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

const RIGHTS_NOTICE_EVERY = 24 * 60 * 60 * 1000;

type BroadcastReport = {
  total: number;
  sent: number;
  noRights: string[];
  gone: string[];
  failed: string[];
  // Delivered, but not as a forward: a copy, or text only where media is forbidden.
  copies?: string[];
  textOnly?: string[];
  // Telegram answered the forward with an error although the post usually arrives
  // ("Message was not forwarded"): nothing more is sent there, just check the chat.
  unconfirmed?: string[];
};

// Telegram refused media (photos/videos) in this chat, not the chat as a whole.
// Permission checks happen before anything is sent, so nothing reached the chat.
function isMediaForbidden(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return /rights to send (photos|videos|documents|media|audios|voice)|CHAT_SEND_(PHOTOS|VIDEOS|MEDIA|DOCS|GIFS)_FORBIDDEN/i.test(text);
}

// Sends to every approved chat. Failures never remove a chat from the list:
// a chat that lost rights starts receiving posts again as soon as rights are back.
type BroadcastJob = {
  id: string;
  key: string;
  html: string;
  files: MediaRef[];
  source?: ChannelPost;
  // Chats already handled (sent or failed): never sent twice, also after a restart.
  done: string[];
  // Chat being sent to right now; saved before sending (see runBroadcast).
  inflight?: string;
  report: BroadcastReport;
  reportTo?: { chatId: number | string; messageId: number };
  startedAt: number;
};

const BROADCAST_PATH = join(DATA_DIR, "telegram-broadcasts.json");
let broadcastJobs: BroadcastJob[] = readJson<BroadcastJob[]>(BROADCAST_PATH) || [];
// Old id -> new id for groups that became supergroups during a broadcast.
const migratedKeys = new Map<string, string>();

function saveBroadcastJobs() {
  try {
    writeJsonAtomic(BROADCAST_PATH, broadcastJobs);
  } catch {
    /* ignore */
  }
}

async function channelAllowsForwarding(chatId: string): Promise<boolean> {
  const chat = await tgSoft<{ has_protected_content?: boolean }>("getChat", { chat_id: chatId });
  return !chat?.has_protected_content;
}

// Remembers which message ids a post got in a relay chat, so the admin panel can
// later delete it everywhere it was sent. Keyed by the complaint (the job key).
function recordRelayDelivery(key: string, chatId: string | number, messageIds: number[]) {
  const ids = messageIds.filter((n) => Number.isFinite(n));
  if (!key || !ids.length) return;
  const rec = pendingPosts[key];
  if (!rec) return;
  const list = (rec.relayDeliveries ||= []);
  const k = chatIdKey(chatId);
  const existing = list.find((d) => chatIdKey(d.chatId) === k);
  if (existing) {
    for (const id of ids) if (!existing.messageIds.includes(id)) existing.messageIds.push(id);
  } else {
    list.push({ chatId: String(chatId), messageIds: [...ids] });
  }
  savePending();
}

// Sends to every approved chat. Failures never remove a chat from the list:
// a chat that lost rights starts receiving posts again as soon as rights are back.
async function runBroadcast(job: BroadcastJob): Promise<BroadcastReport> {
  const report = job.report;
  // The server died while sending to this chat: it may have the post already. Skip it.
  if (job.inflight && !job.done.includes(job.inflight)) {
    (report.unconfirmed ||= []).push(`${job.inflight}: сервер перезапустился во время отправки, повторно не отправляли`);
    report.sent += 1;
    job.done.push(job.inflight);
  }
  job.inflight = undefined;
  const done = new Set(job.done);
  const approved = relayDestinations().filter((c) => !done.has(chatIdKey(c.id)));
  report.total = Math.max(report.total, done.size + approved.length);
  // Relay chats get the channel post itself ("Forwarded from ..."), albums stay albums.
  let forward = Boolean(job.source?.messageIds.length) && (await channelAllowsForwarding(job.source!.chatId));
  if (job.source?.messageIds.length && !forward && !report.failed.some((x) => x.startsWith("пересылка"))) {
    report.failed.push("пересылка из канала запрещена (защита контента), в чаты ушли копии");
  }
  let forwardedOk = 0;
  let emptyInARow = 0;
  for (const chat of approved) {
    // A group may have been reached already under another id (old group -> supergroup).
    if (job.done.includes(chatIdKey(chat.id))) continue;
    const label = chat.title ? `${chat.title} (${chat.id})` : chat.id;
    job.inflight = chatIdKey(chat.id);
    saveBroadcastJobs();
    try {
      let viaForward = false;
      if (forward && job.source) {
        let result: unknown[] | null = null;
        let fwdErr: unknown = null;
        try {
          result = await tg<unknown[]>("forwardMessages", {
            chat_id: chat.id,
            from_chat_id: job.source.chatId,
            message_ids: job.source.messageIds,
          });
        } catch (err) {
          fwdErr = err;
        }
        // Real chats showed it: Telegram may answer a forward with an error (e.g. "Message
        // was not forwarded") and still deliver it. So after a forward attempt a copy is sent
        // ONLY when Telegram refused before sending: missing rights / media not allowed.
        if (!fwdErr && result && result.length >= job.source.messageIds.length) {
          viaForward = true;
          forwardedOk += 1;
          emptyInARow = 0;
          recordRelayDelivery(
            job.key,
            chat.id,
            result.map((m) => (m as { message_id?: number })?.message_id).filter((n): n is number => typeof n === "number"),
          );
        } else if (fwdErr instanceof TgError && /protected|CHAT_FORWARDS_RESTRICTED|message to forward not found|message can't be forwarded/i.test(fwdErr.message)) {
          // The channel post itself can't be forwarded (protected or deleted): copies for everyone.
          forward = false;
          report.failed.push("пересылка из канала невозможна (защита контента или пост удалён), в чаты ушли копии");
        } else if (fwdErr instanceof TgError && (isChatGone(fwdErr) || (isMissingRights(fwdErr) && !isMediaForbidden(fwdErr)))) {
          throw fwdErr;
        } else if (fwdErr instanceof TgError && isMediaForbidden(fwdErr)) {
          // Media not allowed for the bot here: refused up front, a copy below gets the text out.
        } else {
          // Empty or partial result, "Message was not forwarded", no answer at all:
          // the post may be there already. Never send anything more to this chat.
          (report.unconfirmed ||= []).push(
            `${label}: ${fwdErr instanceof Error ? fwdErr.message.replace(/^Bad Request: /, "") : `переслано ${result?.length ?? 0} из ${job.source.messageIds.length}`}`,
          );
          // Counted as handled (no copy below); the chat is still marked done after the try.
          viaForward = true;
          // Empty answers from the very first chats with no forward working at all: the channel
          // post itself is the problem, so the remaining chats get copies.
          if (!fwdErr && result && !result.length && !forwardedOk && ++emptyInARow >= 3) {
            forward = false;
            report.failed.push("пересылка из канала не работает (Telegram пропускает сообщения), остальным чатам ушли копии");
          }
        }
      }
      if (!viaForward) {
        try {
          const ids = await sendPostToChat(chat.id, job.html, job.files);
          recordRelayDelivery(job.key, chat.id, ids);
          if (forward) (report.copies ||= []).push(label);
        } catch (err) {
          // Media forbidden in this chat and nothing sent yet: at least the text goes out.
          // Only when Telegram itself refused (an answer, not a lost connection).
          const refusedCleanly = err instanceof PartialSendError && err.answered && !err.sentIds.length;
          if (!job.files.length || !refusedCleanly || !isMediaForbidden(err)) throw err;
          const ids = await sendPostToChat(chat.id, job.html, []);
          recordRelayDelivery(job.key, chat.id, ids);
          (report.textOnly ||= []).push(label);
        }
      }
      report.sent += 1;
    } catch (err) {
      if (isMissingRights(err)) {
        report.noRights.push(label);
        const relay = findRelay(chat.id);
        if (relay && Date.now() - (relay.rightsNoticeAt || 0) > RIGHTS_NOTICE_EVERY) {
          relay.rightsNoticeAt = Date.now();
          saveBindings();
          await tgSoft("sendMessage", {
            chat_id: chat.id,
            text: "Сообщение для администрации: Вы не выдали достаточно прав для отправки рассылки в Вашем чате.",
          });
        }
      } else if (isChatGone(err)) {
        report.gone.push(label);
      } else {
        const noAnswer = !(err instanceof TgError) && !(err instanceof PartialSendError && err.answered) && !(err instanceof Error && err.message.startsWith("пересланы"));
        report.failed.push(
          noAnswer
            ? `${label}: Telegram не ответил (возможно, пост дошёл); повторно не отправляем, чтобы не было дублей`
            : `${label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Remember the chat right away, under its old and new id if it migrated.
    const k = chatIdKey(chat.id);
    job.done.push(k);
    job.inflight = undefined;
    const moved = migratedKeys.get(k);
    if (moved) job.done.push(moved);
    saveBroadcastJobs();
    // Telegram allows about 30 messages per second in total; an album counts per item.
    await sleep(Math.max(50, 40 * ((forward ? job.source?.messageIds.length : job.files.length) || 1)));
  }
  return report;
}

async function finishBroadcast(job: BroadcastJob) {
  const report = job.report;
  bindings.lastBroadcast = {
    at: Date.now(),
    total: report.total,
    sent: report.sent,
    noRights: report.noRights.length,
    gone: report.gone.length,
    failed: report.failed.length,
  };
  saveBindings();
  broadcastJobs = broadcastJobs.filter((j) => j.id !== job.id);
  saveBroadcastJobs();
  if (!job.reportTo || !report.total) return;
  await tgSoft("sendMessage", {
    chat_id: job.reportTo.chatId,
    text: broadcastReportHtml(report),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: job.reportTo.messageId,
  });
}

// Deletes a batch of the bot's own messages from one chat (<= 100 ids per call).
// Returns how many went and how many Telegram refused (too old, no rights).
async function deleteChatMessages(chatId: string | number, messageIds: number[]): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  const ids = [...new Set(messageIds.filter((n) => Number.isFinite(n)))];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const bulk = await tgSoft("deleteMessages", { chat_id: chatId, message_ids: batch });
    if (bulk) {
      ok += batch.length;
    } else {
      // The bulk call failed (one id too old, mixed rights): try one by one.
      for (const id of batch) {
        const one = await tgSoft("deleteMessage", { chat_id: chatId, message_id: id });
        if (one) ok += 1;
        else fail += 1;
      }
    }
    await sleep(40);
  }
  return { ok, fail };
}

// Deletes a published complaint from the channel and from every relay chat it
// reached, then marks it removed so it leaves the channel view and the search.
async function deletePublishedEverywhere(
  key: string,
): Promise<{ channel: { ok: number; fail: number }; chats: { ok: number; fail: number }; chatCount: number }> {
  const channel = { ok: 0, fail: 0 };
  const chats = { ok: 0, fail: 0 };
  let chatCount = 0;
  const rec = pendingPosts[key];
  if (!rec) return { channel, chats, chatCount };
  if (rec.channelChatId && rec.channelMsgIds?.length) {
    const r = await deleteChatMessages(rec.channelChatId, rec.channelMsgIds);
    channel.ok += r.ok;
    channel.fail += r.fail;
  }
  for (const d of rec.relayDeliveries || []) {
    if (!d.messageIds.length) continue;
    chatCount += 1;
    const r = await deleteChatMessages(d.chatId, d.messageIds);
    chats.ok += r.ok;
    chats.fail += r.fail;
  }
  // Keep the record (status stays "published" so it can never be re-posted), but
  // mark it gone: out of the channel, out of the counterparty search.
  rec.deletedEverywhere = true;
  rec.channelPosted = false;
  rec.removedFromCheck = true;
  rec.relayDeliveries = [];
  rec.channelMsgIds = [];
  savePending();
  return { channel, chats, chatCount };
}

// Jobs run one after another: two publishes in a row must not double the rate.
function enqueueBroadcast(job: BroadcastJob) {
  broadcastQueue = broadcastQueue
    .then(() => runBroadcast(job))
    .then(() => finishBroadcast(job))
    .catch((err) => console.error("[epb] broadcast", err));
}

// After a restart (e.g. a deploy in the middle of a broadcast) the remaining chats still
// get the post; chats already done are skipped.
function resumeBroadcasts() {
  const fresh = broadcastJobs.filter((j) => Date.now() - j.startedAt < 12 * 60 * 60 * 1000);
  if (fresh.length !== broadcastJobs.length) {
    broadcastJobs = fresh;
    saveBroadcastJobs();
  }
  for (const job of fresh) {
    console.log(`[epb] resuming broadcast ${job.key}: ${job.done.length} chats already done`);
    enqueueBroadcast(job);
  }
}

function broadcastReportHtml(report: BroadcastReport): string {
  const list = (items: string[]) =>
    items
      .slice(0, 15)
      .map((x) => `• ${escapeHtml(x)}`)
      .join("\n") + (items.length > 15 ? `\n… и ещё ${items.length - 15}` : "");
  const unsure = report.unconfirmed?.length || 0;
  const lines = [
    `<b>Рассылка завершена</b>: доставлено ${report.sent - unsure} из ${report.total}` +
      (unsure ? `, без подтверждения ${unsure}` : ""),
  ];
  if (report.unconfirmed?.length)
    lines.push(
      "",
      `<b>Telegram ответил ошибкой, но пост обычно доходит — проверьте чат, повторно не отправляли (${report.unconfirmed.length})</b>`,
      list(report.unconfirmed),
    );
  if (report.copies?.length)
    lines.push("", `<b>Пересылка в чат не прошла, отправлено копией (${report.copies.length})</b>`, list(report.copies));
  if (report.textOnly?.length)
    lines.push("", `<b>В чате запрещены фото/видео, отправлен только текст (${report.textOnly.length})</b>`, list(report.textOnly));
  if (report.noRights.length) lines.push("", `<b>Нет прав (${report.noRights.length})</b>`, list(report.noRights));
  if (report.gone.length) lines.push("", `<b>Бот удалён или чат недоступен (${report.gone.length})</b>`, list(report.gone));
  if (report.failed.length) lines.push("", `<b>Ошибки (${report.failed.length})</b>`, list(report.failed));
  return lines.join("\n");
}

// ---------- Editing the post text before it is published ----------

// Telegram message formatting (entities) -> Telegram HTML, so bold/italic/links survive.
function entitiesToHtml(text: string, entities: TgEntity[] = []): string {
  const tags: Record<string, [string, string]> = {
    bold: ["<b>", "</b>"],
    italic: ["<i>", "</i>"],
    underline: ["<u>", "</u>"],
    strikethrough: ["<s>", "</s>"],
    spoiler: ["<tg-spoiler>", "</tg-spoiler>"],
    code: ["<code>", "</code>"],
    pre: ["<pre>", "</pre>"],
    blockquote: ["<blockquote>", "</blockquote>"],
    expandable_blockquote: ["<blockquote expandable>", "</blockquote>"],
  };
  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();
  const usable = entities
    .filter((e) => typeof e.offset === "number" && typeof e.length === "number" && e.length > 0)
    .filter((e) => tags[e.type] || (e.type === "text_link" && /^https?:\/\//i.test(e.url || "")))
    .sort((a, b) => a.offset! - b.offset! || b.length! - a.length!);
  for (const e of usable) {
    const [open, close] =
      e.type === "text_link" ? [`<a href="${escapeHtml(e.url || "")}">`, "</a>"] : tags[e.type]!;
    if (e.offset! >= text.length) continue;
    opens.set(e.offset!, [...(opens.get(e.offset!) || []), open]);
    // Clamp to the text, otherwise a tag would never be closed.
    const end = Math.min(e.offset! + e.length!, text.length);
    closes.set(end, [close, ...(closes.get(end) || [])]);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    out += (closes.get(i) || []).join("");
    out += (opens.get(i) || []).join("");
    if (i < text.length) out += escapeHtml(text[i]!);
  }
  return out;
}

// Prompt message id -> complaint key: the arbiter answers the prompt with the new text.
const postEditPrompts = new Map<string, string>();

function postPreviewHtml(key: string): string {
  const rec = pendingPosts[key]!;
  return channelHtml(pendingAccounts(rec), rec.summary || rec.story, rec.amount, rec.currency, rec.postHtml);
}

async function sendPostPreview(chatId: number | string, key: string, replyTo?: number) {
  const rec = pendingPosts[key];
  if (!rec) return;
  const repeat = previousPosts(pendingAccounts(rec), key);
  const head = `<b>Предпросмотр поста ${escapeHtml(key)}</b>${rec.postHtml ? " (текст изменён)" : ""}` +
    (rec.files?.length ? `\nК посту приложится доказательств: ${rec.files.length}` : "") +
    (repeat ? `\n${repeat}` : "");
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: `${head}\n━━━━━━━━━━\n${postPreviewHtml(key)}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: replyTo,
    reply_markup: publishChoiceKeyboard(key),
  });
}

async function askPostEdit(chatId: number | string, key: string) {
  const rec = pendingPosts[key];
  if (!rec) return;
  const prompt = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: [
      `<b>Новый текст поста ${escapeHtml(key)}</b>`,
      "",
      "Ответьте на это сообщение новым текстом. Можно жирный, курсив и ссылки.",
      "Строки с аккаунтом и суммой и подпись Subscribe бот добавит сам.",
      "",
      "Сейчас в посте:",
      rec.postHtml || escapeHtml((rec.summary || rec.story).trim()),
    ].join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Новый текст поста" },
  });
  if (prompt?.message_id) {
    postEditPrompts.set(`${chatId}:${prompt.message_id}`, key);
    if (postEditPrompts.size > 200) postEditPrompts.delete(postEditPrompts.keys().next().value!);
  }
}

// Returns true when the message was an answer to an edit prompt.
async function handlePostEditReply(msg: TgMessage): Promise<boolean> {
  const replyTo = msg.reply_to_message?.message_id;
  if (!replyTo) return false;
  const key = postEditPrompts.get(`${msg.chat.id}:${replyTo}`);
  if (!key) return false;
  const rec = pendingPosts[key];
  if (!rec || rec.status !== "pending") {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Заявка уже обработана, текст не изменён.", reply_to_message_id: msg.message_id });
    return true;
  }
  const text = (msg.text || msg.caption || "").trim();
  if (text.length < 5) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Слишком коротко. Ответьте на сообщение бота ещё раз.", reply_to_message_id: msg.message_id });
    return true;
  }
  if (text.length > 3500) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Слишком длинно: максимум 3500 символов.", reply_to_message_id: msg.message_id });
    return true;
  }
  const html = entitiesToHtml(msg.text || msg.caption || "", msg.entities || msg.caption_entities).trim();
  const previous = rec.postHtml;
  rec.postHtml = html;
  // The whole post must still fit into one Telegram message.
  if (postPreviewHtml(key).length > 3900) {
    rec.postHtml = previous;
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Пост получается слишком длинным для Telegram. Сократите текст и ответьте ещё раз.", reply_to_message_id: msg.message_id });
    return true;
  }
  savePending();
  postEditPrompts.delete(`${msg.chat.id}:${replyTo}`);
  await sendPostPreview(msg.chat.id, key, msg.message_id);
  return true;
}

const publishing = new Set<string>();
let broadcastQueue: Promise<void> = Promise.resolve();

async function publishFromMessage(
  text: string,
  callbackId: string,
  extraFiles: MediaRef[] = [],
  relay = false,
  keyHint = "",
  reportTo?: { chatId: number | string; messageId: number },
): Promise<boolean> {
  const parsed = parseEpbMarker(text);
  const key = keyHint || parsed?.key || "";
  const stored = key ? pendingPosts[key] : undefined;
  if (!parsed && !stored) {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Не удалось разобрать заявку",
      show_alert: true,
    });
    return false;
  }
  if (stored?.status === "published") {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Уже опубликовано",
    });
    return false;
  }
  if (stored?.status === "rejected") {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Заявка уже отклонена",
      show_alert: true,
    });
    return false;
  }
  // Old review messages may have no key: lock on the text so a double tap can't post twice.
  const lock = key || `txt:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  if (!key && pendingPosts[lock]?.status === "published") {
    await tgSoft("answerCallbackQuery", { callback_query_id: callbackId, text: "Уже опубликовано" });
    return false;
  }
  if (publishing.has(lock)) {
    await tgSoft("answerCallbackQuery", { callback_query_id: callbackId, text: "Уже публикуем" });
    return false;
  }
  publishing.add(lock);
  const html = channelHtml(
    pendingAccounts(stored, parsed?.username || stored?.username || "", parsed?.id || stored?.id || ""),
    stored?.summary || stored?.story || parsed?.story || "",
    stored?.amount,
    stored?.currency,
    stored?.postHtml,
  );
  const files = stored?.files?.length ? stored.files : extraFiles;
  if (!channelCandidates().length) {
    publishing.delete(lock);
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: `Добавьте @${BOT_USERNAME} админом в канал Europe Private Blacklist`,
      show_alert: true,
    });
    return false;
  }
  let channelPost: ChannelPost;
  try {
    channelPost = await sendChannelPost(html, files);
  } catch {
    publishing.delete(lock);
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: relay
        ? "Не удалось опубликовать в канал. Чаты без прав пропускаются."
        : "Не удалось опубликовать. Бот должен быть админом канала.",
      show_alert: true,
    });
    return false;
  }
  if (key && pendingPosts[key]) {
    pendingPosts[key]!.status = "published";
    pendingPosts[key]!.channelPosted = true;
    pendingPosts[key]!.channelChatId = channelPost.chatId;
    pendingPosts[key]!.channelMsgIds = channelPost.messageIds;
  } else {
    // Old message without a stored record: remember it so it can't be posted again.
    pendingPosts[lock] = {
      username: "", id: "", story: "", amount: "", currency: "", files: [],
      createdAt: Date.now(), status: "published", channelPosted: true,
    };
  }
  savePending();
  // The broadcast is saved before anything is sent, so a restart resumes it.
  if (relay) {
    const job: BroadcastJob = {
      id: randomUUID(),
      key: lock,
      html,
      files,
      source: channelPost,
      done: [],
      report: { total: 0, sent: 0, noRights: [], gone: [], failed: [] },
      reportTo,
      startedAt: Date.now(),
    };
    broadcastJobs.push(job);
    saveBroadcastJobs();
    enqueueBroadcast(job);
  }
  publishing.delete(lock);
  if (key && pendingPosts[key]) await notifyApplicant(pendingPosts[key], key, "published");
  await tgSoft("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: channelPost.partialError
      ? "Пост в канале вышел не целиком. Повторно не публикуем — проверьте канал."
      : relay
        ? "Опубликовано в канал, рассылка по чатам идёт"
        : "Опубликовано без рассылки",
    show_alert: Boolean(channelPost.partialError),
  });
  return true;
}

type TgUser = { id: number; username?: string; first_name?: string };
type TgEntity = { type: string; offset?: number; length?: number; url?: string; language?: string; user?: TgUser };

type TgMessage = {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  from?: TgUser;
  photo?: { file_id: string; width?: number; height?: number }[];
  video?: { file_id: string; mime_type?: string; file_size?: number; width?: number; height?: number };
  animation?: { file_id: string; mime_type?: string; file_size?: number; width?: number; height?: number };
  document?: { mime_type?: string; file_id?: string; file_size?: number };
  forward_from?: TgUser;
  forward_origin?: { sender_user?: TgUser };
  reply_to_message?: TgMessage;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  media_group_id?: string;
};

type TgChannelPost = {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  caption?: string;
  date?: number;
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgChannelPost;
  edited_channel_post?: TgChannelPost;
  my_chat_member?: {
    chat: { id: number; type: string; title?: string };
    from?: TgUser;
    new_chat_member: { status: string };
    old_chat_member?: { status: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: TgUser;
    message?: {
      message_id: number;
      chat: { id: number; type: string };
      text?: string;
      caption?: string;
      photo?: { file_id: string }[];
      video?: { file_id: string };
    };
  };
};

type ApplyStep = "scammer" | "victim" | "summary" | "story" | "amount" | "evidence";

type ApplySession = {
  step: ApplyStep;
  accounts: { username: string; id: string }[];
  victimUsername: string;
  victimId: string;
  victimName: string;
  summary: string;
  story: string;
  amount: string;
  currency: Currency;
  evidence: CopiedMedia[];
  touched?: number;
};

const sessions = new Map<string, ApplySession>();
const channelSetup = new Set<string>();
const checkChannelSetup = new Set<string>();
const removeFromCheckSetup = new Set<string>();
const addBlacklistSetup = new Set<string>();
// Arbiter chat -> which relay chat we are setting a sponsor link for.
const sponsorLinkSetup = new Map<string, { relayId: string; filter: string; page: string }>();
// Two-step "add banner" flow in the admin panel: first the media, then the link.
const bannerSetup = new Map<string, { phase: "media" | "link"; draft?: { type: "image" | "video"; file: string; mime: string; width?: number; height?: number } }>();

function gcSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - (session.touched || 0) > 2 * 60 * 60 * 1000) sessions.delete(id);
  }
  if (sessions.size <= 400) return;
  const oldest = [...sessions.entries()].sort((a, b) => (a[1].touched || 0) - (b[1].touched || 0));
  for (const [id] of oldest.slice(0, sessions.size - 400)) sessions.delete(id);
}

function commandName(text?: string): string | null {
  if (!text?.startsWith("/")) return null;
  const token = text.split(/\s+/)[0] ?? "";
  return token.slice(1).split("@")[0]?.toLowerCase() || null;
}

function applyKeyboard(locale: Locale) {
  const url = publicMiniAppUrl();
  const rows: Record<string, unknown>[][] = [];
  if (url) {
    rows.push([{ text: tb(locale, "openApp"), web_app: { url } }]);
  }
  rows.push([{ text: tb(locale, "applyBtn"), callback_data: "apply" }]);
  rows.push([
    { text: tb(locale, "channel"), url: CHANNEL_URL },
    { text: tb(locale, "ownersBtn"), callback_data: "owners" },
  ]);
  rows.push([{ text: tb(locale, "langBtn"), callback_data: "lang" }]);
  return { inline_keyboard: rows };
}

// Cancel row shown on every step of the in-bot complaint flow.
function applyCancelRow(chatId: number | string) {
  return [{ text: btUser(chatId, "cancelBtn"), callback_data: "apply:cancel" }];
}

function startText(locale: Locale) {
  return tb(locale, "start");
}

function ownersText(locale: Locale) {
  return tb(locale, "owners", { bot: BOT_USERNAME });
}

function ownersKeyboard(locale: Locale) {
  return {
    inline_keyboard: [
      [{ text: tb(locale, "channel"), url: CHANNEL_URL }],
      [{ text: tb(locale, "back"), callback_data: "home" }],
    ],
  };
}

function langKeyboard(withBack = false) {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: "Русский", callback_data: "lang:ru" },
      { text: "English", callback_data: "lang:en" },
    ],
  ];
  if (withBack) rows.push([{ text: "Назад / Back", callback_data: "home" }]);
  return { inline_keyboard: rows };
}

async function askLanguage(chatId: number | string, withBack = false) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: "Выберите язык / Choose language",
    reply_markup: langKeyboard(withBack),
  });
}

type CardKind = "welcome" | "submitted" | "published";

function cardPath(kind: CardKind): string | null {
  const name = `${kind}.jpg`;
  const candidates = [
    join(process.cwd(), "public/bot", name),
    join(process.cwd(), ".output/public/bot", name),
    join(process.cwd(), "public", name),
    join("/workspace/public/bot", name),
    join("/workspace/.output/public/bot", name),
  ];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.unshift(join(here, "../public/bot", name), join(here, "../../public/bot", name));
  } catch {
    /* ignore */
  }
  return candidates.find((p) => existsSync(p)) || null;
}

function cardBytes(kind: CardKind): Buffer | null {
  if (kind === "welcome") {
    try {
      return Buffer.from(WELCOME_JPEG_BASE64, "base64");
    } catch {
      /* fall through */
    }
  }
  const path = cardPath(kind);
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

async function sendCard(
  chatId: string | number,
  kind: CardKind,
  caption: string,
  extra: Record<string, unknown> = {},
) {
  const cached = bindings.cards?.[kind];
  if (cached) {
    const sent = await tgSoft("sendPhoto", {
      chat_id: chatId,
      photo: cached,
      caption,
      parse_mode: "HTML",
      ...extra,
    });
    if (sent) return;
    if (bindings.cards) delete bindings.cards[kind];
    saveBindings();
  }
  const bytes = cardBytes(kind);
  if (bytes?.length) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    if (extra.reply_markup) form.set("reply_markup", JSON.stringify(extra.reply_markup));
    form.set("photo", new File([new Uint8Array(bytes)], `${kind}.jpg`, { type: "image/jpeg" }));
    try {
      const sent = await tgForm<{ photo?: { file_id: string }[] }>("sendPhoto", form);
      const fileId = sent.photo?.at(-1)?.file_id;
      if (fileId) {
        bindings.cards = { ...bindings.cards, [kind]: fileId };
        saveBindings();
      }
      return;
    } catch {
      /* fall through to text */
    }
  }
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function replyStart(chatId: number, userId?: string | number) {
  const locale = langOf(userId ?? chatId);
  let text = startText(locale);
  try {
    const st = await sponsorStats();
    if (st.chats > 0) {
      const audience = st.audience.toLocaleString(locale === "en" ? "en-US" : "ru-RU");
      text += `\n\n${tb(locale, "statsLine", { chats: String(st.chats), audience })}`;
    }
  } catch {
    /* stats are optional */
  }
  await sendCard(chatId, "welcome", text, { reply_markup: applyKeyboard(locale) });
}

function newSession(from: TgUser): ApplySession {
  return {
    step: "scammer",
    accounts: [],
    victimUsername: from.username || "",
    victimId: String(from.id),
    victimName: from.first_name || "",
    summary: "",
    story: "",
    amount: "",
    currency: "USD",
    evidence: [],
    touched: Date.now(),
  };
}

function parseAmount(text: string): { amount: string; currency: Currency | null } | null {
  return parseDamageAmount(text);
}

function formatAmount(amount: string) {
  const [intPart, frac] = amount.split(".");
  const grouped = (intPart || "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac ? `${grouped}.${frac}` : grouped;
}

function hasMedia(msg: TgMessage) {
  return Boolean(msg.photo?.length || msg.video || msg.document);
}

function formatSessionAccounts(session: ApplySession, userId: string | number) {
  if (!session.accounts.length) return btUser(userId, "emptyAccounts");
  return session.accounts
    .map((a, i) => `${i + 1}. ${a.username ? `@${a.username.replace(/^@/, "")} · ` : ""}${a.id}`)
    .join("\n");
}

async function askScammer(chatId: number, session?: ApplySession) {
  const listed = session ? formatSessionAccounts(session, chatId) : "";
  const rows: { text: string; callback_data: string }[][] = [];
  if (session?.accounts.length) {
    rows.push([
      { text: btUser(chatId, "moreAccount"), callback_data: "apply:more" },
      { text: btUser(chatId, "next"), callback_data: "apply:next" },
    ]);
  }
  rows.push(applyCancelRow(chatId));
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: session?.accounts.length
      ? btUser(chatId, "accountsListed", { list: listed })
      : btUser(chatId, "stepAccounts"),
    reply_markup: { inline_keyboard: rows },
  });
}

async function askVictim(chatId: number, session: ApplySession) {
  const current = session.victimUsername
    ? `@${session.victimUsername} · id ${session.victimId}`
    : `id ${session.victimId} (username нет)`;
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: `📇 Контакт для связи\nАрбитрам, если понадобится уточнить.\nСейчас: ${current}\nНапишите другой @username или нажмите «Оставить».`,
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Оставить", callback_data: "apply:keep" }], applyCancelRow(chatId)],
    },
  });
}

async function askSummary(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "stepSummary"),
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askStory(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "stepStory"),
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askAmount(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "stepAmount"),
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askCurrency(chatId: number, amount: string) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "pickCurrency", { amount: formatAmount(amount) }),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💵 USD", callback_data: "apply:cur:USD" },
          { text: "💶 EUR", callback_data: "apply:cur:EUR" },
        ],
        applyCancelRow(chatId),
      ],
    },
  });
}

async function askEvidence(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "stepEvidence"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: btUser(chatId, "done"), callback_data: "apply:done" },
          { text: btUser(chatId, "skipFiles"), callback_data: "apply:skip" },
        ],
        applyCancelRow(chatId),
      ],
    },
  });
}

async function askConfirm(chatId: number, session: ApplySession) {
  const victim = session.victimUsername ? `@${session.victimUsername}` : session.victimName || session.victimId;
  const files = session.evidence.length
    ? btUser(chatId, "filesCount", { n: session.evidence.length })
    : btUser(chatId, "noFiles");
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(chatId, "confirm", {
      accounts: formatSessionAccounts(session, chatId),
      victim,
      id: session.victimId,
      amount: session.amount,
      currency: session.currency,
      files,
      summary: session.summary,
      story: session.story,
    }),
    reply_markup: {
      inline_keyboard: [
        [
          { text: btUser(chatId, "sendReview"), callback_data: "apply:send" },
          { text: btUser(chatId, "cancelBtn"), callback_data: "apply:cancel" },
        ],
      ],
    },
  });
}

async function startApply(chatId: number, from: TgUser) {
  const session = newSession(from);
  sessions.set(String(from.id), session);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(from.id, "applyStart"),
  });
  await askScammer(chatId, session);
}

async function cancelApply(chatId: number, userId: string, notice?: string) {
  sessions.delete(userId);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: notice || btUser(userId, "cancel"),
    reply_markup: applyKeyboard(langOf(userId)),
  });
}

async function copyEvidenceToArbiters(items: ApplySession["evidence"]) {
  const chatId = bindings.arbiterChatId;
  if (!chatId || !items.length) return;
  for (const item of items) {
    await tgSoft("copyMessage", {
      chat_id: chatId,
      from_chat_id: item.chatId,
      message_id: item.messageId,
    });
  }
}

async function submitSession(chatId: number, userId: string, session: ApplySession) {
  const accounts = session.accounts.filter((a) => a.id);
  if (!accounts.length) {
    await tgSoft("sendMessage", { chat_id: chatId, text: btUser(userId, "needAccountSubmit") });
    session.step = "scammer";
    sessions.set(userId, session);
    await askScammer(chatId, session);
    return;
  }
  if (!session.summary.trim() || session.summary.trim().length < 10) {
    await tgSoft("sendMessage", { chat_id: chatId, text: btUser(userId, "needSummary") });
    session.step = "summary";
    sessions.set(userId, session);
    await askSummary(chatId);
    return;
  }
  if (!session.story.trim() || session.story.trim().length < 20) {
    await tgSoft("sendMessage", { chat_id: chatId, text: btUser(userId, "needStory") });
    session.step = "story";
    sessions.set(userId, session);
    await askStory(chatId);
    return;
  }
  const first = accounts[0]!;
  const app: Application = {
    id: `EPB-${Date.now().toString(36).toUpperCase()}`,
    createdAt: Date.now(),
    status: "pending",
    victim: {
      username: session.victimUsername,
      telegramId: session.victimId,
      firstName: session.victimName,
    },
    scammer: {
      username: first.username,
      telegramId: first.id,
    },
    scammers: accounts.map((a) => ({ username: a.username, telegramId: a.id })),
    summary: session.summary,
    story: session.story,
    damageAmount: session.amount,
    damageCurrency: session.currency,
    evidence: [],
  };
  const result = await sendApplicationToArbiters(app, session.evidence);
  if (!result.ok) {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: result.error || btUser(userId, "sendFail"),
    });
    return;
  }
  sessions.delete(userId);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: btUser(userId, "sent", { id: app.id }),
  });
}

function forwardedUser(msg: TgMessage): TgUser | undefined {
  return msg.forward_from || msg.forward_origin?.sender_user;
}

async function handleApplyMessage(msg: TgMessage, session: ApplySession) {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || chatId);

  if (session.step === "scammer") {
    let username = "";
    let id = "";
    const fwd = forwardedUser(msg);
    const mention = msg.entities?.find((e) => e.type === "text_mention" && e.user?.id)?.user;
    if (fwd) {
      rememberUser(fwd);
      id = String(fwd.id);
      username = fwd.username || "";
    } else if (mention) {
      rememberUser(mention);
      id = String(mention.id);
      username = mention.username || "";
    } else {
      const raw = (msg.text || "").trim();
      if (!raw) {
        await askScammer(chatId, session);
        return;
      }
      const low = raw.toLowerCase();
      if (low === "далее" || low === "готово" || low === "next") {
        if (!session.accounts.length) {
          await tgSoft("sendMessage", {
            chat_id: chatId,
            text: btUser(userId, "addAccountLeast"),
          });
          return;
        }
        session.step = "summary";
        sessions.set(userId, session);
        await askSummary(chatId);
        return;
      }
      const resolved = await resolveHandleServer(raw, userId);
      if (!resolved) {
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: btUser(userId, "parseAccount"),
        });
        return;
      }
      username = resolved.username;
      id = resolved.id;
      if (!id) {
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: btUser(userId, "idNoNumeric", { user: resolved.username }),
        });
        return;
      }
    }
    if (!id) {
      await askScammer(chatId, session);
      return;
    }
    if (!session.accounts.some((a) => a.id === id)) {
      session.accounts.push({ username, id });
    }
    sessions.set(userId, session);
    await askScammer(chatId, session);
    return;
  }

  if (session.step === "victim") {
    session.step = "summary";
    sessions.set(userId, session);
    await askSummary(chatId);
    return;
  }

  if (session.step === "summary") {
    const summary = (msg.text || msg.caption || "").trim();
    if (summary.length < 10) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "needSummary"),
      });
      return;
    }
    if (summary.length > 800) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "summaryLong"),
      });
      return;
    }
    session.summary = summary;
    session.step = "story";
    sessions.set(userId, session);
    await askStory(chatId);
    return;
  }

  if (session.step === "story") {
    const story = (msg.text || msg.caption || "").trim();
    if (story.length < 20) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "needStory"),
      });
      return;
    }
    if (story.length > 5000) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "storyLong"),
      });
      return;
    }
    session.story = story;
    session.step = "amount";
    await askAmount(chatId);
    return;
  }

  if (session.step === "amount") {
    const parsed = parseAmount(msg.text || "");
    if (!parsed) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "needAmount"),
      });
      return;
    }
    session.amount = parsed.amount;
    if (!parsed.currency) {
      sessions.set(userId, session);
      await askCurrency(chatId, parsed.amount);
      return;
    }
    session.currency = parsed.currency;
    session.step = "evidence";
    await askEvidence(chatId);
    return;
  }

  if (session.step === "evidence") {
    if (hasMedia(msg)) {
      const fileId = msg.video?.file_id || msg.photo?.at(-1)?.file_id || msg.document?.file_id;
      const kind = msg.video ? "video" : msg.photo?.length ? "photo" : "document";
      session.evidence.push({
        chatId: msg.chat.id,
        messageId: msg.message_id,
        fileId,
        kind,
      });
      if (session.evidence.length >= 30) {
        await askConfirm(chatId, session);
        return;
      }
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: btUser(userId, "fileAccepted", { n: session.evidence.length }),
        reply_markup: {
          inline_keyboard: [[{ text: btUser(userId, "done"), callback_data: "apply:done" }]],
        },
      });
      return;
    }
    const text = (msg.text || "").trim().toLowerCase();
    if (text === "готово" || text === "done") {
      await askConfirm(chatId, session);
      return;
    }
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: btUser(userId, "sendMedia"),
    });
  }

  sessions.set(userId, session);
}

async function handleApplyCallback(
  cb: NonNullable<TgUpdate["callback_query"]>,
  session: ApplySession | undefined,
) {
  const chatId = cb.message?.chat.id;
  const userId = String(cb.from?.id || "");
  if (!chatId) return;

  if (cb.data === "apply:cancel") {
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
    await cancelApply(chatId, userId);
    return;
  }

  if (!session) {
    if (cb.data === "apply") {
      if (!cb.from) return;
      if (cb.message?.chat.type && cb.message.chat.type !== "private") {
        await tgSoft("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: btUser(cb.from?.id, "applyInDm"),
          show_alert: true,
        });
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: btUser(cb.from?.id, "applyOpen", { bot: BOT_USERNAME }),
        });
        return;
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await startApply(chatId, cb.from);
      return;
    }
    await tgSoft("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: btUser(cb.from?.id, "restart"),
    });
    return;
  }

  void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });

  if (cb.data === "apply:cur:USD" || cb.data === "apply:cur:EUR") {
    if (!session.amount) {
      await askAmount(chatId);
      return;
    }
    session.currency = cb.data.endsWith("USD") ? "USD" : "EUR";
    session.step = "evidence";
    sessions.set(userId, session);
    await askEvidence(chatId);
    return;
  }
  if (cb.data === "apply:keep") {
    session.step = "summary";
    sessions.set(userId, session);
    await askSummary(chatId);
    return;
  }
  if (cb.data === "apply:next") {
    if (!session.accounts.length) {
      await tgSoft("sendMessage", { chat_id: chatId, text: btUser(userId, "addAccountFirst") });
      return;
    }
    session.step = "summary";
    sessions.set(userId, session);
    await askSummary(chatId);
    return;
  }
  if (cb.data === "apply:more") {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: btUser(userId, "nextAccount"),
    });
    return;
  }
  if (cb.data === "apply:done" || cb.data === "apply:skip") {
    await askConfirm(chatId, session);
    return;
  }
  if (cb.data === "apply:send") {
    await submitSession(chatId, userId, session);
  }
}

function findRelay(id: string | number) {
  return (bindings.relayChats || []).find((c) => sameChat(c.id, id));
}

function upsertRelay(
  chat: { id: number | string; type?: string; title?: string },
  status: "pending" | "on" | "off",
) {
  const list = [...(bindings.relayChats || [])];
  const idx = list.findIndex((c) => sameChat(c.id, chat.id));
  const next: RelayChat = {
    id: String(chat.id),
    title: chat.title || list[idx]?.title,
    type: chat.type || list[idx]?.type,
    status,
  };
  if (status === "pending") next.requestedAt = Date.now();
  if (idx >= 0) list[idx] = { ...list[idx], ...next };
  else list.push(next);
  bindings.relayChats = pruneRelays(list);
  saveBindings();
}

// The old code kept only the last 250 chats and silently dropped the oldest
// active ones. Active chats are never pruned now; only stale pending/off entries.
function pruneRelays(list: RelayChat[]): RelayChat[] {
  const LIMIT = 5000;
  if (list.length <= LIMIT) return list;
  const removable = list
    .filter((c) => c.status !== "on")
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0))
    .slice(0, list.length - LIMIT);
  const drop = new Set(removable.map((c) => chatIdKey(c.id)));
  return list.filter((c) => !drop.has(chatIdKey(c.id)));
}

// A group upgraded to a supergroup gets a new id; keep its relay status and roles.
function onChatMigrated(oldId: string, newId: string) {
  if (!oldId || !newId || sameChat(oldId, newId)) return;
  migratedKeys.set(chatIdKey(oldId), chatIdKey(newId));
  let changed = false;
  const list = bindings.relayChats || [];
  const old = list.find((c) => sameChat(c.id, oldId));
  if (old) {
    const twin = list.find((c) => sameChat(c.id, newId));
    if (twin) {
      if (old.status === "on") twin.status = "on";
      bindings.relayChats = list.filter((c) => c !== old);
    } else {
      old.id = newId;
      old.type = "supergroup";
    }
    changed = true;
  }
  if (bindings.channelId && sameChat(bindings.channelId, oldId)) {
    bindings.channelId = newId;
    changed = true;
  }
  if (changed) {
    saveBindings();
    console.log(`[epb] chat ${oldId} migrated to ${newId}`);
  }
}

function dropRelay(id: string | number) {
  bindings.relayChats = (bindings.relayChats || []).filter((c) => !sameChat(c.id, id));
  saveBindings();
}

function chatKindLabel(type?: string) {
  if (type === "channel") return "канал";
  if (type === "supergroup") return "супергруппа";
  if (type === "group") return "группа";
  return type || "чат";
}

async function greetRelayChat(chat: { id: number; type: string; title?: string }) {
  await tgSoft("sendMessage", {
    chat_id: chat.id,
    text: [
      `<b>${CHANNEL_NAME}</b>`,
      "",
      "Выдайте боту права администратора: отправка сообщений и медиа. Без этого рассылка не заработает.",
    ].join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function notifyArbitersAboutRelay(
  chat: { id: number; type: string; title?: string },
  addedBy?: { id: number; username?: string; first_name?: string },
) {
  const arbiter = arbiterCandidates()[0] || REQUESTED_ARBITER;
  const who = addedBy?.username
    ? `@${addedBy.username}`
    : addedBy?.first_name
      ? `${escapeHtml(addedBy.first_name)} (<code>${addedBy.id}</code>)`
      : "неизвестно";
  await tgSoft("sendMessage", {
    chat_id: arbiter,
    text: [
      "<b>Бот добавлен в чужой чат</b>",
      "",
      `Название: ${escapeHtml(chat.title || "без названия")}`,
      `Тип: ${chatKindLabel(chat.type)}`,
      `ID: <code>${chat.id}</code>`,
      `Кто добавил: ${who}`,
      "",
      "Подключить рассылку одобренных постов в этот чат?",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Принять", callback_data: `rel:y:${chat.id}` },
          { text: "Отклонить", callback_data: `rel:n:${chat.id}` },
        ],
      ],
    },
  });
}

async function replaceReplyMarkup(
  msg: {
    chat: { id: number };
    message_id: number;
    text?: string;
    caption?: string;
    photo?: unknown;
    video?: unknown;
  },
  markup: unknown,
  nextText?: string,
) {
  const text = nextText ?? msg.caption ?? msg.text ?? "";
  const isMedia = Boolean(msg.caption || msg.photo || msg.video);
  if (nextText) {
    if (isMedia) {
      const edited = await tgSoft("editMessageCaption", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
        reply_markup: markup,
      });
      if (edited) return true;
    } else {
      const edited = await tgSoft("editMessageText", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: markup,
      });
      if (edited) return true;
    }
  }
  const markupOnly = await tgSoft("editMessageReplyMarkup", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_markup: markup,
  });
  return Boolean(markupOnly);
}

function callbackKey(data: string) {
  const i = data.indexOf(":");
  return i >= 0 ? data.slice(i + 1) : "";
}

async function handleRelayDecision(cb: NonNullable<TgUpdate["callback_query"]>, allow: boolean) {
  const raw = (cb.data || "").replace(/^rel:[yn]:/, "");
  if (!raw) return;
  const chatId = raw;
  const relay = findRelay(chatId);
  const title = relay?.title || chatId;
  if (allow) {
    upsertRelay({ id: chatId, title: relay?.title, type: relay?.type }, "on");
    const wrote = await tgSoft("sendMessage", {
      chat_id: chatId,
      text: `Рассылка ${CHANNEL_NAME} включена. Сюда будут приходить одобренные посты.`,
    });
    await tgSoft("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: wrote ? "Рассылка включена" : "Включили, но бот не смог написать в чат. Проверьте права.",
      show_alert: !wrote,
    });
  } else {
    upsertRelay({ id: chatId, title: relay?.title, type: relay?.type }, "off");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Арбитры не подключили рассылку в этот чат. Одобренные посты сюда не приходят.",
    });
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Отклонено" });
  }
  const next = allow
    ? `Принято: ${escapeHtml(title)}\nID: <code>${escapeHtml(chatId)}</code>\nРассылка включена.`
    : `Отклонено: ${escapeHtml(title)}\nID: <code>${escapeHtml(chatId)}</code>\nРассылка выключена.`;
  if (cb.message) {
    await tgSoft("editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: next,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  }
}

async function bindChat(
  chat: { id: number; type: string; title?: string },
  from?: { id: number; username?: string; first_name?: string },
  justAdded = true,
) {
  if (!isGroupOrChannel(chat)) return;
  const id = String(chat.id);
  if (isOfficialArbiterChat(id)) {
    bindings.arbiterChatId = id;
    saveBindings();
    await tgSoft("sendMessage", {
      chat_id: id,
      text: [
        `${CHANNEL_NAME}: чат арбитров подтверждён.`,
        `ID: <code>${id}</code>`,
        "",
        "Сюда будут приходить заявки с кнопками Опубликовать / Отклонить.",
        "",
        "Канал для постов сейчас: <code>" + (bindings.channelId || PINNED_CHANNEL) + "</code>",
        "Сменить: /channel -100…",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }
  if (isOfficialChannel(id)) {
    bindings.channelId = id;
    saveBindings();
    const arbiter = arbiterCandidates()[0] || REQUESTED_ARBITER;
    await tgSoft("sendMessage", {
      chat_id: arbiter,
      text: `Канал подключён: ${escapeHtml(chat.title ?? id)}\nID: <code>${id}</code>`,
      parse_mode: "HTML",
    });
    return;
  }
  const existing = findRelay(id);
  if (existing?.status === "on") {
    // Only a rights change (member <-> admin): stay quiet, the chat keeps its broadcast.
    if (!justAdded) return;
    await tgSoft("sendMessage", {
      chat_id: chat.id,
      text: "Рассылка уже включена. Одобренные посты будут приходить сюда.",
    });
    return;
  }
  if (existing?.status === "pending" && Date.now() - (existing.requestedAt || 0) < 24 * 60 * 60 * 1000) return;
  if (existing?.status === "off" && !justAdded) return;
  if (tooMany("relay:global", 8, 60_000)) return;
  if (from?.id && tooMany(`relay:${from.id}`, 3, 60 * 60 * 1000)) return;
  upsertRelay(chat, "pending");
  await greetRelayChat(chat);
  await notifyArbitersAboutRelay(chat, from);
}

// ---------- Bot users and broadcasts to them (private chats only) ----------

type BotUser = { first: number; last: number; blocked?: boolean };
const USERS_PATH = join(DATA_DIR, "telegram-users.json");
const botUsers: Record<string, BotUser> = readJson<Record<string, BotUser>>(USERS_PATH) || {};

// Private chat ids are positive; groups and channels are negative. Only these ever
// get a user broadcast.
const isUserId = (id: string | number | undefined) => /^[1-9]\d{0,15}$/.test(String(id ?? ""));

// First run: people who already used the bot before the counter existed.
if (!existsSync(USERS_PATH)) {
  const seed = new Set<string>([...Object.keys(userLocales), ...Object.values(pendingPosts).map((r) => r.victimId || "")]);
  for (const id of seed) if (isUserId(id)) botUsers[id] = { first: Date.now(), last: 0 };
  try {
    writeJsonAtomic(USERS_PATH, botUsers);
  } catch {
    /* ignore */
  }
}

let usersTimer: ReturnType<typeof setTimeout> | null = null;
function saveUsers() {
  if (usersTimer) return;
  usersTimer = setTimeout(() => {
    usersTimer = null;
    try {
      writeJsonAtomic(USERS_PATH, botUsers);
    } catch {
      /* ignore */
    }
  }, 3000);
}

function touchUser(id: string | number | undefined, blocked?: boolean) {
  if (!isUserId(id)) return;
  const key = String(id);
  const now = Date.now();
  const user = botUsers[key] || { first: now, last: now };
  user.last = now;
  if (blocked !== undefined) user.blocked = blocked;
  else if (user.blocked) user.blocked = false; // wrote to the bot again: reachable
  botUsers[key] = user;
  saveUsers();
}

function userStats() {
  const all = Object.values(botUsers);
  const blocked = all.filter((u) => u.blocked).length;
  return { total: all.length, active: all.length - blocked, blocked };
}

type DmDraft = {
  id: string;
  srcChat: string;
  srcIds: number[];
  buttons: { text: string; url: string }[][];
};
type DmJob = DmDraft & {
  recipients: string[];
  sent: number;
  blocked: number;
  failed: number;
  startedAt: number;
  stopped?: boolean;
  statusChat: string;
  statusMessage?: number;
};

const DM_JOBS_PATH = join(DATA_DIR, "telegram-dm-broadcasts.json");
const dmDonePath = (id: string) => join(DATA_DIR, `dm-done-${id.replace(/[^a-z0-9-]/gi, "")}.log`);
let dmJobs: DmJob[] = readJson<DmJob[]>(DM_JOBS_PATH) || [];
let dmDraft: DmDraft | null = null;
// prompt message key -> what the reply means
const dmPrompts = new Map<string, "content" | "buttons">();
const dmAlbums = new Map<string, { chat: string; ids: number[]; timer: ReturnType<typeof setTimeout> }>();
let dmQueue: Promise<void> = Promise.resolve();
const dmStarting = new Set<string>();

function saveDmJobs() {
  try {
    writeJsonAtomic(DM_JOBS_PATH, dmJobs);
  } catch {
    /* ignore */
  }
}

// Lines "?id" are written BEFORE sending and "id" after. After a crash an id with only
// the "?" line may or may not have received it: it counts as done, so nobody gets it twice.
function readDone(id: string): Set<string> {
  try {
    return new Set(
      readFileSync(dmDonePath(id), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^\?/, "")),
    );
  } catch {
    return new Set();
  }
}

function dmMarkup(draft: DmDraft) {
  return draft.buttons.length ? { inline_keyboard: draft.buttons } : undefined;
}

// One recipient: the admin's message is copied, so text, formatting, premium emoji,
// photos, videos, GIFs and albums arrive exactly as written.
async function sendDmCopy(chatId: string, draft: DmDraft) {
  if (draft.srcIds.length > 1) {
    const res = await tg<unknown[]>("copyMessages", { chat_id: chatId, from_chat_id: draft.srcChat, message_ids: draft.srcIds });
    if (!res?.length) throw new Error("сообщение не скопировалось");
    return;
  }
  await tg("copyMessage", {
    chat_id: chatId,
    from_chat_id: draft.srcChat,
    message_id: draft.srcIds[0],
    reply_markup: dmMarkup(draft),
  });
}

function parseDmButtons(text: string): { text: string; url: string }[][] | string {
  const rows: { text: string; url: string }[][] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const row: { text: string; url: string }[] = [];
    for (const part of line.split("|").map((p) => p.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)\s+[-–—]\s+(\S+)$/);
      if (!m) return `Не понял строку: «${part}». Формат: Текст - https://ссылка`;
      const url = m[2]!;
      if (!/^(https?:\/\/|tg:\/\/)\S+$/i.test(url)) return `Ссылка должна начинаться с https:// или tg:// — «${url}»`;
      row.push({ text: m[1]!.slice(0, 64), url });
    }
    if (row.length > 8) return "В одном ряду максимум 8 кнопок";
    if (row.length) rows.push(row);
  }
  if (!rows.length) return "Не нашёл ни одной кнопки";
  if (rows.length > 10) return "Максимум 10 рядов кнопок";
  return rows;
}

function dmScreen(): AdminView {
  const st = userStats();
  const running = dmJobs.find((j) => !j.stopped);
  const lines = [
    "<b>Пользователи бота</b>",
    `Всего: ${st.total}`,
    `Получат рассылку: ${st.active}`,
    `Заблокировали бота: ${st.blocked}`,
    "",
    "Рассылка уходит только в личные сообщения пользователям бота. В чаты и каналы она не отправляется.",
  ];
  const keyboard: AdminView["keyboard"] = [];
  if (running) {
    const done = readDone(running.id).size;
    lines.push("", `<b>Идёт рассылка</b>: ${done} из ${running.recipients.length}`);
    keyboard.push([{ text: "⏹ Остановить рассылку", callback_data: `adm:ubstop:${running.id}` }]);
    keyboard.push([{ text: "🔄 Обновить", callback_data: "adm:ub" }]);
  } else {
    keyboard.push([{ text: "✉ Новая рассылка", callback_data: "adm:ubnew" }]);
  }
  keyboard.push([{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return { text: lines.join("\n"), keyboard };
}

async function askDmContent(chatId: number | string) {
  const prompt = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: [
      "<b>Новая рассылка пользователям бота</b>",
      "",
      "Ответьте на это сообщение тем, что нужно разослать: текст, фото, видео, GIF, стикер или альбом, с подписью и форматированием.",
      "Премиум-эмодзи сохранятся, если у владельца бота есть Telegram Premium.",
      "",
      "Не удаляйте своё сообщение, пока рассылка не закончится: бот копирует именно его.",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Сообщение для рассылки" },
  });
  if (prompt?.message_id) dmPrompts.set(`${chatId}:${prompt.message_id}`, "content");
}

async function askDmButtons(chatId: number | string) {
  const prompt = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: [
      "<b>Кнопки под рассылкой</b>",
      "",
      "Ответьте на это сообщение. Каждая строка — ряд кнопок, кнопки в ряду через «|»:",
      "<code>Наш канал - https://t.me/+KkrYz9IKvoBmYTQy</code>",
      "<code>Сайт - https://example.com | Бот - https://t.me/EuropeBlack_bot</code>",
    ].join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Текст - https://ссылка" },
  });
  if (prompt?.message_id) dmPrompts.set(`${chatId}:${prompt.message_id}`, "buttons");
}

// Exactly what users will get, then the controls.
async function sendDmPreview(chatId: number | string) {
  const draft = dmDraft;
  if (!draft) return;
  const st = userStats();
  let previewOk = true;
  try {
    await sendDmCopy(String(chatId), draft);
  } catch (err) {
    previewOk = false;
    await tgSoft("sendMessage", { chat_id: chatId, text: `Не удалось показать предпросмотр: ${(err as Error).message}` });
  }
  const album = draft.srcIds.length > 1;
  const keyboard: AdminView["keyboard"] = [];
  if (!album) {
    keyboard.push([{ text: draft.buttons.length ? "✏ Изменить кнопки" : "➕ Добавить кнопки", callback_data: "adm:ubbtn" }]);
    if (draft.buttons.length) keyboard.push([{ text: "🗑 Убрать кнопки", callback_data: "adm:ubclr" }]);
  }
  if (previewOk) keyboard.push([{ text: `🚀 Разослать (${st.active})`, callback_data: `adm:ubgo:${draft.id}` }]);
  keyboard.push([{ text: "✖ Отменить", callback_data: "adm:ubcancel" }]);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: [
      "<b>Предпросмотр рассылки — выше</b>",
      `Получат: ${st.active} пользователей бота (только личные сообщения, не чаты и не каналы).`,
      album ? "Это альбом: Telegram не позволяет добавить к альбому кнопки." : "",
    ]
      .filter(Boolean)
      .join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// Replies in the arbiter chat to the bot's broadcast prompts. True when handled.
async function handleDmReply(msg: TgMessage): Promise<boolean> {
  const replyTo = msg.reply_to_message?.message_id;
  if (!replyTo) return false;
  const kind = dmPrompts.get(`${msg.chat.id}:${replyTo}`);
  if (!kind) return false;
  if (kind === "buttons") {
    if (!dmDraft) {
      await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Черновик рассылки не найден. Начните заново: /admin" });
      return true;
    }
    const parsed = parseDmButtons(msg.text || "");
    if (typeof parsed === "string") {
      await tgSoft("sendMessage", { chat_id: msg.chat.id, text: `${parsed}\nОтветьте на сообщение с инструкцией ещё раз.`, reply_to_message_id: msg.message_id });
      return true;
    }
    dmPrompts.delete(`${msg.chat.id}:${replyTo}`);
    dmDraft.buttons = parsed;
    await sendDmPreview(msg.chat.id);
    return true;
  }
  // Content. Albums arrive as several messages: collect them for a moment.
  if (msg.media_group_id) {
    const albumKey = `${msg.chat.id}:${msg.media_group_id}`;
    const album = dmAlbums.get(albumKey);
    if (album) {
      album.ids.push(msg.message_id);
      return true;
    }
    const timer = setTimeout(async () => {
      const done = dmAlbums.get(albumKey);
      dmAlbums.delete(albumKey);
      if (!done) return;
      dmPrompts.delete(`${msg.chat.id}:${replyTo}`);
      dmDraft = { id: randomUUID(), srcChat: done.chat, srcIds: [...done.ids].sort((a, b) => a - b), buttons: [] };
      await sendDmPreview(msg.chat.id);
    }, 1500);
    dmAlbums.set(albumKey, { chat: String(msg.chat.id), ids: [msg.message_id], timer });
    return true;
  }
  dmPrompts.delete(`${msg.chat.id}:${replyTo}`);
  dmDraft = { id: randomUUID(), srcChat: String(msg.chat.id), srcIds: [msg.message_id], buttons: [] };
  await sendDmPreview(msg.chat.id);
  return true;
}

// Album items arrive one by one; only the first may carry the reply. Keep the rest.
function collectDmAlbumItem(msg: TgMessage): boolean {
  if (!msg.media_group_id) return false;
  const album = dmAlbums.get(`${msg.chat.id}:${msg.media_group_id}`);
  if (!album) return false;
  if (!album.ids.includes(msg.message_id)) album.ids.push(msg.message_id);
  return true;
}

async function updateDmStatus(job: DmJob, final = false) {
  const done = readDone(job.id).size;
  const text = final
    ? [
        `<b>Рассылка пользователям ${job.stopped ? "остановлена" : "завершена"}</b>`,
        `Доставлено: ${job.sent}`,
        `Заблокировали бота / недоступны: ${job.blocked}`,
        job.failed ? `Ошибки: ${job.failed}` : "",
        `Обработано: ${done} из ${job.recipients.length}`,
      ]
        .filter(Boolean)
        .join("\n")
    : `<b>Идёт рассылка пользователям</b>: ${done} из ${job.recipients.length}\nДоставлено ${job.sent}, недоступны ${job.blocked}${job.failed ? `, ошибки ${job.failed}` : ""}`;
  const markup = final ? undefined : { inline_keyboard: [[{ text: "⏹ Остановить", callback_data: `adm:ubstop:${job.id}` }]] };
  if (job.statusMessage) {
    const edited = await tgSoft("editMessageText", {
      chat_id: job.statusChat,
      message_id: job.statusMessage,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
    });
    if (edited || !final) return;
  }
  const sent = await tgSoft<{ message_id: number }>("sendMessage", { chat_id: job.statusChat, text, parse_mode: "HTML", reply_markup: markup });
  if (sent?.message_id && !final) {
    job.statusMessage = sent.message_id;
    saveDmJobs();
  }
}

async function runDmJob(job: DmJob) {
  const done = readDone(job.id);
  let lastStatus = 0;
  await updateDmStatus(job);
  for (const chatId of job.recipients) {
    if (job.stopped) break;
    // Never a group or a channel, never twice (also after a restart).
    if (!isUserId(chatId) || done.has(chatId)) continue;
    appendFileSync(dmDonePath(job.id), `?${chatId}\n`);
    try {
      await sendDmCopy(chatId, job);
      job.sent += 1;
    } catch (err) {
      const text = String((err as Error)?.message || "");
      if (err instanceof TgError && (err.code === 403 || /blocked|deactivated|can't initiate|chat not found|user not found/i.test(text))) {
        job.blocked += 1;
        touchUser(chatId, true);
      } else {
        job.failed += 1;
      }
    }
    done.add(chatId);
    appendFileSync(dmDonePath(job.id), `${chatId}\n`);
    if (Date.now() - lastStatus > 4000) {
      lastStatus = Date.now();
      saveDmJobs();
      await updateDmStatus(job);
    }
    // Telegram allows ~30 messages per second overall; leave room for the rest of the bot.
    await sleep(Math.max(45, 45 * job.srcIds.length));
  }
  await updateDmStatus(job, true);
  dmJobs = dmJobs.filter((j) => j.id !== job.id);
  saveDmJobs();
  try {
    unlinkSync(dmDonePath(job.id));
  } catch {
    /* ignore */
  }
}

function enqueueDmJob(job: DmJob) {
  dmQueue = dmQueue.then(() => runDmJob(job)).catch((err) => console.error("[epb] user broadcast", err));
}

function resumeDmJobs() {
  for (const job of dmJobs) {
    if (Date.now() - job.startedAt > 24 * 60 * 60 * 1000) continue;
    console.log(`[epb] resuming user broadcast ${job.id}: ${readDone(job.id).size} done`);
    enqueueDmJob(job);
  }
}

// Callbacks "adm:ub*" from the admin panel. True when handled.
async function handleDmCallback(cb: NonNullable<TgUpdate["callback_query"]>, action: string, arg: string): Promise<boolean> {
  const chatId = cb.message!.chat.id;
  const answer = (text = "", alert = false) =>
    tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: text || undefined, show_alert: alert });
  if (action === "ub") {
    await answer();
    await renderAdmin(cb, dmScreen());
    return true;
  }
  if (action === "ubnew") {
    if (dmJobs.some((j) => !j.stopped)) {
      await answer("Сначала дождитесь окончания текущей рассылки", true);
      return true;
    }
    await answer("Ответьте на сообщение бота тем, что нужно разослать");
    await askDmContent(chatId);
    return true;
  }
  if (action === "ubbtn") {
    await answer();
    if (!dmDraft) await tgSoft("sendMessage", { chat_id: chatId, text: "Черновик не найден. Начните заново: /admin" });
    else await askDmButtons(chatId);
    return true;
  }
  if (action === "ubclr") {
    if (dmDraft) dmDraft.buttons = [];
    await answer("Кнопки убраны");
    await sendDmPreview(chatId);
    return true;
  }
  if (action === "ubcancel") {
    dmDraft = null;
    await answer("Рассылка отменена");
    await tgSoft("editMessageText", { chat_id: chatId, message_id: cb.message!.message_id, text: "Рассылка отменена." });
    return true;
  }
  if (action === "ubgo") {
    if (!dmDraft || dmDraft.id !== arg) {
      await answer("Этот черновик уже неактуален", true);
      return true;
    }
    await answer();
    await tgSoft("editMessageText", {
      chat_id: chatId,
      message_id: cb.message!.message_id,
      text: `Разослать это сообщение ${userStats().active} пользователям бота? Отменить уже отправленное будет нельзя.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Да, разослать", callback_data: `adm:ubyes:${dmDraft.id}` }],
          [{ text: "⬅ Назад", callback_data: "adm:ubback" }],
        ],
      },
    });
    return true;
  }
  if (action === "ubback") {
    await answer();
    await tgSoft("deleteMessage", { chat_id: chatId, message_id: cb.message!.message_id });
    await sendDmPreview(chatId);
    return true;
  }
  if (action === "ubyes") {
    // One start per draft, whatever how many times or by whom the button is pressed.
    if (!dmDraft || dmDraft.id !== arg || dmStarting.has(arg) || dmJobs.some((j) => j.id === arg)) {
      await answer("Эта рассылка уже запущена или отменена", true);
      return true;
    }
    if (dmJobs.some((j) => !j.stopped)) {
      await answer("Уже идёт другая рассылка", true);
      return true;
    }
    dmStarting.add(arg);
    const recipients = Object.entries(botUsers)
      .filter(([id, u]) => isUserId(id) && !u.blocked)
      .map(([id]) => id);
    const job: DmJob = { ...dmDraft, recipients, sent: 0, blocked: 0, failed: 0, startedAt: Date.now(), statusChat: String(chatId) };
    dmJobs.push(job);
    saveDmJobs();
    dmDraft = null;
    await answer("Рассылка запущена");
    await tgSoft("editMessageText", {
      chat_id: chatId,
      message_id: cb.message!.message_id,
      text: `Рассылка запущена: ${recipients.length} получателей.`,
    });
    enqueueDmJob(job);
    return true;
  }
  if (action === "ubstop") {
    const job = dmJobs.find((j) => j.id === arg);
    if (job) {
      job.stopped = true;
      saveDmJobs();
    }
    await answer(job ? "Останавливаем…" : "Рассылка уже закончилась");
    return true;
  }
  return false;
}

// ---------- Admin panel (arbiter chat only, everything on buttons) ----------

type AdminView = { text: string; keyboard: { text: string; callback_data: string }[][] };
type RelayFilter = "a" | "on" | "pd" | "off";
const ADMIN_PAGE = 8;

const RELAY_FILTERS: { key: RelayFilter; label: string; match: (c: RelayChat) => boolean }[] = [
  { key: "a", label: "Все", match: () => true },
  { key: "on", label: "✅ Вкл", match: (c) => c.status === "on" },
  { key: "pd", label: "⏳ Ждут", match: (c) => c.status === "pending" },
  { key: "off", label: "⛔ Выкл", match: (c) => c.status === "off" },
];

const statusIcon = (status: RelayChat["status"]) => (status === "on" ? "✅" : status === "pending" ? "⏳" : "⛔");
const statusText = (status: RelayChat["status"]) =>
  status === "on" ? "рассылка включена" : status === "pending" ? "ждёт решения" : "рассылка выключена";

function ago(ts?: number): string {
  if (!ts) return "давно";
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 60) return `${Math.max(1, min)} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function cut(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pendingComplaints() {
  return Object.entries(pendingPosts)
    .filter(([, rec]) => (rec.status || "pending") === "pending")
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
}

// Published complaints that are still live in the channel (not already deleted).
function publishedComplaints() {
  return Object.entries(pendingPosts)
    .filter(([, rec]) => rec.status === "published" && rec.channelPosted && !rec.deletedEverywhere)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
}

function adminDeleteList(page: number): AdminView {
  const list = publishedComplaints();
  const pages = Math.max(1, Math.ceil(list.length / ADMIN_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keyboard: AdminView["keyboard"] = list.slice(p * ADMIN_PAGE, (p + 1) * ADMIN_PAGE).map(([key, rec]) => {
    const chats = (rec.relayDeliveries || []).filter((d) => d.messageIds.length).length;
    return [{ text: `${cut(scamLabel(rec), 22)} · ${chats} чат. · ${ago(rec.createdAt)}`, callback_data: `adm:dlc:${key}` }];
  });
  const nav: AdminView["keyboard"][number] = [];
  if (p > 0) nav.push({ text: "◀", callback_data: `adm:dl:${p - 1}` });
  if (pages > 1) nav.push({ text: `${p + 1} / ${pages}`, callback_data: `adm:dl:${p}` });
  if (p < pages - 1) nav.push({ text: "▶", callback_data: `adm:dl:${p + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return {
    text: list.length
      ? `<b>Удалить блеклист</b>: опубликовано ${list.length}\nВыберите запись — бот спросит подтверждение и удалит пост из канала и из всех чатов рассылки.`
      : "<b>Удалить блеклист</b>: опубликованных записей нет.",
    keyboard,
  };
}

async function adminDeleteConfirm(key: string): Promise<AdminView> {
  const rec = pendingPosts[key];
  const back = { text: "⬅ К списку", callback_data: "adm:dl:0" };
  if (!rec || rec.status !== "published") return { text: "Эта запись уже не опубликована.", keyboard: [[back]] };
  const chatCount = (rec.relayDeliveries || []).filter((d) => d.messageIds.length).length;
  const channelCount = rec.channelMsgIds?.length || 0;
  return {
    text: [
      "<b>Удалить блеклист везде?</b>",
      `Аккаунт: ${escapeHtml(scamLabel(rec))}`,
      `Ущерб: ${escapeHtml(rec.amount || "—")} ${escapeHtml(rec.currency || "")}`,
      "",
      `Будет удалено: пост в канале (${channelCount} сообщ.) и сообщения в ${chatCount} чатах рассылки.`,
      "Отменить удаление нельзя. Сообщения старше 48 часов Telegram может не дать удалить в некоторых чатах.",
    ].join("\n"),
    keyboard: [
      [{ text: "🗑 Да, удалить везде", callback_data: `adm:dlgo:${key}` }],
      [back],
    ],
  };
}

function adminHome(): AdminView {
  const relays = bindings.relayChats || [];
  const all = Object.values(pendingPosts);
  const count = (st: string) => all.filter((r) => (r.status || "pending") === st).length;
  const last = bindings.lastBroadcast;
  const lines = [
    `<b>${CHANNEL_NAME} — панель</b>`,
    "",
    `<b>Заявки</b>: ждут решения ${count("pending")}, опубликовано ${count("published")}, отклонено ${count("rejected")}`,
    `<b>Чаты рассылки</b>: включено ${relays.filter((c) => c.status === "on").length}, ждут ${relays.filter((c) => c.status === "pending").length}, выключено ${relays.filter((c) => c.status === "off").length}`,
    `<b>Пользователи бота</b>: ${userStats().total} (заблокировали ${userStats().blocked})`,
    `<b>Канал</b>: <code>${escapeHtml(bindings.channelId || PINNED_CHANNEL)}</code>`,
    last
      ? `<b>Последняя рассылка</b>: ${ago(last.at)}, доставлено ${last.sent} из ${last.total}` +
        (last.noRights ? `, без прав ${last.noRights}` : "") +
        (last.gone ? `, недоступно ${last.gone}` : "")
      : "<b>Последняя рассылка</b>: ещё не было",
  ];
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: `📝 Заявки без решения (${count("pending")})`, callback_data: "adm:ap:0" }],
      [{ text: `🗑 Удалить блеклист (${count("published")})`, callback_data: "adm:dl:0" }],
      [
        { text: "📋 Чаты рассылки", callback_data: "adm:rl:a:0" },
        { text: "⏳ Ждут решения", callback_data: "adm:rl:pd:0" },
      ],
      [{ text: "📢 Канал для постов", callback_data: "adm:ch" }],
      [{ text: "📣 Рассылка пользователям бота", callback_data: "adm:ub" }],
      [{ text: `🖼 Баннеры (${(bindings.banners || []).length})`, callback_data: "adm:bn" }],
      ...(checkEnabled()
        ? [
            [{ text: "➕ Добавить юзера в блеклист", callback_data: "adm:bladd" }],
            [{ text: "🧹 Убрать юзера из блеклиста", callback_data: "adm:ccrm" }],
            [{ text: "🔎 Каналы для проверки", callback_data: "adm:cc" }],
          ]
        : []),
      [
        { text: "🔄 Обновить", callback_data: "adm:home" },
        { text: "✖ Закрыть", callback_data: "adm:x" },
      ],
    ],
  };
}

function adminRelayList(filter: RelayFilter, page: number): AdminView {
  const f = RELAY_FILTERS.find((x) => x.key === filter) || RELAY_FILTERS[0]!;
  const list = (bindings.relayChats || []).filter(f.match);
  const pages = Math.max(1, Math.ceil(list.length / ADMIN_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * ADMIN_PAGE, (p + 1) * ADMIN_PAGE);
  const keyboard: AdminView["keyboard"] = [
    RELAY_FILTERS.map((x) => ({ text: x.key === f.key ? `• ${x.label}` : x.label, callback_data: `adm:rl:${x.key}:0` })),
    ...slice.map((c) => [
      { text: `${statusIcon(c.status)} ${cut(c.title || c.id, 40)}`, callback_data: `adm:rc:${c.id}:${f.key}:${p}` },
    ]),
  ];
  const nav: AdminView["keyboard"][number] = [];
  if (p > 0) nav.push({ text: "◀", callback_data: `adm:rl:${f.key}:${p - 1}` });
  nav.push({ text: `${p + 1} / ${pages}`, callback_data: `adm:rl:${f.key}:${p}` });
  if (p < pages - 1) nav.push({ text: "▶", callback_data: `adm:rl:${f.key}:${p + 1}` });
  keyboard.push(nav, [{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return {
    text: [
      `<b>Чаты рассылки</b> — ${f.label}: ${list.length}`,
      list.length ? "Нажмите на чат, чтобы открыть карточку." : "Здесь пока пусто.",
    ].join("\n"),
    keyboard,
  };
}

async function adminRelayCard(chatId: string, filter: string, page: string, note = ""): Promise<AdminView> {
  const relay = findRelay(chatId);
  const back = { text: "⬅ К списку", callback_data: `adm:rl:${filter}:${page}` };
  if (!relay) return { text: "Этого чата уже нет в списке.", keyboard: [[back]] };
  const suffix = `${relay.id}:${filter}:${page}`;
  const toggle =
    relay.status === "on"
      ? { text: "⛔ Выключить рассылку", callback_data: `adm:roff:${suffix}` }
      : { text: "✅ Включить рассылку", callback_data: `adm:ron:${suffix}` };
  return {
    text: [
      `<b>${escapeHtml(relay.title || "без названия")}</b>`,
      `ID: <code>${escapeHtml(relay.id)}</code>`,
      `Тип: ${chatKindLabel(relay.type)}`,
      `Статус: ${statusIcon(relay.status)} ${statusText(relay.status)}`,
      `Ссылка спонсора: ${relay.link ? `<code>${escapeHtml(relay.link)}</code>` : "не задана"}`,
      relay.requestedAt ? `Запрос: ${ago(relay.requestedAt)}` : "",
      note ? `\n${note}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    keyboard: [
      [toggle],
      [{ text: relay.link ? "🔗 Изменить ссылку спонсора" : "🔗 Задать ссылку спонсора", callback_data: `adm:rlink:${suffix}` }],
      [{ text: "🔍 Проверить права бота", callback_data: `adm:rchk:${suffix}` }],
      [back],
    ],
  };
}

async function botRightsNote(chatId: string): Promise<string> {
  const botId = Number(botToken().split(":")[0]);
  const member = await tgSoft<{
    status: string;
    can_post_messages?: boolean;
    can_send_messages?: boolean;
    can_send_photos?: boolean;
    can_send_videos?: boolean;
  }>("getChatMember", { chat_id: chatId, user_id: botId });
  if (!member) return "❌ Бот не видит этот чат: его удалили или чат закрыт.";
  if (member.status === "left" || member.status === "kicked") return "❌ Бота в этом чате нет.";
  const chat = await tgSoft<{ type?: string }>("getChat", { chat_id: chatId });
  if (chat?.type === "channel") {
    return member.status === "administrator" && member.can_post_messages !== false
      ? "✅ Бот админ канала и может публиковать."
      : "⚠️ Бот не может публиковать в канале: нужен админ с правом публикации.";
  }
  if (member.status === "restricted" && (member.can_send_messages === false || member.can_send_photos === false))
    return "⚠️ Боту запрещено отправлять сообщения или медиа в этом чате.";
  return member.status === "administrator" || member.status === "creator"
    ? "✅ Бот админ, рассылка будет доходить."
    : "✅ Бот участник чата и может писать. Лучше выдать админа, чтобы медиа точно доходили.";
}

function adminPendingList(page: number): AdminView {
  const list = pendingComplaints();
  const pages = Math.max(1, Math.ceil(list.length / ADMIN_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keyboard: AdminView["keyboard"] = list.slice(p * ADMIN_PAGE, (p + 1) * ADMIN_PAGE).map(([key, rec]) => [
    {
      text: `${key} · ${cut(scamLabel(rec), 24)} · ${rec.amount} ${rec.currency} · ${ago(rec.createdAt)}`,
      callback_data: `adm:as:${key}`,
    },
  ]);
  const nav: AdminView["keyboard"][number] = [];
  if (p > 0) nav.push({ text: "◀", callback_data: `adm:ap:${p - 1}` });
  if (pages > 1) nav.push({ text: `${p + 1} / ${pages}`, callback_data: `adm:ap:${p}` });
  if (p < pages - 1) nav.push({ text: "▶", callback_data: `adm:ap:${p + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return {
    text: list.length
      ? `<b>Заявки без решения</b>: ${list.length}\nНажмите на заявку — бот пришлёт её ещё раз с кнопками.`
      : "<b>Заявки без решения</b>: нет, все разобраны.",
    keyboard,
  };
}

// Re-sends a complaint with its review buttons, replying to the original message
// (with the evidence) when it is known.
async function adminShowComplaint(arbiterChatId: number | string, key: string) {
  const rec = pendingPosts[key];
  if (!rec) return false;
  const accounts = pendingAccounts(rec)
    .map((a) => formatAccountLine(a.username, a.id, true))
    .join("\n");
  const text = [
    `<b>Заявка ${escapeHtml(key)}</b> (повтор из панели, ${ago(rec.createdAt)})`,
    "",
    `<b>Аккаунт</b>\n${accounts}`,
    `<b>Ущерб</b>\n${escapeHtml(rec.amount)} ${escapeHtml(rec.currency)}`,
    "",
    `<b>Кратко (в пост)</b>\n${escapeHtml(rec.summary || rec.story)}`,
    rec.files?.length ? `\nДоказательств: ${rec.files.length} (в исходной заявке, они уйдут в пост)` : "",
  ].join("\n");
  const parts = splitHtml(text);
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const payload: Record<string, unknown> = {
      chat_id: arbiterChatId,
      text: part,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: last ? reviewKeyboard(key) : undefined,
    };
    if (i === 0 && rec.reviewMessageId && rec.reviewChatId && sameChat(rec.reviewChatId, arbiterChatId)) {
      payload.reply_parameters = { message_id: rec.reviewMessageId, allow_sending_without_reply: true };
    }
    await tgSoft("sendMessage", payload);
  }
  return true;
}

function adminCheck(): AdminView {
  const list = checkChannels();
  const ub = hasUserbot();
  const lines = [
    "<b>Каналы для проверки контрагента</b>",
    `Подключено: ${list.length}`,
    `Аккаунт (юзербот): ${ub ? "подключён ✅" : "не подключён"}`,
    "",
    ub
      ? "Поиск идёт через подключённый аккаунт по всем постам этих каналов, включая старые. Бота в каналы добавлять не нужно — аккаунт должен быть на них подписан."
      : "Сейчас бот индексирует только новые посты каналов, где он сам состоит. Чтобы искать по старым постам чужих каналов без добавления бота, подключите аккаунт (юзербот) — см. HOSTING.md.",
  ];
  const keyboard: AdminView["keyboard"] = list.map((c) => [
    { text: `🗑 ${cut(c.title || c.username || c.id, 36)}`, callback_data: `adm:ccdel:${c.id}` },
  ]);
  keyboard.push([{ text: "🔌 Проверить аккаунт", callback_data: "adm:ccping" }]);
  keyboard.push([{ text: "🧹 Убрать жалобу из блеклиста", callback_data: "adm:ccrm" }]);
  keyboard.push([{ text: "➕ Добавить канал", callback_data: "adm:ccadd" }]);
  keyboard.push([{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return { text: lines.join("\n"), keyboard };
}

function adminBanners(): AdminView {
  const list = bindings.banners || [];
  const lines = [
    "<b>Баннеры в мини-аппе</b>",
    `Сейчас: ${list.length} из ${MAX_BANNERS}`,
    "",
    list.length
      ? "Баннеры показываются сверху в приложении. Видео и GIF идут без звука и по кругу. Тап по баннеру открывает ссылку."
      : "Пока нет ни одного баннера. Нажмите «Добавить баннер», пришлите картинку / видео / GIF, затем ссылку.",
  ];
  const keyboard: AdminView["keyboard"] = list.map((b, i) => [
    {
      text: `🗑 ${i + 1}. ${b.type === "video" ? "🎞" : "🖼"} ${cut(b.link || "без ссылки", 34)}`,
      callback_data: `adm:bndel:${b.id}`,
    },
  ]);
  if (list.length < MAX_BANNERS) keyboard.push([{ text: "➕ Добавить баннер", callback_data: "adm:bnadd" }]);
  keyboard.push([{ text: "⬅ В меню", callback_data: "adm:home" }]);
  return { text: lines.join("\n"), keyboard };
}

// Replies in the arbiter chat while adding a banner: media first, then the link.
async function handleBannerInput(msg: TgMessage): Promise<boolean> {
  const key = String(msg.chat.id);
  const st = bannerSetup.get(key);
  if (!st) return false;
  if (st.phase === "media") {
    const media = extractBannerMedia(msg);
    if (!media) {
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: "Пришлите картинку, видео или GIF одним сообщением (не текстом). Или /admin, чтобы выйти.",
      });
      return true;
    }
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Загружаю медиа…" });
    const bytes = await downloadTelegramFile(media.fileId);
    if (!bytes) {
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: "Не удалось загрузить файл. Для баннера подойдёт картинка / видео / GIF до 20 МБ. Пришлите ещё раз.",
      });
      return true;
    }
    const id = newBannerId();
    saveBannerFile(id, bytes);
    st.draft = { type: media.type, file: id, mime: media.mime, width: media.width, height: media.height };
    st.phase = "link";
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text: "Медиа сохранено. Теперь пришлите ссылку (https://… или t.me/…), которая откроется по тапу на баннер.\nЕсли ссылка не нужна — отправьте «-».",
    });
    return true;
  }
  // Link phase.
  if (!msg.text) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Пришлите ссылку текстом (https://…) или «-», чтобы без ссылки." });
    return true;
  }
  const link = normalizeBannerLink(msg.text);
  if (link === null) {
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text: "Это не похоже на ссылку. Пришлите адрес вида https://… или t.me/…, либо «-» без ссылки.",
    });
    return true;
  }
  const draft = st.draft;
  bannerSetup.delete(key);
  if (!draft) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Медиа не найдено, начните заново: /admin → Баннеры." });
    return true;
  }
  const banner: Banner = {
    id: draft.file,
    type: draft.type,
    file: draft.file,
    mime: draft.mime,
    link,
    width: draft.width,
    height: draft.height,
    createdAt: Date.now(),
  };
  bindings.banners = [...(bindings.banners || []), banner].slice(-MAX_BANNERS);
  saveBindings();
  const view = adminBanners();
  await tgSoft("sendMessage", {
    chat_id: msg.chat.id,
    text: `Баннер добавлен${link ? "" : " (без ссылки)"}.\n\n${view.text}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.keyboard },
  });
  return true;
}

async function applySponsorLink(arbiterChatId: number | string, raw: string) {
  const st = sponsorLinkSetup.get(String(arbiterChatId));
  sponsorLinkSetup.delete(String(arbiterChatId));
  if (!st) return;
  const res = setSponsorLink(st.relayId, raw);
  if (res === "bad") {
    await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Это не похоже на ссылку. Пришлите https://… или t.me/…, либо «-», чтобы убрать." });
    return;
  }
  const view = await adminRelayCard(st.relayId, st.filter, st.page, res === "set" ? "Ссылка спонсора сохранена." : "Ссылка спонсора убрана.");
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.keyboard },
  });
}

async function applyRemoveFromCheck(arbiterChatId: number | string, raw: string) {
  removeFromCheckSetup.delete(String(arbiterChatId));
  const text = raw.trim();
  let removed = 0;
  const epbId = text.match(/\b(EPB-[A-Za-z0-9]+)\b/i)?.[1];
  if (epbId) {
    const rec = pendingPosts[epbId] || pendingPosts[epbId.toUpperCase()];
    if (rec && !rec.removedFromCheck) {
      rec.removedFromCheck = true;
      removed = 1;
    }
  } else {
    const parsed = parseTelegramInput(text);
    const uname = parsed.username.replace(/^@/, "").toLowerCase();
    const id = parsed.id;
    if (!uname && !id) {
      await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Не понял. Пришлите EPB-… или @username / ID." });
      return;
    }
    for (const rec of Object.values(pendingPosts)) {
      if (rec.removedFromCheck) continue;
      const accounts = pendingAccounts(rec);
      const hit =
        (uname && accounts.some((a) => a.username.replace(/^@/, "").toLowerCase() === uname)) ||
        (id && accounts.some((a) => a.id === id));
      if (hit) {
        rec.removedFromCheck = true;
        removed += 1;
      }
    }
    // Also drop manually added (third-party) entries for this account.
    const manual = bindings.manualBlacklist || [];
    const keptManual = manual.filter((e) => {
      const eu = (e.username || "").replace(/^@/, "").toLowerCase();
      return !((uname && eu === uname) || (id && e.telegramId === id));
    });
    if (keptManual.length !== manual.length) {
      removed += manual.length - keptManual.length;
      bindings.manualBlacklist = keptManual;
      saveBindings();
    }
  }
  if (removed) savePending();
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: removed ? `Убрано из блеклиста: ${removed}. В проверке контрагента больше не показывается.` : "Ничего подходящего не нашёл.",
  });
}

// Manually add a user to the counterparty-check blacklist (source: third party).
// Input: "@username [комментарий]" or "ID [комментарий]".
async function applyAddToBlacklist(arbiterChatId: number | string, raw: string) {
  addBlacklistSetup.delete(String(arbiterChatId));
  const text = raw.trim();
  const firstTok = text.split(/\s+/)[0] || "";
  const note = text.slice(firstTok.length).trim();
  const parsed = parseTelegramInput(firstTok);
  const username = parsed.username.replace(/^@/, "");
  const id = parsed.id;
  if (!username && !id) {
    await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Не понял. Пришлите @username или ID, можно с комментарием через пробел." });
    return;
  }
  const entry: ManualBlacklistEntry = {
    id: randomUUID(),
    username: username || undefined,
    telegramId: id || undefined,
    source: DEFAULT_MANUAL_SOURCE,
    note: note || undefined,
    addedAt: Date.now(),
  };
  bindings.manualBlacklist = [...(bindings.manualBlacklist || []), entry].slice(-5000);
  saveBindings();
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: [
      "Добавлено в блеклист (проверка контрагента).",
      `Аккаунт: ${escapeHtml(username ? `@${username}` : `ID ${id}`)}`,
      `Источник: ${escapeHtml(DEFAULT_MANUAL_SOURCE)}`,
      note ? `Комментарий: ${escapeHtml(note)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    parse_mode: "HTML",
  });
}

async function applyCheckChannel(arbiterChatId: number | string, raw: string) {
  checkChannelSetup.delete(String(arbiterChatId));
  const ref = await parseChannelRef(raw);
  if (!ref) {
    await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Пришлите ID канала (-100…) или @username." });
    return;
  }
  // The bot may not be in the channel; the userbot can still resolve and search it.
  let entry: CheckChannel | null = null;
  const chat = await chatReachable(ref);
  if (chat && (chat.type === "channel" || chat.type === "supergroup")) {
    entry = { id: String(chat.id), title: chat.title, username: chat.username, addedAt: Date.now() };
  } else if (hasUserbot()) {
    entry = await resolveChannelAsUser(String(ref));
  }
  if (!entry) {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: hasUserbot()
        ? "Не удалось открыть этот канал. Подключённый аккаунт должен быть подписан на него. Пришлите @username или ID ещё раз."
        : "Не вижу этот канал. Добавьте бота в канал (участником или админом) и пришлите ID ещё раз — или подключите аккаунт (юзербот), тогда бота добавлять не нужно.",
    });
    return;
  }
  if (isOfficialChannel(entry.id) || isOfficialArbiterChat(entry.id)) {
    await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Это служебный канал бота, добавлять его не нужно." });
    return;
  }
  const list = [...checkChannels()];
  if (!list.some((c) => sameChat(c.id, entry!.id))) {
    list.push(entry);
    bindings.checkChannels = list.slice(-100);
    saveBindings();
  }
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: [
      "Канал подключён для проверки.",
      escapeHtml(entry.title || entry.id),
      `ID: <code>${escapeHtml(entry.id)}</code>`,
      "",
      hasUserbot()
        ? "Поиск по этому каналу идёт через подключённый аккаунт, включая старые посты."
        : "Новые посты этого канала будут попадать в поиск. Для старых постов подключите аккаунт (юзербот).",
    ].join("\n"),
    parse_mode: "HTML",
  });
}

function adminChannel(): AdminView {
  return {
    text: [
      "<b>Канал для постов</b>",
      `Сейчас: <code>${escapeHtml(bindings.channelId || PINNED_CHANNEL)}</code>`,
      "",
      "Чтобы сменить: нажмите кнопку и пришлите ID канала (-100…) или @username следующим сообщением. Бот должен быть админом канала.",
    ].join("\n"),
    keyboard: [[{ text: "✏ Сменить канал", callback_data: "adm:chset" }], [{ text: "⬅ В меню", callback_data: "adm:home" }]],
  };
}

async function sendAdminPanel(chatId: number | string) {
  const view = adminHome();
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.keyboard },
  });
}

async function renderAdmin(cb: NonNullable<TgUpdate["callback_query"]>, view: AdminView) {
  if (!cb.message) return;
  const edited = await tgSoft("editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.keyboard },
  });
  // Telegram refuses an edit that changes nothing; that is fine.
  return edited;
}

async function handleAdminCallback(cb: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = cb.message!.chat.id;
  const [, action = "home", ...rest] = (cb.data || "").split(":");
  const answer = (text = "", alert = false) =>
    tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: text || undefined, show_alert: alert });

  if (action === "x") {
    await answer();
    await tgSoft("deleteMessage", { chat_id: chatId, message_id: cb.message!.message_id });
    return;
  }
  if (action === "home") {
    await answer();
    await renderAdmin(cb, adminHome());
    return;
  }
  if (action.startsWith("ub") && (await handleDmCallback(cb, action, rest[0] || ""))) return;
  if (action === "rl") {
    await answer();
    await renderAdmin(cb, adminRelayList((rest[0] as RelayFilter) || "a", Number(rest[1] || 0)));
    return;
  }
  // Chat ids are negative: "-100123" survives the split as one piece.
  const [target = "", filter = "a", page = "0"] = rest;
  if (action === "rc") {
    await answer();
    await renderAdmin(cb, await adminRelayCard(target, filter, page));
    return;
  }
  if (action === "ron" || action === "roff") {
    const relay = findRelay(target);
    if (!relay) {
      await answer("Чата уже нет в списке", true);
      return;
    }
    upsertRelay({ id: relay.id, title: relay.title, type: relay.type }, action === "ron" ? "on" : "off");
    if (action === "ron") {
      await tgSoft("sendMessage", {
        chat_id: relay.id,
        text: `Рассылка ${CHANNEL_NAME} включена. Сюда будут приходить одобренные посты.`,
      });
    }
    await answer(action === "ron" ? "Рассылка включена" : "Рассылка выключена");
    await renderAdmin(cb, await adminRelayCard(target, filter, page));
    return;
  }
  if (action === "rchk") {
    await answer("Проверяем…");
    await renderAdmin(cb, await adminRelayCard(target, filter, page, await botRightsNote(target)));
    return;
  }
  if (action === "rlink") {
    if (!findRelay(target)) {
      await answer("Чата уже нет в списке", true);
      return;
    }
    sponsorLinkSetup.set(String(chatId), { relayId: target, filter, page });
    await answer("Пришлите ссылку");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите ссылку на чат (https://… или t.me/…), которая будет прикреплена к названию на странице «Спонсоры проекта». Чтобы убрать ссылку — отправьте «-».",
    });
    return;
  }
  if (action === "ap") {
    await answer();
    await renderAdmin(cb, adminPendingList(Number(rest[0] || 0)));
    return;
  }
  if (action === "as") {
    const key = rest[0] || "";
    const shown = (pendingPosts[key]?.status || "pending") === "pending" && (await adminShowComplaint(chatId, key));
    await answer(shown ? "Заявка отправлена ниже" : "Заявка уже обработана", !shown);
    if (!shown) await renderAdmin(cb, adminPendingList(0));
    return;
  }
  if (action === "cc") {
    await answer();
    await renderAdmin(cb, adminCheck());
    return;
  }
  if (action === "ccping") {
    await answer("Проверяем аккаунт…");
    const st = await userbotStatus();
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: st.ok ? `Аккаунт подключён: ${escapeHtml(st.name || "аккаунт")}` : `Аккаунт не подключён: ${escapeHtml(st.error || "ошибка")}`,
    });
    return;
  }
  if (action === "ccrm") {
    removeFromCheckSetup.add(String(chatId));
    await answer("Пришлите номер жалобы или аккаунт");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите номер жалобы (EPB-…) либо @username / ID аккаунта, который нужно убрать из блеклиста (поиска). Жалоба останется в истории, но перестанет находиться в проверке контрагента.",
    });
    return;
  }
  if (action === "bladd") {
    addBlacklistSetup.add(String(chatId));
    await answer("Пришлите @username или ID");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите @username или ID аккаунта, которого нужно добавить в блеклист (проверку контрагента). Можно с комментарием через пробел, например:\n@scammer кинул на сделке, инфа из чужого блеклиста\n\nИсточник отметится как «Сторонний источник».",
    });
    return;
  }
  if (action === "ccadd") {
    checkChannelSetup.add(String(chatId));
    await answer("Пришлите ID канала следующим сообщением");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите ID канала (-100…) или @username для проверки. Бот должен быть в этом канале.",
    });
    return;
  }
  if (action === "ccdel") {
    const target = rest.join(":");
    bindings.checkChannels = checkChannels().filter((c) => !sameChat(c.id, target));
    saveBindings();
    removeCheckChannelFromIndex(target);
    await answer("Канал убран");
    await renderAdmin(cb, adminCheck());
    return;
  }
  if (action === "dl") {
    await answer();
    await renderAdmin(cb, adminDeleteList(Number(rest[0] || 0)));
    return;
  }
  if (action === "dlc") {
    await answer();
    await renderAdmin(cb, await adminDeleteConfirm(rest.join(":")));
    return;
  }
  if (action === "dlgo") {
    const delKey = rest.join(":");
    if (!pendingPosts[delKey] || pendingPosts[delKey]!.status !== "published") {
      await answer("Запись уже удалена", true);
      await renderAdmin(cb, adminDeleteList(0));
      return;
    }
    await answer("Удаляю во всех чатах…");
    const res = await deletePublishedEverywhere(delKey);
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: [
        "Блеклист удалён.",
        `Канал: удалено ${res.channel.ok}${res.channel.fail ? `, не удалось ${res.channel.fail}` : ""}.`,
        `Чаты рассылки (${res.chatCount}): удалено ${res.chats.ok}${res.chats.fail ? `, не удалось ${res.chats.fail}` : ""}.`,
        res.channel.fail || res.chats.fail
          ? "Часть сообщений не удалилась — вероятно, они старше 48 часов или у бота нет прав на удаление в чате."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    await renderAdmin(cb, adminDeleteList(0));
    return;
  }
  if (action === "bn") {
    bannerSetup.delete(String(chatId));
    await answer();
    await renderAdmin(cb, adminBanners());
    return;
  }
  if (action === "bnadd") {
    if ((bindings.banners || []).length >= MAX_BANNERS) {
      await answer("Достигнут лимит баннеров", true);
      await renderAdmin(cb, adminBanners());
      return;
    }
    bannerSetup.set(String(chatId), { phase: "media" });
    await answer("Пришлите медиа для баннера");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите картинку, видео или GIF для баннера (до 20 МБ). Следующим сообщением попрошу ссылку.",
    });
    return;
  }
  if (action === "bndel") {
    removeBannerById(rest.join(":"));
    await answer("Баннер удалён");
    await renderAdmin(cb, adminBanners());
    return;
  }
  if (action === "ch") {
    await answer();
    await renderAdmin(cb, adminChannel());
    return;
  }
  if (action === "chset") {
    await answer("Пришлите ID канала следующим сообщением");
    await askPublishChannel(chatId);
    return;
  }
  await answer();
}

function relayListHtml(): string[] {
  const list = bindings.relayChats || [];
  const by = (status: RelayChat["status"]) => list.filter((c) => c.status === status);
  const line = (c: RelayChat) => `• ${escapeHtml(c.title || "без названия")} — <code>${escapeHtml(c.id)}</code>`;
  const lines = [
    `<b>Чаты рассылки</b>: включено ${by("on").length}, ждут решения ${by("pending").length}, выключено ${by("off").length}`,
    "",
    "<b>Включены</b>",
    ...(by("on").length ? by("on").map(line) : ["—"]),
  ];
  if (by("pending").length) lines.push("", "<b>Ждут решения</b>", ...by("pending").map(line));
  lines.push("", "Включить вручную: /relay_on -100…", "Выключить: /relay_off -100…");
  return splitHtml(lines.join("\n"));
}

// Manual control for arbiters, e.g. to re-add chats if the relay list was ever lost.
async function handleRelayCommand(arbiterChatId: number, cmd: string, arg: string) {
  if (cmd === "relays") {
    for (const part of relayListHtml()) {
      await tgSoft("sendMessage", { chat_id: arbiterChatId, text: part, parse_mode: "HTML", disable_web_page_preview: true });
    }
    return;
  }
  const raw = arg.trim().split(/\s+/)[0] || "";
  if (!/^-\d{5,20}$/.test(raw)) {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: `Укажите ID чата: /${cmd} -100…\nСписок: /relays`,
    });
    return;
  }
  const chat = await tgSoft<{ id: number; type: string; title?: string }>("getChat", { chat_id: raw });
  if (cmd === "relay_on" && !chat) {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: "Бот не видит этот чат. Сначала добавьте бота в чат, потом повторите команду.",
    });
    return;
  }
  if (chat && (isOfficialArbiterChat(chat.id) || isOfficialChannel(chat.id))) {
    await tgSoft("sendMessage", { chat_id: arbiterChatId, text: "Это служебный чат, рассылка туда не нужна." });
    return;
  }
  const target = chat ? { id: chat.id, type: chat.type, title: chat.title } : { id: raw };
  upsertRelay(target, cmd === "relay_on" ? "on" : "off");
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: `${cmd === "relay_on" ? "Рассылка включена" : "Рассылка выключена"}: ${escapeHtml(chat?.title || raw)}\nID: <code>${escapeHtml(String(target.id))}</code>`,
    parse_mode: "HTML",
  });
}

async function parseChannelRef(raw: string): Promise<string | null> {
  const t = raw.trim().split(/\s+/)[0] || "";
  if (!t) return null;
  if (t.startsWith("@")) return t;
  const fromUrl = t.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (fromUrl?.[1] && !fromUrl[1].startsWith("+")) return `@${fromUrl[1]}`;
  const num = t.replace(/[^\d-]/g, "");
  if (/^-100\d{6,}$/.test(num)) return num;
  if (/^100\d{6,}$/.test(num)) return `-${num}`;
  if (/^\d{6,}$/.test(num)) return `-100${num}`;
  return t;
}

async function applyPublishChannel(arbiterChatId: number | string, raw: string) {
  const ref = await parseChannelRef(raw);
  if (!ref) {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: "Пришлите ID канала, например <code>-1003958415589</code>, или @username.",
      parse_mode: "HTML",
    });
    return;
  }
  const chat = await chatReachable(ref);
  if (!chat) {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: "Не вижу этот канал. Добавьте бота админом и пришлите ID ещё раз.",
    });
    return;
  }
  if (chat.type !== "channel" && chat.type !== "supergroup") {
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text: "Это не канал. Нужен ID канала, куда постить одобренные заявки.",
    });
    return;
  }
  bindings.channelId = String(chat.id);
  saveBindings();
  channelSetup.delete(String(arbiterChatId));
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: [
      "Канал для постов обновлён.",
      escapeHtml(chat.title || "Канал"),
      `ID: <code>${chat.id}</code>`,
    ].join("\n"),
    parse_mode: "HTML",
  });
}

async function askPublishChannel(arbiterChatId: number | string) {
  channelSetup.add(String(arbiterChatId));
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: [
      `Сейчас посты идут в <code>${bindings.channelId || PINNED_CHANNEL}</code>`,
      "",
      "Пришлите ID канала (например <code>-1003958415589</code>) или @username.",
      "Бот должен быть админом этого канала.",
      "",
      "Или сразу: /channel -100…",
    ].join("\n"),
    parse_mode: "HTML",
  });
}

const seenUpdates = new Set<number>();

export async function handleUpdate(update: TgUpdate) {
  if (typeof update?.update_id === "number") {
    if (seenUpdates.has(update.update_id)) return;
    seenUpdates.add(update.update_id);
    if (seenUpdates.size > 5000) seenUpdates.delete(seenUpdates.values().next().value!);
  }
  try {
    await handleTelegramUpdate(update);
  } catch (err) {
    if (!isDisconnectError(err)) console.error("[epb] update", err);
  }
}

async function handleTelegramUpdate(update: TgUpdate) {
  void ensureBotProfile();

  // Posts from channels added for counterparty checks get indexed; nothing else happens.
  const post = update.channel_post || update.edited_channel_post;
  if (post) {
    const ch = isCheckChannel(post.chat.id);
    if (ch) {
      if (post.chat.title && post.chat.title !== ch.title) {
        ch.title = post.chat.title;
        saveBindings();
      }
      indexCheckPost(ch, post.message_id, post.text || post.caption || "", post.date || 0);
    }
    return;
  }

  rememberUser(update.message?.from);
  rememberUser(update.message?.forward_from);
  rememberUser(update.message?.forward_origin?.sender_user);
  rememberUser(update.message?.reply_to_message?.from);
  rememberUser(update.message?.reply_to_message?.forward_from);
  rememberUser(update.callback_query?.from);
  for (const ent of [
    ...(update.message?.entities || []),
    ...(update.message?.caption_entities || []),
    ...(update.message?.reply_to_message?.entities || []),
  ]) {
    rememberUser(ent.user);
  }

  const groupMsg = update.message;
  if (groupMsg && (groupMsg.chat.type === "group" || groupMsg.chat.type === "supergroup")) {
    if (groupMsg.migrate_to_chat_id) onChatMigrated(String(groupMsg.chat.id), String(groupMsg.migrate_to_chat_id));
    if (groupMsg.migrate_from_chat_id) onChatMigrated(String(groupMsg.migrate_from_chat_id), String(groupMsg.chat.id));
    // Ordinary messages from relay chats are dropped before any rate limit, so busy
    // or spammed groups can never use up the limit and mute the bot for arbiters.
    if (!isOfficialArbiterChat(groupMsg.chat.id)) return;
  }

  const floodId = String(
    update.message?.from?.id || update.callback_query?.from?.id || update.my_chat_member?.from?.id || "",
  );
  const liveSession = sessions.get(floodId);
  const incoming = update.message;
  const evidenceBurst =
    liveSession?.step === "evidence" &&
    Boolean(incoming?.photo?.length || incoming?.video || incoming?.document);
  if (tooMany("upd:global", 600, 60_000)) return;
  if (floodId && !evidenceBurst && tooMany(`flood:${floodId}`, 80, 60_000)) {
    return;
  }
  if (liveSession) liveSession.touched = Date.now();
  gcSessions();

  if (update.message?.chat.type === "private") touchUser(update.message.from?.id);
  if (update.callback_query?.message?.chat.type === "private") touchUser(update.callback_query.from?.id);

  const member = update.my_chat_member;
  if (member) {
    if (member.chat.type === "private") {
      // The user blocked (kicked) or unblocked the bot.
      touchUser(member.chat.id, member.new_chat_member.status === "kicked");
      return;
    }
    if (!isGroupOrChannel(member.chat)) return;
    const status = member.new_chat_member.status;
    if (status === "left" || status === "kicked") {
      dropRelay(member.chat.id);
      return;
    }
    if (status === "member" || status === "administrator" || status === "creator") {
      const before = member.old_chat_member?.status;
      await bindChat(member.chat, member.from, !before || before === "left" || before === "kicked");
    }
    return;
  }

  const cb = update.callback_query;
  if (cb?.message && cb.data) {
    if (cb.data === "owners") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      const locale = langOf(cb.from?.id);
      await tgSoft("sendMessage", {
        chat_id: cb.message.chat.id,
        text: ownersText(locale),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: ownersKeyboard(locale),
      });
      return;
    }
    if (cb.data === "home") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await replyStart(cb.message.chat.id, cb.from?.id);
      return;
    }
    if (cb.data === "lang") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await askLanguage(cb.message.chat.id, true);
      return;
    }
    if (cb.data === "lang:ru" || cb.data === "lang:en") {
      const locale: Locale = cb.data.endsWith("en") ? "en" : "ru";
      if (cb.from?.id) setLang(cb.from.id, locale);
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: tb(locale, "langSaved") });
      await replyStart(cb.message.chat.id, cb.from?.id);
      return;
    }
    if (cb.data.startsWith("ub:")) {
      if (await handleOwnerCallback(cb)) return;
    }
    if (cb.data.startsWith("adm:")) {
      if (!isOfficialArbiterChat(cb.message.chat.id)) {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Чат не авторизован", show_alert: true });
        return;
      }
      await handleAdminCallback(cb);
      return;
    }
    if (cb.data.startsWith("rel:")) {
      if (!isOfficialArbiterChat(cb.message.chat.id)) {
        await tgSoft("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Чат не авторизован",
          show_alert: true,
        });
        return;
      }
      await handleRelayDecision(cb, cb.data.startsWith("rel:y:"));
      return;
    }
    if ((cb.data === "pub" || cb.data.startsWith("pub:") || cb.data.startsWith("puball") || cb.data.startsWith("pubch") || cb.data === "rej" || cb.data.startsWith("rej:") || /^p(edit|view|orig):/.test(cb.data)) && !isOfficialArbiterChat(cb.message.chat.id)) {
      await tgSoft("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Чат не авторизован",
        show_alert: true,
      });
      return;
    }
    const text = cb.message.caption || cb.message.text || "";
    const isMedia = Boolean(cb.message.caption || cb.message.photo || cb.message.video);
    if (alreadyHandled(text)) {
      await tgSoft("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Заявка уже обработана",
      });
      return;
    }
    if (cb.data === "pub" || (cb.data.startsWith("pub:") && !cb.data.startsWith("puball") && !cb.data.startsWith("pubch"))) {
      const key = parseAppKey(text, cb.data);
      const markup = publishChoiceKeyboard(key);
      const ok = await replaceReplyMarkup(cb.message, markup);
      if (!ok) {
        await tgSoft("sendMessage", {
          chat_id: cb.message.chat.id,
          text: "Как опубликовать эту заявку?",
          reply_to_message_id: cb.message.message_id,
          reply_markup: markup,
        });
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Выберите тип публикации" });
      return;
    }
    if (/^p(edit|view|orig):/.test(cb.data)) {
      const [action, key = ""] = cb.data.split(":");
      const rec = pendingPosts[key];
      if (!rec || (rec.status || "pending") !== "pending") {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже обработана", show_alert: true });
        return;
      }
      if (action === "pedit") {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Ответьте на сообщение бота новым текстом" });
        await askPostEdit(cb.message.chat.id, key);
      } else if (action === "pview") {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
        await sendPostPreview(cb.message.chat.id, key, cb.message.message_id);
      } else {
        delete rec.postHtml;
        savePending();
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Вернули исходный текст" });
        await sendPostPreview(cb.message.chat.id, key, cb.message.message_id);
      }
      return;
    }
    if (cb.data.startsWith("puball") || cb.data.startsWith("pubch")) {
      const extraFiles: MediaRef[] = [];
      const lastPhoto = cb.message.photo?.at(-1)?.file_id;
      if (lastPhoto) extraFiles.push({ type: "photo", file_id: lastPhoto });
      if (cb.message.video?.file_id) extraFiles.push({ type: "video", file_id: cb.message.video.file_id });
      const relay = cb.data.startsWith("puball");
      const key = parseAppKey(text, cb.data);
      const lookup = key && pendingPosts[key]
        ? `#epb u=${pendingPosts[key]!.username || ""} id=${pendingPosts[key]!.id || "0"} k=${key}`
        : text;
      const published = await publishFromMessage(lookup, cb.id, extraFiles, relay, key, {
        chatId: cb.message.chat.id,
        messageId: cb.message.message_id,
      });
      if (!published) return;
      const next = `${escapeHtml(stripServiceMarker(text || "Заявка"))}\n\nСтатус: ${relay ? "опубликовано с рассылкой" : "опубликовано без рассылки"}`;
      const cleared = { inline_keyboard: [] };
      const edited = await replaceReplyMarkup(cb.message, cleared, next);
      if (!edited) {
        await tgSoft("editMessageReplyMarkup", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: cleared,
        });
      }
      return;
    }
    if (cb.data === "rej" || cb.data.startsWith("rej:")) {
      const key = parseAppKey(text, cb.data);
      const record = key ? pendingPosts[key] : undefined;
      if (record?.status === "published" || (key && publishing.has(key))) {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже опубликована", show_alert: true });
        return;
      }
      if (record && record.status !== "rejected") {
        record.status = "rejected";
        savePending();
        await notifyApplicant(record, key, "rejected");
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Отклонено" });
      const next = `${escapeHtml(stripServiceMarker(text))}\n\nСтатус: отклонено`;
      await replaceReplyMarkup(cb.message, { inline_keyboard: [] }, next);
      return;
    }
    const userId = String(cb.from?.id || "");
    await handleApplyCallback(cb, sessions.get(userId));
    return;
  }

  const msg = update.message;
  if (!msg) return;

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    if (!isOfficialArbiterChat(msg.chat.id)) return;
  }
  if (msg.chat.type === "channel" && bindings.channelId && !isOfficialChannel(msg.chat.id)) {
    return;
  }

  const cmd = commandName(msg.text);
  const userId = String(msg.from?.id || msg.chat.id);

  if (cmd === "start" || cmd === "app") {
    const fromId = msg.from?.id;
    if (fromId && !hasLang(fromId)) {
      await askLanguage(msg.chat.id);
      return;
    }
    await replyStart(msg.chat.id, fromId);
    return;
  }
  if (cmd === "lang") {
    await askLanguage(msg.chat.id, hasLang(msg.from?.id));
    return;
  }
  if (cmd === "channel") {
    if (!isOfficialArbiterChat(msg.chat.id)) return;
    const arg = (msg.text || "").replace(/^\/channel(?:@\w+)?/i, "").trim();
    if (arg) await applyPublishChannel(msg.chat.id, arg);
    else await askPublishChannel(msg.chat.id);
    return;
  }
  if (cmd === "admin" || cmd === "menu" || cmd === "panel") {
    if (!isOfficialArbiterChat(msg.chat.id)) return;
    await sendAdminPanel(msg.chat.id);
    return;
  }
  if (cmd === "checkon" || cmd === "checkoff") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    bindings.checkEnabled = cmd === "checkon";
    saveBindings();
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text: cmd === "checkon" ? "Проверка контрагента включена." : "Проверка контрагента выключена и скрыта.",
    });
    return;
  }
  if (cmd === "audience") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    const n = Number((msg.text || "").replace(/[^\d]/g, ""));
    if (!setAudienceBase(n)) {
      await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Укажите число, например: /audience 20178" });
      return;
    }
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text: `Базовая аудитория обновлена: ~${n.toLocaleString("ru-RU")}. Показывается в приложении (с учётом реального числа участников чатов).`,
    });
    return;
  }
  if (cmd === "usearch") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    const arg = (msg.text || "").replace(/^\/\S+\s*/, "").trim();
    if (!arg) {
      await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Проверка поиска по юзернейму. Пришлите: /usearch @username" });
      return;
    }
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Проверяю поиск…" });
    const report = await diagnoseUserSearch(arg);
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: report });
    return;
  }
  if (cmd === "userbot") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id) || !checkEnabled()) return;
    await sendOwnerPanel(msg.chat.id);
    return;
  }
  if (cmd === "cancel_userbot") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    const stt = loginStates.get(String(msg.chat.id));
    await stt?.client?.disconnect?.().catch(() => {});
    loginStates.delete(String(msg.chat.id));
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Подключение отменено." });
    return;
  }
  if (cmd === "relays" || cmd === "relay_on" || cmd === "relay_off") {
    if (!isOfficialArbiterChat(msg.chat.id)) return;
    await handleRelayCommand(msg.chat.id, cmd, (msg.text || "").split(/\s+/).slice(1).join(" "));
    return;
  }
  if (cmd === "cancel") {
    await cancelApply(msg.chat.id, userId);
    return;
  }
  if (cmd === "apply") {
    if (msg.chat.type !== "private") {
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: btUser(msg.from?.id, "applyInGroup", { bot: BOT_USERNAME }),
      });
      return;
    }
    if (!msg.from) return;
    await startApply(msg.chat.id, msg.from);
    return;
  }
  if (cmd === "id" || cmd === "bind") {
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      if (!isOfficialArbiterChat(msg.chat.id)) return;
      bindings.arbiterChatId = String(msg.chat.id);
      saveBindings();
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: [
          `Чат арбитров подтверждён.`,
          `ID: <code>${msg.chat.id}</code>`,
          "",
          "Заявки будут приходить только сюда.",
          "",
          `Канал для постов: <code>${bindings.channelId || PINNED_CHANNEL}</code>`,
          "Сменить: /channel -100…",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
    if (msg.chat.type === "channel") {
      if (bindings.channelId && !isOfficialChannel(msg.chat.id)) return;
      bindings.channelId = String(msg.chat.id);
      saveBindings();
    }
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text: `ID этого чата: <code>${msg.chat.id}</code>\nТип: ${msg.chat.type}`,
      parse_mode: "HTML",
    });
    return;
  }

  if (isOfficialArbiterChat(msg.chat.id) && !cmd && bannerSetup.has(String(msg.chat.id)) && (await handleBannerInput(msg))) return;
  if (isOfficialArbiterChat(msg.chat.id) && !cmd && collectDmAlbumItem(msg)) return;
  if (isOfficialArbiterChat(msg.chat.id) && !cmd && (await handleDmReply(msg))) return;
  if (isOfficialArbiterChat(msg.chat.id) && !cmd && (await handlePostEditReply(msg))) return;
  if (isOfficialArbiterChat(msg.chat.id) && removeFromCheckSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyRemoveFromCheck(msg.chat.id, msg.text);
    return;
  }
  if (isOfficialArbiterChat(msg.chat.id) && addBlacklistSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyAddToBlacklist(msg.chat.id, msg.text);
    return;
  }
  if (isOfficialArbiterChat(msg.chat.id) && sponsorLinkSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applySponsorLink(msg.chat.id, msg.text);
    return;
  }
  if (isOfficialArbiterChat(msg.chat.id) && checkChannelSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyCheckChannel(msg.chat.id, msg.text);
    return;
  }
  if (isOfficialArbiterChat(msg.chat.id) && channelSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyPublishChannel(msg.chat.id, msg.text);
    return;
  }

  if (msg.chat.type !== "private") return;
  if (isOwner(msg.from?.id) && !cmd && ownerLoginActive(msg.chat.id) && msg.text) {
    if (await handleOwnerLogin(msg.chat.id, msg.text)) return;
  }
  const session = sessions.get(userId);
  if (session) await handleApplyMessage(msg, session);
}

export async function registerMiniAppUrl(url: string) {
  const clean = url.replace(/\/$/, "");
  if (!clean.startsWith("https://") || isGatedHost(clean)) {
    return { ok: false as const, reason: "gated" };
  }
  bindings.miniAppUrl = clean;
  saveBindings();
  lastMenuUrl = "";
  await applyMenuButton();
  const set = await tgSoft("setWebhook", {
    url: `${clean}/api/telegram/webhook`,
    secret_token: webhookSecret(),
    allowed_updates: ["message", "callback_query", "my_chat_member", "channel_post", "edited_channel_post"],
    drop_pending_updates: false,
  });
  if (set) {
    bindings.webhookStamp = webhookStamp();
    saveBindings();
  }
  return { ok: true as const, url: clean };
}

let webhookArmed = false;

export async function configureFromOrigin(_origin: string) {
  const site = publicSiteUrl();
  if (!site) {
    return { configured: false as const, reason: "need_https" };
  }
  if (!webhookArmed) {
    webhookArmed = true;
    void ensureProductionWebhook();
  }
  return { configured: true as const, url: site };
}

export async function deleteWebhook() {
  await tgSoft("deleteWebhook", { drop_pending_updates: false });
}

// Check the webhook right after start, not only when the first update arrives:
// with a wrong secret no update would ever arrive.
if (botToken() && (process.env.PUBLIC_URL || process.env.NODE_ENV === "production")) {
  setTimeout(() => void ensureBotProfile().catch(() => {}), 3000);
}
if (botToken() && broadcastJobs.length) setTimeout(resumeBroadcasts, 5000);
if (botToken() && dmJobs.length) setTimeout(resumeDmJobs, 6000);
