import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, statfsSync, unlinkSync, appendFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { CHANNEL_NAME, CHANNEL_URL, KNOWN_TELEGRAM_IDS, parseDamageAmount, parseTelegramInput } from "@/lib/telegram";
import type { Application, ComplaintHistoryItem, Currency, EvidenceItem, PersonRef } from "@/lib/types";
import { scammerAccounts } from "@/lib/types";
import { nextTier, tierFor } from "@/lib/tiers";
import { WELCOME_JPEG_BASE64 } from "@/lib/welcome-card";
import { WELCOME_MP4_BASE64 } from "@/lib/welcome-anim";
import { isLocale, tb, type BotMsg, type Locale } from "@/lib/i18n";
import { normalizeCaptchaAnswer, randomCaptchaWord, renderCaptcha } from "@/lib/captcha.server";
import { applyCustomEmoji, CUSTOM_EMOJI, decorateButtons, hasCustomEmoji, hasEmojiId, markupHasIconableButton, registerPackEmoji, stripCustomEmoji } from "@/lib/telegram-emoji";

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
  // members may type /im here to get their member card (an animation) with stats
  imEnabled?: boolean;
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

type BannedUser = { id?: string; username?: string; at: number };

// A counterparty check that found something, kept in a shared recent list.
type RecentFind = {
  id: string;
  username?: string;
  telegramId?: string;
  label: string;
  sources: string[];
  at: number;
};

type Bindings = {
  arbiterChatId?: string;
  channelId?: string;
  miniAppUrl?: string;
  cards?: Partial<Record<"welcome" | "welcomeAnim3" | "submitted" | "published", string>>;
  cardStamp?: string;
  relayChats?: RelayChat[];
  checkChannels?: { id: string; title?: string; username?: string; addedAt: number }[];
  userbotApi?: { apiId: number; apiHash: string };
  blacklistCleanupStamp?: string;
  findsCleanupStamp?: string;
  checkEnabled?: boolean;
  banners?: Banner[];
  manualBlacklist?: ManualBlacklistEntry[];
  // Accounts the arbiters took out of the search altogether: posts about them in
  // the other blacklist channels are not shown either (an erroneous blacklist).
  checkExclusions?: { id: string; username?: string; telegramId?: string; addedAt: number }[];
  // Baseline total audience shown in the stats line (owner can set it).
  audienceBase?: number;
  // Premium custom emoji in private-chat messages (default on).
  customEmoji?: boolean;
  // Extra icons looked up in the owner's emoji pack: plain emoji -> custom_emoji_id.
  packEmoji?: { at: number; set: string; map: Record<string, string>; sig?: string };
  // Recently found counterparty checks, shared across all users (newest first,
  // capped). Shown in the app's "recent blacklists" list.
  recentFinds?: RecentFind[];
  // The last counterparty searches (app and bot), newest first, for /admin.
  searchLog?: SearchLogEntry[];
  // Users banned from the bot and the mini app (by Telegram id and/or username).
  bannedUsers?: BannedUser[];
  webhookStamp?: string;
  offsiteBackupAt?: number;
  // /pars changed something in a chat (userbot joined / got a temporary admin
  // right); kept until undone, so a restart mid-check still cleans up.
  parsCleanup?: { chatId: string; userbotId: string; joined: boolean; promoted: boolean };
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

// Cached check results must not outlive a data change (channels, manual
// entries, published complaints). The cache is declared further down, so during
// module start-up this is a harmless no-op.
function isExcludedAccount(usernames: (string | undefined)[], id?: string): boolean {
  const list = bindings.checkExclusions;
  if (!list?.length) return false;
  const names = usernames.map((u) => (u || "").replace(/^@/, "").toLowerCase()).filter(Boolean);
  return list.some((e) => (id && e.telegramId === id) || (e.username && names.includes(e.username)));
}

function invalidateCheckCache() {
  try {
    checkCache.clear();
  } catch {
    /* not initialised yet */
  }
}

function saveBindings() {
  invalidateCheckCache();
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

// For frequent changes that don't affect checks (search history, card file
// ids): one write a few seconds later instead of one per event, and the check
// cache is left alone.
let bindingsSoonTimer: ReturnType<typeof setTimeout> | null = null;
function saveBindingsSoon() {
  if (bindingsSoonTimer || bindingsLoadFailed) return;
  bindingsSoonTimer = setTimeout(() => {
    bindingsSoonTimer = null;
    try {
      writeJsonAtomic(BINDINGS_PATH, bindings);
    } catch {
      /* ignore */
    }
  }, 3000);
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

let localesTimer: ReturnType<typeof setTimeout> | null = null;
function saveLocales() {
  if (localesTimer) return;
  localesTimer = setTimeout(() => {
    localesTimer = null;
    try {
      writeJsonAtomic(LOCALES_PATH, userLocales);
    } catch {
      /* ignore */
    }
  }, 2000);
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
  // Media chosen by the arbiters for the post (photos removed or added);
  // when set it replaces the complaint's own files.
  postFiles?: MediaRef[];
  // Where it was filed (mini app or bot) and, if rejected, the arbiters' reason.
  source?: "app" | "bot";
  rejectReason?: string;
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
// ---------- Member cards: how many of a user's complaints became blacklists ----------
// Kept apart from the complaint records, which get pruned when there are many,
// so a user's card level never drops because old records were cleaned up.
const TIERS_PATH = join(DATA_DIR, "telegram-user-tiers.json");
const publishedByUser: Record<string, string[]> = readJson<Record<string, string[]>>(TIERS_PATH) || {};
let tiersTimer: ReturnType<typeof setTimeout> | null = null;
function saveTiers() {
  if (tiersTimer) return;
  tiersTimer = setTimeout(() => {
    tiersTimer = null;
    try {
      writeJsonAtomic(TIERS_PATH, publishedByUser);
    } catch {
      /* ignore */
    }
  }, 1000);
}
function rememberPublished(key: string) {
  const uid = pendingPosts[key]?.victimId;
  if (!uid) return;
  const list = (publishedByUser[uid] ||= []);
  if (!list.includes(key)) {
    list.push(key);
    saveTiers();
  }
}
// A blacklist the admins deleted everywhere no longer counts for its author.
function forgetPublished(key: string) {
  const uid = pendingPosts[key]?.victimId;
  const list = uid ? publishedByUser[uid] : undefined;
  if (!uid || !list?.includes(key)) return;
  publishedByUser[uid] = list.filter((k) => k !== key);
  saveTiers();
}
// Blacklists published before the counter existed: copy them in once at start,
// so pruning the complaint records later can't lower anyone's card.
{
  let added = false;
  for (const [key, rec] of Object.entries(pendingPosts)) {
    if (rec.status !== "published" || !rec.victimId || rec.deletedEverywhere) continue;
    const list = (publishedByUser[rec.victimId] ||= []);
    if (!list.includes(key)) {
      list.push(key);
      added = true;
    }
  }
  if (added) saveTiers();
}
// Published blacklists filed by this user. A record deleted everywhere by the
// admins stops counting; one pruned from the complaint list still counts.
export function publishedCountFor(telegramId: string): number {
  const uid = String(telegramId || "").trim();
  if (!uid) return 0;
  const keys = new Set(publishedByUser[uid] || []);
  for (const [key, rec] of Object.entries(pendingPosts)) {
    if (rec.victimId === uid && rec.status === "published") keys.add(key);
  }
  let n = 0;
  for (const key of keys) {
    const rec = pendingPosts[key];
    if (!rec || (rec.status === "published" && !rec.deletedEverywhere)) n++;
  }
  return n;
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

// One-time wipe of recent finds polluted by the earlier loose matcher (false
// positives like HARRYFRAUD from WWH ad-stat posts). They re-populate correctly.
const FINDS_CLEANUP_STAMP = "finds-v1";
if (bindings.findsCleanupStamp !== FINDS_CLEANUP_STAMP) {
  if (bindings.recentFinds?.length) bindings.recentFinds = [];
  bindings.findsCleanupStamp = FINDS_CLEANUP_STAMP;
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
  invalidateCheckCache();
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

// Usernames seen for each account id, and when (unix seconds). Telegram keeps
// no username history; this is what the bot itself has observed over time.
const UNAME_HISTORY_PATH = join(DATA_DIR, "telegram-username-history.json");
type UsernameSeen = { u: string; first: number; last: number };
const usernameHistory: Record<string, UsernameSeen[]> = readJson<Record<string, UsernameSeen[]>>(UNAME_HISTORY_PATH) || {};
let usernameHistoryTimer: ReturnType<typeof setTimeout> | null = null;

function noteUsername(id: string, username: string) {
  const u = (username || "").replace(/^@/, "").toLowerCase();
  if (!u || !/^\d{5,15}$/.test(id)) return;
  const now = Math.floor(Date.now() / 1000);
  const list = usernameHistory[id] || (usernameHistory[id] = []);
  const seen = list.find((e) => e.u === u);
  if (seen) {
    if (now - seen.last < 6 * 3600) return;
    seen.last = now;
  } else {
    list.push({ u, first: now, last: now });
    if (list.length > 12) list.splice(0, list.length - 12);
  }
  const ids = Object.keys(usernameHistory);
  if (ids.length > 40_000) for (const old of ids.slice(0, ids.length - 36_000)) delete usernameHistory[old];
  if (usernameHistoryTimer) return;
  usernameHistoryTimer = setTimeout(() => {
    usernameHistoryTimer = null;
    try {
      writeJsonAtomic(UNAME_HISTORY_PATH, usernameHistory);
    } catch {
      /* ignore */
    }
  }, 5000);
}

function rememberHandle(username: string, id: string) {
  const key = username.replace(/^@/, "").toLowerCase();
  if (!key || !id || !/^\d{5,15}$/.test(id)) return;
  noteUsername(id, key);
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

let rateSweepAt = 0;
function tooMany(key: string, max: number, windowMs: number) {
  const now = Date.now();
  // Old entries are swept at most once a minute (a sweep on every call would
  // walk the whole table for each request once many people use the bot).
  if (rateHits.size > 4000 && now - rateSweepAt > 60_000) {
    rateSweepAt = now;
    for (const [k, hits] of rateHits) {
      const keep = hits.filter((t) => now - t < 6 * 60 * 60 * 1000);
      if (!keep.length) rateHits.delete(k);
      else rateHits.set(k, keep);
    }
    if (rateHits.size > 200_000) rateHits.clear();
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

// Is this Telegram user banned (by id or username)? The owner never is.
export function isBannedUser(id?: string | number, username?: string): boolean {
  if (id != null && isOwner(id)) return false;
  const uid = id != null ? String(id) : "";
  const un = (username || "").replace(/^@/, "").toLowerCase();
  return (bindings.bannedUsers || []).some(
    (b) => (uid && b.id === uid) || (un && (b.username || "").toLowerCase() === un),
  );
}

// Signed mini-app user; banned users are treated as not signed in, which closes
// every app endpoint (complaints, checks, history) for them.
export function verifyTelegramInitData(initData: string): { id: string; username?: string; firstName?: string; lastName?: string } | null {
  const u = verifyInitDataRaw(initData);
  if (!u || isBannedUser(u.id, u.username)) return null;
  return u;
}

// For the app's access check: signed user plus whether they are banned.
export function appAccess(initData: string): { ok: boolean; banned: boolean } {
  const u = verifyInitDataRaw(initData);
  if (!u) return { ok: false, banned: false };
  return { ok: true, banned: isBannedUser(u.id, u.username) };
}

function verifyInitDataRaw(initData: string): { id: string; username?: string; firstName?: string; lastName?: string } | null {
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
    const user = JSON.parse(params.get("user") || "{}") as { id?: number; username?: string; first_name?: string; last_name?: string };
    if (!user?.id) return null;
    return {
      id: String(user.id),
      username: user.username,
      firstName: typeof user.first_name === "string" ? user.first_name : undefined,
      lastName: typeof user.last_name === "string" ? user.last_name : undefined,
    };
  } catch {
    return null;
  }
}

// At most 8 GB of uploads, and never more than 40 % of the disk (a small
// server's disk also holds the system and the bot's own data).
function evidenceMaxBytes(): number {
  const cap = 8 * 1024 * 1024 * 1024;
  try {
    const st = statfsSync(DATA_DIR);
    const disk = Number(st.blocks) * Number(st.bsize);
    return disk > 0 ? Math.min(cap, disk * 0.4) : cap;
  } catch {
    return cap;
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
    const maxBytes = evidenceMaxBytes();
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

// Upload volume budgets (bytes per hour) and a free-disk floor, so uploads can
// never fill the disk (a full disk would stop the bot from saving its data).
const UPLOAD_BYTES_USER = 1.5 * 1024 * 1024 * 1024;
const UPLOAD_BYTES_GLOBAL = 6 * 1024 * 1024 * 1024;
const MIN_FREE_DISK = 1.5 * 1024 * 1024 * 1024;
const uploadBytes = new Map<string, { at: number; n: number }[]>();

function overByteBudget(key: string, bytes: number, max: number): boolean {
  const now = Date.now();
  const list = (uploadBytes.get(key) || []).filter((e) => now - e.at < 60 * 60 * 1000);
  const used = list.reduce((sum, e) => sum + e.n, 0);
  if (used + bytes > max) {
    uploadBytes.set(key, list);
    return true;
  }
  list.push({ at: now, n: bytes });
  uploadBytes.set(key, list);
  if (uploadBytes.size > 20_000) uploadBytes.clear();
  return false;
}

let freeDiskAt = 0;
let freeDiskLow = false;
function diskTooFull(): boolean {
  if (Date.now() - freeDiskAt < 10_000) return freeDiskLow;
  freeDiskAt = Date.now();
  try {
    const st = statfsSync(DATA_DIR);
    freeDiskLow = Number(st.bavail) * Number(st.bsize) < MIN_FREE_DISK;
    if (freeDiskLow) pruneEvidenceDir();
  } catch {
    freeDiskLow = false;
  }
  return freeDiskLow;
}

function uploadBudgetError(userId: string, bytes: number): string | null {
  if (diskTooFull()) return "server busy";
  if (overByteBudget(`ub:${userId}`, bytes, UPLOAD_BYTES_USER)) return "too many uploads";
  if (overByteBudget("ub:global", bytes, UPLOAD_BYTES_GLOBAL)) return "server busy";
  return null;
}

export function allowEvidenceUpload(initData: string, bytes = 1): { ok: true; userId: string } | { ok: false; error: string } {
  if (bytes < 0) return { ok: false, error: "file required" };
  if (bytes > MAX_EVIDENCE_CHUNK) return { ok: false, error: "chunk too large" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`up:${user.id}`, 40, 60 * 60 * 1000)) return { ok: false, error: "too many uploads" };
  if (tooMany(`upchunk:${user.id}`, 600, 60 * 1000)) return { ok: false, error: "upload too fast" };
  if (tooMany("up:global", 2000, 60 * 60 * 1000)) return { ok: false, error: "server busy" };
  const budget = uploadBudgetError(user.id, bytes);
  if (budget) return { ok: false, error: budget };
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
  const budget = uploadBudgetError(user.id, bytes);
  if (budget) return { ok: false, error: budget };
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
// One refresh at a time: when the cache expires under load, every caller waits
// for the same refresh instead of each firing its own round of Telegram calls
// (which would get the bot rate-limited by Telegram).
let statsRefresh: Promise<{ chats: number; audience: number }> | null = null;
export async function sponsorStats(): Promise<{ chats: number; audience: number }> {
  if (statsCache && Date.now() - statsCache.at < 10 * 60 * 1000) return statsCache.value;
  if (!statsRefresh) statsRefresh = refreshSponsorStats().finally(() => (statsRefresh = null));
  return statsRefresh;
}

async function refreshSponsorStats(): Promise<{ chats: number; audience: number }> {
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

let sponsorsRefresh: Promise<SponsorItem[]> | null = null;
export async function listSponsors(): Promise<SponsorItem[]> {
  if (sponsorsCache && Date.now() - sponsorsCache.at < 10 * 60 * 1000) return sponsorsCache.value;
  if (!sponsorsRefresh) sponsorsRefresh = refreshSponsors().finally(() => (sponsorsRefresh = null));
  return sponsorsRefresh;
}

async function refreshSponsors(): Promise<SponsorItem[]> {
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

// Premium custom emoji are on by default (the owner has Premium); EPB_CUSTOM_EMOJI=0
// or the /emoji off command turns them off, and the runtime fallback below means
// they can never break a message either way.
function customEmojiEnabled(): boolean {
  if (typeof bindings.customEmoji === "boolean") return bindings.customEmoji;
  return process.env.EPB_CUSTOM_EMOJI === "0" ? false : true;
}

// Telegram private chats have positive ids; groups/channels are negative. Custom
// emoji here are only ever put in private-chat text, so this gates the transform.
function isPrivateChat(chatId: string | number): boolean {
  return Number(chatId) > 0;
}

function isCustomEmojiError(err: unknown): boolean {
  return err instanceof TgError && /emoji/i.test(err.message || "");
}

function isNotModified(err: unknown): boolean {
  return err instanceof TgError && /not modified/i.test(err.message || "");
}

// Plain emoji the bot writes in private chats that get a Premium icon when the
// owner's pack has one (status marks in checks, captcha, the account card).
const PACK_WANTED = [
  "✅", "✔️", "⛔", "⛔️", "🚫", "❌", "❗", "⏳", "⌛", "🔄", "🤖", "📛", "⚠️", "🔍", "🔎", "📍",
  "⭐", "▫️", "◽", "◽️", "⚪", "⚪️", "🔘", "🆔", "📅", "🗓", "🕐", "💬", "🔗", "ℹ️", "🎉", "🔒",
  // the member card's caption
  "🏆", "👑",
];
// which list the saved pack map was made for (a longer list looks the pack up again)
const PACK_SIG = PACK_WANTED.join("");
const noVs = (e: string) => e.replace(/\uFE0F/g, "");
let packLoading: Promise<void> | null = null;
let packFailedAt = 0;

// The pack is found from an icon already in use (getCustomEmojiStickers gives its
// set name), then read whole (getStickerSet). Cached for a week in bindings.
function loadPackEmoji(force = false): Promise<void> {
  const cached = bindings.packEmoji;
  if (cached?.map && !force) registerPackEmoji(cached.map);
  if (!botToken() || !customEmojiEnabled()) return Promise.resolve();
  if (!force && cached && cached.sig === PACK_SIG && Date.now() - cached.at < 7 * 86_400_000) return Promise.resolve();
  if (!force && Date.now() - packFailedAt < 3_600_000) return Promise.resolve();
  if (packLoading) return packLoading;
  packLoading = (async () => {
    try {
      const known = await tg<{ set_name?: string }[]>("getCustomEmojiStickers", { custom_emoji_ids: [CUSTOM_EMOJI["👤"]] });
      const set = known?.[0]?.set_name;
      if (!set) throw new Error("no set name");
      const pack = await tg<{ stickers?: { emoji?: string; custom_emoji_id?: string }[] }>("getStickerSet", { name: set });
      const byBase = new Map<string, string>();
      for (const st of pack?.stickers || []) {
        if (st.emoji && st.custom_emoji_id && !byBase.has(noVs(st.emoji))) byBase.set(noVs(st.emoji), st.custom_emoji_id);
      }
      const map: Record<string, string> = {};
      for (const want of PACK_WANTED) {
        const id = byBase.get(noVs(want));
        if (id) map[want] = id;
      }
      bindings.packEmoji = { at: Date.now(), set, map, sig: PACK_SIG };
      saveBindings();
      registerPackEmoji(map);
    } catch (err) {
      packFailedAt = Date.now();
      console.warn("[epb] emoji pack lookup failed:", err instanceof Error ? err.message : err);
    }
  })().finally(() => {
    packLoading = null;
  });
  return packLoading;
}
if (process.env.NODE_ENV !== "test") setTimeout(() => void loadPackEmoji(), 5_000).unref?.();

// The member card's renderer is made ready shortly after the start (and again
// when someone opens the menu, if it was stopped for being idle), so a card
// never waits for it.
let cardWarmAt = 0;
function warmCards() {
  if (process.env.NODE_ENV === "test" || Date.now() - cardWarmAt < 60_000) return;
  cardWarmAt = Date.now();
  void import("@/lib/member-gif.server").then((m) => m.warmUpCardRenderer()).catch((err) => console.error("[epb] card warm-up", err));
}
setTimeout(warmCards, 15_000).unref?.();

// First of the candidates that has a Premium icon (else the first one, plain).
function pickEmoji(...candidates: string[]): string {
  return candidates.find((e) => hasEmojiId(e)) || candidates[0]!;
}

// Sends a private-chat text message, upgrading known plain emoji to Premium
// custom emoji (in the text and as button icons). If Telegram rejects the custom
// emoji (e.g. premium lapsed), it resends once plain so the message is never
// lost. Behaves like tgSoft.
async function sendCeMessage(
  chatId: string | number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ message_id: number } | null> {
  if (customEmojiEnabled() && isPrivateChat(chatId)) {
    const richText = applyCustomEmoji(text);
    const markup = extra.reply_markup;
    if (hasCustomEmoji(richText) || markupHasIconableButton(markup)) {
      const richExtra = markup ? { ...extra, reply_markup: decorateButtons(markup, true) } : extra;
      try {
        return await tg("sendMessage", { chat_id: chatId, text: richText, parse_mode: "HTML", ...richExtra });
      } catch (err) {
        if (!isCustomEmojiError(err)) return null;
        // fall through to plain send
      }
    }
  }
  return tgSoft("sendMessage", { chat_id: chatId, text, ...extra });
}

// Rewrites an existing menu message in place (caption for the photo card, text
// otherwise) instead of sending a new one, so navigating the menu never clutters
// the chat. Falls back to plain emoji on rejection, and to a fresh message only
// if the old one can't be edited at all.
async function editCard(
  cb: NonNullable<TgUpdate["callback_query"]>,
  caption: string,
  reply_markup: unknown,
): Promise<void> {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (chatId == null || messageId == null) return;
  const isMedia = Boolean(cb.message?.photo || cb.message?.caption);
  const method = isMedia ? "editMessageCaption" : "editMessageText";
  const field = isMedia ? "caption" : "text";
  const build = (txt: string, markup: unknown) => ({
    chat_id: chatId,
    message_id: messageId,
    [field]: txt,
    parse_mode: "HTML",
    reply_markup: markup,
    ...(isMedia ? {} : { disable_web_page_preview: true }),
  });
  const useCe = customEmojiEnabled() && isPrivateChat(chatId);
  const richText = useCe ? applyCustomEmoji(caption) : caption;
  if (useCe && (hasCustomEmoji(richText) || markupHasIconableButton(reply_markup))) {
    try {
      await tg(method, build(richText, decorateButtons(reply_markup, true)));
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      if (!isCustomEmojiError(err)) {
        // not an emoji problem — fall through and try a plain edit
      }
    }
  }
  try {
    await tg(method, build(caption, reply_markup));
    return;
  } catch (err) {
    if (isNotModified(err)) return;
  }
  // The old message could not be edited (too old / deleted) — send a fresh one.
  await sendCeMessage(chatId, caption, { reply_markup });
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
if (bindings.cardStamp !== "new-bot-v4") {
  bindings.cards = {};
  bindings.cardStamp = "new-bot-v4";
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

// How the bot receives updates. "polling" (default): the server asks Telegram
// for updates itself, so the bot keeps working even when the mini-app domain is
// unreachable (DDoS on the domain, proxy or DNS trouble) — it needs no incoming
// traffic at all. "webhook": Telegram pushes updates to /api/telegram/webhook.
// Set TELEGRAM_UPDATES=webhook to switch back.
function updatesMode(): "polling" | "webhook" {
  return (process.env.TELEGRAM_UPDATES || "").trim().toLowerCase() === "webhook" ? "webhook" : "polling";
}

let pollingStarted = false;
const POLL_ALLOWED = ["message", "callback_query", "my_chat_member", "channel_post", "edited_channel_post"];

function startUpdatePolling() {
  if (pollingStarted || !botToken()) return;
  pollingStarted = true;
  void pollUpdatesForever();
}

async function pollUpdatesForever() {
  // A webhook and getUpdates can't both be active: remove the webhook first,
  // keeping any updates that are still waiting.
  await tgSoft("deleteWebhook", { drop_pending_updates: false });
  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 65_000);
      let data: { ok: boolean; result?: TgUpdate[]; error_code?: number; description?: string };
      try {
        const res = await fetch(`${botApi()}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset, timeout: 50, allowed_updates: POLL_ALLOWED }),
          signal: ctrl.signal,
        });
        data = (await res.json()) as typeof data;
      } finally {
        clearTimeout(timer);
      }
      if (!data.ok) {
        // 409: a webhook got set again (or another copy of the bot is polling).
        if (data.error_code === 409) await tgSoft("deleteWebhook", { drop_pending_updates: false });
        throw new Error(data.description || "getUpdates failed");
      }
      failures = 0;
      for (const update of data.result || []) {
        offset = Math.max(offset, update.update_id + 1);
        void handleUpdate(update).catch((err) => console.error("[epb] update", err));
      }
    } catch (err) {
      failures += 1;
      if (failures === 1 || failures % 20 === 0) console.error("[epb] polling:", err instanceof Error ? err.message : err);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}

async function ensureProductionWebhook() {
  const site = publicSiteUrl();
  if (!site) return;
  if (updatesMode() === "polling") {
    if (bindings.miniAppUrl !== site) {
      await registerMiniAppUrl(site);
    } else {
      await applyMenuButton();
      startUpdatePolling();
    }
    return;
  }
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
      // Telegram asks every app to use its own api_id. The owner's own keys (the
      // ones entered for the userbot) are used when set; the public desktop-client
      // keys are only a fallback.
      const own = userApiCreds();
      const apiId = own.apiId && own.apiHash ? own.apiId : 2040;
      const apiHash = own.apiId && own.apiHash ? own.apiHash : "b18441a1ff607e10a989891a5462e627";
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
  getMessages: (
    entity: unknown,
    opts: { search?: string; limit?: number; ids?: number[]; offsetId?: number; minId?: number },
  ) => Promise<{ id?: number; message?: string; date?: number }[]>;
};

// A public channel resolves by @username; a private one by its numeric id.
// getInputEntity wants the id as a number (a "-100…" string is mis-parsed as a
// username), so convert it; the dialog-list cache supplies the access hash.
function channelRef(channel: CheckChannel): string | number {
  if (channel.username) return `@${channel.username.replace(/^@/, "")}`;
  const n = Number(channel.id);
  return Number.isSafeInteger(n) ? n : channel.id;
}

// Server search first; if it returns nothing (tokenization quirks, etc.), scan
// the latest messages and filter locally so a recent post is still found.
type TgMsgLite = { id?: number; message?: string; date?: number };

// Telegram's server full-text search misses many posts (handles with digits,
// odd tokenization, indexing lag). Must be called as a method on the client —
// gramjs getMessages uses `this` internally (this.iterMessages).
// All userbot reads go through one queue with a small gap between calls, so a
// burst of checks can't flood the account (Telegram answers floods with
// FLOOD_WAIT and, if abused, restricts the account).
let userbotQueue: Promise<unknown> = Promise.resolve();
let userbotQueued = 0;
const USERBOT_GAP_MS = 350;
function paced<T>(fn: () => Promise<T>): Promise<T> {
  if (userbotQueued > 60) return Promise.reject(new Error("userbot busy"));
  userbotQueued += 1;
  const run = userbotQueue.then(async () => {
    try {
      return await fn();
    } finally {
      await new Promise((r) => setTimeout(r, USERBOT_GAP_MS));
    }
  });
  userbotQueue = run.catch(() => {}).finally(() => {
    userbotQueued -= 1;
  });
  return run;
}

async function serverSearch(client: UserClient, peer: unknown, query: string): Promise<TgMsgLite[]> {
  const c = client as unknown as UserClientSearch;
  return ((await paced(() => withTimeout(c.getMessages(peer, { search: searchQueryFor(query), limit: 60 }), 15_000, "search timeout"))) || []) as TgMsgLite[];
}

// Fallback when server search doesn't surface the post: read the channel's
// recent history and filter locally.
async function scanRecent(client: UserClient, peer: unknown, limit = 800): Promise<TgMsgLite[]> {
  const c = client as unknown as UserClientSearch;
  return ((await paced(() => withTimeout(c.getMessages(peer, { limit }), 45_000, "scan timeout"))) || []) as TgMsgLite[];
}

// The recent-history scan is independent of the search term, so cache it briefly
// per channel: one check searches by username AND id, and people re-check often.
const scanCache = new Map<string, { at: number; msgs: TgMsgLite[] }>();
const SCAN_TTL = 120_000;
async function scanRecentCached(client: UserClient, peer: unknown, channelKey: string): Promise<TgMsgLite[]> {
  const hit = scanCache.get(channelKey);
  if (hit && Date.now() - hit.at < SCAN_TTL) return hit.msgs;
  const msgs = await scanRecent(client, peer);
  scanCache.set(channelKey, { at: Date.now(), msgs });
  return msgs;
}

// Telegram's full-text search splits on underscores/punctuation, so a username
// like "black_art_services" as one token matches nothing. We search the
// word-tokenized form ("black art services" — posts containing all the words)
// and then keep only messages that actually contain the username/id.
function searchQueryFor(raw: string): string {
  const tokenized = raw.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return tokenized || raw;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The configured channels are dedicated scam/blacklist/tag channels, so a
// mentioned handle/id is the accused BY DEFAULT. Rather than trying to recognise
// the endless ways a report can be worded, we match any mention and only EXCLUDE
// the few clear non-accusation cases: a contact/dispute/ad footer line, the
// filer side of an arbitration, and known service handles. Easy to tune: add a
// word here to exclude more, remove one to match more.
const NON_ACCUSATION_LINE_RE =
  /(оспор|обжал|по\s*(всем\s*)?вопрос|для\s*связ|связ[ьи]|контакт|админ|administrator|\badmin\b|support|поддержк|dispute|appeal|помощ|реклам|сотруднич|менеджер|гарант|куп(лю|ить)|прод(ам|аж|ать)|прайс|услуг|сервис|магазин|\bshop\b|подписк|вступай|вступить|присоединя|заказать|скидк|акци|цен[аы]|\bcontact\b|\bdm\s+(me|us)\b|for\s+business|advertis|affiliate|promo\s*code|subscribe|join\s+(us|our)|discount|casino|giveaway|price\s*list)/iu;
// Strict channels (e.g. WWH) are NOT pure blacklists — they mix arbitrations with
// ad-stat rankings and other posts, so a bare mention there is often not an
// accusation. In strict mode a mention counts only with an accusation signal on
// the line (or the accused label just above it), plus arbitration lines.
const ACCUSATION_LINE_RE =
  /(скам|scam|кидал|кинул|кидок|мошен|обман|развод|афер|швыр|непорядочн|должник|на[её]б|обул|ответчик|обвиняем|виновник|respondent|defendant|fraud|scammer|ripper|ripped|\brip\b|stole|cheat|\bfake\b|beware|exit\s*scam|blocked\s+me|didn.?t\s+(pay|send|deliver|return)|never\s+(paid|sent|delivered|returned)|\bowes?\b|🚫|❌|🤡|⚠|🔴|🛑|📛|id\s*[:#]|айди)/iu;
// Does the post read like a blacklist entry at all? A post without accused
// fields only counts when it has some sign of a complaint somewhere: ads (a
// casino's "@rainbetcom", a shop promo) mention handles too, but none of this.
const SCAM_CONTEXT_RE =
  /(скам|scam|кидал|кинул|кидок|мошен|обман|развод|афер|швыр|непорядочн|должник|на[её]б|обул|ответчик|обвиняем|виновник|respondent|defendant|fraud|блек|black\s*list|blacklist|арбитраж|arbitra|жалоб|доказ|пруф|proof|ущерб|сумм[аы]|не\s+верн|не\s+отда|заблокировал|пропал|выдава\p{L}*\s+себя|под\s+видом|пострада\p{L}*|потерпевш\p{L}*|impersonat|ripper|ripped|\brip\b|stole|cheat|beware|warning|exit\s*scam|didn.?t\s+(pay|send|deliver|return)|never\s+(paid|sent|delivered|returned)|blocked\s+me|evidence|screenshots?|refund|chargeback|\bowes?\b|\bdebt|amount|🚫|❌|🤡|📛|🛑)/iu;
export function postHasScamContext(body: string): boolean {
  return SCAM_CONTEXT_RE.test(body || "");
}

// Someone named in a story who is NOT the scammer: right after (or in a list
// right after) "impersonated", "scammed" (the victim), "credits to", "thanks
// to", "send it to", "contact", "victim", "middlemen like", "выдавал себя за",
// "спасибо", "пишите"… e.g. "He impersonated @nine, @cupid", "Please send it to
// @investigator". ("scammed by @x" still accuses @x.)
const NOT_ACCUSED_CUE =
  "impersonat\\w*|pretend\\w*\\s+to\\s+be|posing\\s+as|credits?(?:\\s+go(?:es)?)?\\s+to|thanks?(?:\\s+to)?|thank\\s+you|shout\\s*outs?\\s+to|" +
  "send\\s+(?:it|them|this|(?:all\\s+)?info\\w*|proofs?|evidence)?\\s*to|contact|reach\\s+out\\s+to|message|\\bdm|write\\s+to|report\\s+(?:it\\s+|them\\s+)?to|" +
  "provided\\s+by|helped\\s+by|victims?|middlem[ae]n(?:\\s+like)?|escrow|scammed|ripped|" +
  "выдава\\p{L}*\\s+себя\\s+за|представля\\p{L}*\\s+(?:себя\\s+)?(?:как\\s+)?|под\\s+видом|от\\s+имени|прикрыва\\p{L}*(?:\\s+\\p{L}+)?|" +
  "жертв\\p{L}*|пострадавш\\p{L}*|потерпевш\\p{L}*|заявител\\p{L}*|истц\\p{L}*|истец|автор\\p{L}*|свидетел\\p{L}*|" +
  "гарант\\p{L}*(?:\\s+сделки)?|посредник\\p{L}*|через\\s+(?:гаранта|посредника)|по\\s+рекомендаци\\p{L}*|" +
  "спасибо|благодар\\p{L}*|с\\s+помощью|помог\\p{L}*|предостав\\p{L}*|" +
  "пишите(?:\\s+(?:в|на))?|писать|обращайтесь(?:\\s+к)?|присылайте(?:\\s+(?:в|на))?|отправляйте(?:\\s+(?:в|на))?|" +
  "подписывайтесь(?:\\s+на)?|переходите(?:\\s+(?:в|на))?|вступайте(?:\\s+в)?|наш\\p{L}*\\s+(?:канал|чат|бот)\\p{L}*|" +
  "по\\s+(?:всем\\s+)?вопросам|контакт\\p{L}*|связь|связаться(?:\\s+с)?|админ\\p{L}*|модератор\\p{L}*|оспорить(?:\\s+можно)?(?:\\s+(?:у|через))?";
const NOT_ACCUSED_BEFORE_RE = new RegExp(
  `(?:^|[^\\p{L}])(?:${NOT_ACCUSED_CUE})\\s*:?\\s*(?:@[A-Za-z0-9_]+[’'s]*\\s*(?:,|and|&|и|или)?\\s*)*@?$`,
  "iu",
);
// The sentence around position `at` in a line, and the part of it before `at`.
function sentencePrefix(line: string, at: number): string {
  const before = line.slice(0, at);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  return cut >= 0 ? before.slice(cut + 2) : before;
}
function notAccusedHere(line: string, at: number): boolean {
  return at >= 0 && NOT_ACCUSED_BEFORE_RE.test(sentencePrefix(line, at));
}

// Russian word endings use \p{L}: in JS regexps \w matches Latin letters only.
const ACCUSED_LABEL_RE =
  /^(?:[📛🚫❌🤡⚠🔴🛑‼️\s])*(?:ответчик\p{L}*|обвиняем\p{L}*|скамер\p{L}*|кидал\p{L}*|мошенни\p{L}*|виновни\p{L}*|respondent|defendant|scammer|fraudster|ripper|accused|offender)\s*:?\s*$/iu;

function isStrictChannel(channel: CheckChannel): boolean {
  return /wwh/i.test(channel.title || "") || /wwh/i.test(channel.username || "");
}

// Known arbiter / service / off-limits handles that are never the accused party
// and never shown in search results.
const IGNORE_USERNAMES = new Set(["europepromo", "ctoroot", "sbepbank", BOT_USERNAME.toLowerCase()]);

function isIgnoredHandle(uname: string): boolean {
  return IGNORE_USERNAMES.has((uname || "").replace(/^@/, "").toLowerCase());
}

function usernameOnLine(line: string, uname: string): boolean {
  if (!uname) return false;
  return new RegExp("@?(?<!\\w)" + escapeRe(uname) + "(?!\\w)", "iu").test(line);
}

// A forum nickname (WWH nicknames may contain spaces): case-insensitive, whole
// words, and a space, "_", "." or "-" between its words all count as the same.
function nickPattern(nick: string): RegExp | null {
  const words = (nick || "").toLowerCase().split(/[\s_.\-]+/u).filter(Boolean);
  if (!words.length) return null;
  return new RegExp("(?<![\\p{L}\\p{N}_])@?" + words.map(escapeRe).join("[\\s_.\\-]+") + "(?![\\p{L}\\p{N}_])", "iu");
}

function nickOnLine(line: string, nick: string): boolean {
  const re = nickPattern(nick);
  return Boolean(re && re.test(line));
}

// "Ответчик: X", "Скамер — X", "Respondent: X": an accused label right before
// the name on the same line.
const ACCUSED_PREFIX_RE =
  /(?:ответчик\p{L}*|обвиняем\p{L}*|скамер\p{L}*|кидал\p{L}*|мошенни\p{L}*|виновни\p{L}*|respondent|defendant|scammer|fraudster|ripper|accused|offender)\s*[:\-—–]\s*@?\s*$/iu;

function idOnLine(line: string, id: string): boolean {
  const digits = (id || "").replace(/\D/g, "");
  if (digits.length < 5) return false;
  return new RegExp("(?<!\\d)" + digits + "(?!\\d)").test(line);
}

// Arbitration posts (e.g. WWH Info) name both sides on one line:
//   "Арбитраж пользователя <заявитель> на пользователя <обвиняемый>".
// Only the accused — the side after "на [пользователя]" / "против" / "on" /
// "against" — should be flagged, never the person who filed.
function arbitrationAccused(line: string, strict = false): string {
  // Strict (WWH): the accused must follow an explicit "на пользователя" /
  // "on user" / "@", so ad lines with a stray "на"/"on" never qualify.
  const marker = strict
    ? "(?:пользовател\\S*\\s+|юзер\\S*\\s+|user\\s+|@)"
    : "(?:пользовател\\S*\\s+|юзер\\S*\\s+|человек\\S*\\s+|аккаунт\\S*\\s+|user\\s+|@)?";
  const m = line.match(
    new RegExp("(?:^|\\s)(?:на|против|on|against)\\s+" + marker + "(.+)$", "i"),
  );
  if (!m) return "";
  // Drop a trailing filer clause ("… от @reporter", "… from @x", "… заявитель …").
  return m[1].split(/\s+(?:от|from|by|заявител\S*|подал\S*|reporter)\s+/i)[0] || "";
}

// Does this post accuse `username`/`id`? In a pure blacklist channel any mention
// counts (loose); in a strict channel only a structured accusation does.
// Exported for tests.
// Most blacklist posts name the accused in a field — "Кидала: @x", "Тег: @x",
// "ID: 123", or card lines like "👤 123" / "🌐 @x" — and mention other people
// (the garant, who recommended them, a group) only inside the story. When a post
// has such fields, only the people in them are accused.
const INVISIBLE_RE = /[\u200B-\u200F\u2060-\u206F\uFE0E\uFE0F]/g;
const NAME_TOKEN_RE = /@([A-Za-z][A-Za-z0-9_]{3,31})|(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})|(?<![\d/.,])(\d{5,15})(?![\d/,%$€₽]|\.\d)/gi;
// Field labels that are not about the accused (and amounts/dates).
const FIELD_NOT_ACCUSED_RE =
  /(гарант|заявител|истец|пострадавш|жертв|автор|свидетел|рекоменд|связ|контакт|админ|модер|владел|owner|канал|чат|групп|предложк|вопрос|оспор|обжал|support|поддержк|реклам|менеджер|наш|подпис|сумм|ущерб|amount|цен|дат|обновл|итог|оплат|телефон|карт|guarant|escrow|middleman|^mm$|victim|reporter|report|submitted|author|witness|recommend|contact|admin|moder|channel|^chat$|group|question|appeal|dispute|^ads?$|advertis|promo|manager|^our$|subscri|price|^date$|updated|total|payment|paid|phone|^card$|lost|damage|sum$)/iu;

function nameTokens(line: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  for (const m of line.matchAll(NAME_TOKEN_RE)) {
    const value = m[1] || m[2] ? `@${(m[1] || m[2])!.toLowerCase()}` : m[3]!;
    out.push({ value, index: m.index || 0 });
  }
  return out;
}

// The last line of a post, after a blank line, holding nothing but one @handle
// or link: the channel's signature, not a person being reported.
function signatureLineIndex(lines: string[]): number {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  if (last <= 0 || lines[last - 1]!.trim()) return -1;
  const line = lines[last]!.replace(INVISIBLE_RE, "");
  if (nameTokens(line).length !== 1) return -1;
  return line.replace(NAME_TOKEN_RE, "").replace(/[\s\p{P}\p{S}]/gu, "") ? -1 : last;
}

// Names standing in accused fields of the post (empty: the post has no fields).
// The channel's own @handle and a lone signature line at the end of the post
// ("…\n\n@channel") are not fields.
function accusedFields(body: string, selfHandle = ""): Set<string> {
  const fields = new Set<string>();
  const self = selfHandle ? `@${selfHandle.replace(/^@/, "").toLowerCase()}` : "";
  const lines = body.split(/\r?\n/);
  const sig = signatureLineIndex(lines);
  // "Label: @x" fields count only in a post that reads like a complaint (an ad's
  // "Contact: @shop" is not a field); a bare "@x" line still does.
  const complaint = postHasScamContext(body);
  for (let i = 0; i < lines.length; i++) {
    if (i === sig) continue;
    const line = lines[i]!.replace(INVISIBLE_RE, "");
    const tokens = nameTokens(line).filter((t) => t.value !== self);
    if (!tokens.length) continue;
    const prefix = line
      .slice(0, tokens[0]!.index)
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u20E3]/gu, " ")
      .replace(/[^\p{L}\p{N}\s:\-—–]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const label = prefix.replace(/[:\-—–\s]+$/u, "").trim();
    const hasSep = /[:\-—–]$/u.test(prefix);
    // "@x …" / "👤 123" (nothing before the name) or a short "Label: @x".
    const isField = !label || (hasSep && label.split(" ").length <= 3);
    // The label's first word decides: "Гарант кидалы:" is the garant, "Кидала из
    // чата:" is the scammer.
    if (!isField || (label && FIELD_NOT_ACCUSED_RE.test(label.split(" ")[0]!))) continue;
    if (label && !complaint) continue;
    for (const t of tokens) fields.add(t.value);
  }
  return fields;
}

// `nick` is a forum nickname typed as free text (may contain spaces); it is only
// ever matched strictly (arbitration accused side or an accused label), since a
// plain word would otherwise match unrelated posts.
export function postMatchesSubject(body: string, username: string, id: string, strict = false, nick = "", selfHandle = ""): boolean {
  const uname = (username || "").replace(/^@/, "").toLowerCase();
  // A channel's own @handle (its signature under every post) is never the accused.
  if (uname && selfHandle && uname === selfHandle.replace(/^@/, "").toLowerCase()) return false;
  const ignoredName = !uname || IGNORE_USERNAMES.has(uname);
  const nickName = (nick || "").trim();
  if (nickName && !uname && !id) strict = true;
  // Nothing to match on (handle is an off-limits/service handle and no id given).
  if (ignoredName && !id && !nickName) return false;
  const named = (text: string) =>
    (!ignoredName && usernameOnLine(text, uname)) || idOnLine(text, id) || (Boolean(nickName) && nickOnLine(text, nickName));
  // A post with accused fields (plain blacklist channels): the people in the
  // fields are accused; anyone else only by a one-name line with an accusation
  // word (checked in the loop below).
  const fields = strict ? new Set<string>() : accusedFields(body, selfHandle);
  const structured = fields.size > 0;
  if (structured) {
    const idDigits0 = (id || "").replace(/\D/g, "");
    if ((!ignoredName && fields.has(`@${uname}`)) || (idDigits0.length >= 5 && fields.has(idDigits0))) return true;
  }
  let labelAbove = false;
  const rawLines = body.split(/\r?\n/);
  const sigLine = strict ? -1 : signatureLineIndex(rawLines);
  // Plain channels: a story line often has several sentences about different
  // people ("@a is a scammer. He is a friend of @b, another scammer."), so each
  // sentence is judged on its own.
  const allLines: string[] = [];
  rawLines.forEach((l, i) => {
    if (i === sigLine) return;
    if (strict) allLines.push(l);
    else allLines.push(...l.split(/(?<=[.!?])\s+(?=\S)/u));
  });
  for (let li = 0; li < allLines.length; li++) {
    const line = allLines[li]!;
    // Arbitration lines: match only the accused side, never the filer (both modes).
    // In strict channels an explicit "X на пользователя Y" / "X on user Y" line is
    // an arbitration line even without the word "арбитраж" on it.
    const strictArb = strict && Boolean(arbitrationAccused(line, true));
    if (strictArb || /арбитраж|arbitr/i.test(line)) {
      const accused = arbitrationAccused(line, strict);
      if (accused && named(accused)) return true;
      if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
      continue;
    }
    const hasId = idOnLine(line, id);
    const hasU = !ignoredName && usernameOnLine(line, uname);
    const hasNick = Boolean(nickName) && nickOnLine(line, nickName);
    if (!hasId && !hasU && !hasNick) {
      if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
      continue;
    }
    // named here as a victim, the impersonated one, a helper or a contact
    if (!strict && (hasU || hasId)) {
      const re = hasU ? new RegExp("@?(?<!\\w)" + escapeRe(uname) + "(?!\\w)", "iu") : new RegExp("(?<!\\d)" + (id || "").replace(/\D/g, "") + "(?!\\d)");
      if (notAccusedHere(line, line.search(re))) {
        if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
        continue;
      }
    }
    // "Ответчик: X" on one line: the label right before the name is enough.
    {
      const re = hasU
        ? new RegExp("@?(?<!\\w)" + escapeRe(uname) + "(?!\\w)", "iu")
        : hasNick
          ? nickPattern(nickName)
          : new RegExp("(?<!\\d)" + (id || "").replace(/\D/g, "") + "(?!\\d)");
      const at = re ? line.search(re) : -1;
      const before = at > 0 ? line.slice(0, at) : "";
      const firstWord = before.replace(INVISIBLE_RE, "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/)[0] || "";
      // ...unless the label is about someone else ("Гарант кидалы: @x").
      if (at > 0 && ACCUSED_PREFIX_RE.test(before) && !(firstWord && FIELD_NOT_ACCUSED_RE.test(firstWord))) return true;
    }
    if (hasNick && !hasId && !hasU) {
      // a nickname alone needs the accused label above it (strict rules)
      if (labelAbove) return true;
      if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
      continue;
    }
    // Strip the matched handle/id from the line so keywords INSIDE it (e.g. the
    // "fraud" in @HARRYFRAUD) don't count as an accusation or a footer word.
    let rest = line;
    if (uname) rest = rest.replace(new RegExp("@?" + escapeRe(uname), "ig"), " ");
    const idDigits = (id || "").replace(/\D/g, "");
    if (idDigits.length >= 5) rest = rest.replace(new RegExp(idDigits, "g"), " ");
    if (structured) {
      // In a post with fields, a name inside the story counts only when it is
      // the only name on the line and the line accuses ("его второй акк @x тоже
      // кинул"), never "по рекомендации @a и @b обратился к @c".
      // (an id next to the handle on the same line usually is that account's id)
      const lineTokens = nameTokens(line.replace(INVISIBLE_RE, ""));
      const own = (v: string) => v === `@${uname}` || v === idDigits;
      const others = lineTokens.filter((t) => !own(t.value));
      const single = others.length === 0 || (lineTokens.length <= 2 && others.every((t) => !t.value.startsWith("@")));
      if (single && ACCUSATION_LINE_RE.test(rest) && !NON_ACCUSATION_LINE_RE.test(rest)) return true;
      if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
      continue;
    }
    // A contact/dispute/ad footer line is never an accusation (both modes).
    if (!NON_ACCUSATION_LINE_RE.test(rest)) {
      // pure blacklist channel: a mention is an accusation — in a post that is a
      // complaint at all (not an ad that happens to sit in the channel)
      if (!strict && postHasScamContext(body)) return true;
      // strict channel: require an accusation signal on the line or the label above it
      if (labelAbove) return true; // strict: arbitrations + "Ответчик:" only
    }
    if (line.trim()) labelAbove = ACCUSED_LABEL_RE.test(line);
  }
  return false;
}

async function userSearchChannel(
  channel: CheckChannel,
  query: string,
  subject: { username: string; id: string; nick?: string },
  skipScan = false,
): Promise<CheckHit[]> {
  if (Date.now() < userBlockedUntil) return [];
  try {
    const { client } = await userbot();
    const peer = await userInputPeer(client, channelRef(channel));
    const strict = isStrictChannel(channel);
    // Merge the server full-text search (reaches old posts) with a cached scan of
    // recent history (covers what Telegram's FTS misses). Dedup by message id.
    const byId = new Map<number, TgMsgLite>();
    for (const m of await serverSearch(client, peer, query)) if (m.id) byId.set(m.id, m);
    if (!skipScan) for (const m of await scanRecentCached(client, peer, chatIdKey(channel.id))) if (m.id) byId.set(m.id, m);
    const out: CheckHit[] = [];
    for (const m of byId.values()) {
      const body = m.message || "";
      if (!m.id || !body || !postMatchesSubject(body, subject.username, subject.id, strict, subject.nick, channel.username)) continue;
      out.push({
        channelId: channel.id,
        channelTitle: channel.title || "канал",
        messageId: m.id,
        link: messageLink(channel, m.id),
        date: (m.date || 0) * 1000,
        snippet: snippetAround(body, subject.username || subject.id || subject.nick || ""),
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

// ---- Local copy ("mirror") of the check channels ----
// Live search per check was slow (two Telegram searches plus an 800-post scan
// per channel, all queued to stay under Telegram's limits: up to ~30 s) and
// missed old posts (Telegram's own search skips many, the scan only reached the
// latest 800). Instead the userbot copies each check channel's whole history
// once, in the background, keeps it current (new posts every minute, the latest
// posts re-read every few hours for edits and deletions), and a check searches
// that copy locally in milliseconds. Hits are confirmed with one request before
// they are shown, so a deleted post never shows up.
const MIRROR_DIR = join(DATA_DIR, "check-mirror");
const MIRROR_MAX_MSGS = 80_000; // per channel
const MIRROR_TEXT_MAX = 4096;
const MIRROR_UPDATE_MS = 60_000;
const MIRROR_REFRESH_MS = 6 * 60 * 60_000;
const MIRROR_REFRESH_PAGES = 3; // x100 latest posts re-read
const MIRROR_VERIFY_MS = 30 * 60_000;

// acc: the accused names in the post, parsed once ("@a 12345"; "" = none).
type MirrorMsg = { id: number; date: number; text: string; low: string; acc?: string };
type Mirror = {
  key: string;
  complete: boolean;
  msgs: Map<number, MirrorMsg>;
  oldest: number;
  newest: number;
  updatedAt: number;
  refreshedAt: number;
  dirty: boolean;
  savedAt: number;
  version: number; // bumped on every change (admin stats are cached per version)
  // word -> post ids containing it (latin words, handles, ids; 5+ chars), built
  // on first search, then kept up to date as posts arrive
  index?: Map<string, number[]>;
};
type MirrorFile = {
  v: 1;
  complete: boolean;
  oldest: number;
  newest: number;
  updatedAt: number;
  refreshedAt: number;
  msgs: [number, number, string][];
};
type MirrorFetchOpts = { limit?: number; offsetId?: number; minId?: number; ids?: number[] };

const mirrors = new Map<string, Mirror>();
const mirrorVerified = new Map<string, number>();
const mirrorErrorUntil = new Map<string, number>();

function touchMirror(m: Mirror) {
  m.dirty = true;
  m.version += 1;
}

function mirrorPath(key: string) {
  return join(MIRROR_DIR, `${key.replace(/[^0-9A-Za-z_-]/g, "")}.json`);
}

function putMirrorMsg(m: Mirror, id: number, date: number, text: string) {
  if (!id) return;
  m.oldest = m.oldest ? Math.min(m.oldest, id) : id;
  m.newest = Math.max(m.newest, id);
  const body = (text || "").slice(0, MIRROR_TEXT_MAX);
  if (!body.trim()) {
    if (m.msgs.delete(id)) touchMirror(m);
    return;
  }
  const prev = m.msgs.get(id);
  if (prev && prev.text === body) return;
  const msg = { id, date: date || prev?.date || 0, text: body, low: body.toLowerCase() };
  m.msgs.set(id, msg);
  indexPost(m, msg);
  touchMirror(m);
}

function loadMirror(channel: CheckChannel): Mirror {
  const key = chatIdKey(channel.id);
  const have = mirrors.get(key);
  if (have) return have;
  const m: Mirror = { key, complete: false, msgs: new Map(), oldest: 0, newest: 0, updatedAt: 0, refreshedAt: 0, dirty: false, savedAt: 0, version: 0 };
  const file = readJson<MirrorFile>(mirrorPath(key));
  if (file?.v === 1 && Array.isArray(file.msgs)) {
    for (const [id, date, text] of file.msgs) putMirrorMsg(m, id, date, text);
    m.complete = Boolean(file.complete);
    m.oldest = file.oldest || m.oldest;
    m.newest = Math.max(file.newest || 0, m.newest);
    m.updatedAt = file.updatedAt || 0;
    m.refreshedAt = file.refreshedAt || 0;
    m.dirty = false;
  }
  mirrors.set(key, m);
  return m;
}

function saveMirror(m: Mirror, force = false) {
  if (!m.dirty && !force) return;
  if (!force && Date.now() - m.savedAt < 20_000) return;
  // Keep the newest posts if a channel is huge.
  if (m.msgs.size > MIRROR_MAX_MSGS) {
    const ids = [...m.msgs.keys()].sort((a, b) => b - a);
    for (const id of ids.slice(MIRROR_MAX_MSGS)) m.msgs.delete(id);
    m.oldest = ids[MIRROR_MAX_MSGS - 1] || m.oldest;
    m.complete = true;
  }
  try {
    const msgs = [...m.msgs.values()].sort((a, b) => b.id - a.id).map((x) => [x.id, x.date, x.text] as [number, number, string]);
    const file: MirrorFile = { v: 1, complete: m.complete, oldest: m.oldest, newest: m.newest, updatedAt: m.updatedAt, refreshedAt: m.refreshedAt, msgs };
    writeJsonAtomic(mirrorPath(m.key), file);
    m.dirty = false;
    m.savedAt = Date.now();
  } catch {
    /* disk trouble: keep it in memory, try again next time */
  }
}

function dropMirror(channelId: string) {
  const key = chatIdKey(channelId);
  mirrors.delete(key);
  accusedCache.delete(key);
  try {
    if (existsSync(mirrorPath(key))) unlinkSync(mirrorPath(key));
  } catch {
    /* ignore */
  }
}

let mirrorFetch = async (channel: CheckChannel, opts: MirrorFetchOpts): Promise<(TgMsgLite & { className?: string } | undefined)[]> => {
  const { client } = await userbot();
  const peer = await userInputPeer(client, channelRef(channel));
  const c = client as unknown as UserClientSearch;
  return ((await paced(() => withTimeout(c.getMessages(peer, opts), 30_000, "mirror timeout"))) || []) as TgMsgLite[];
};
// Tests swap in a fake channel history.
export function __setMirrorFetchForTests(fn: typeof mirrorFetch) {
  mirrorFetch = fn;
}

function realMessages(page: (TgMsgLite & { className?: string } | undefined)[]) {
  return page.filter((x): x is TgMsgLite => Boolean(x && x.id && (x as { className?: string }).className !== "MessageEmpty"));
}

// Older history, 100 posts per request, newest first.
async function mirrorBackfill(channel: CheckChannel, m: Mirror) {
  const page = realMessages(await mirrorFetch(channel, { limit: 100, offsetId: m.oldest || 0 }));
  if (!m.newest && page.length) m.updatedAt = Date.now();
  for (const x of page) putMirrorMsg(m, x.id!, x.date || 0, x.message || "");
  if (!page.length || m.msgs.size >= MIRROR_MAX_MSGS) m.complete = true;
  if (page.length) invalidateCheckCache();
  saveMirror(m, m.complete);
}

// Posts newer than the newest one we have.
async function mirrorUpdate(channel: CheckChannel, m: Mirror) {
  const minId = m.newest;
  let offsetId = 0;
  let added = 0;
  for (let i = 0; i < 10; i++) {
    const page = realMessages(await mirrorFetch(channel, { limit: 100, minId, offsetId }));
    for (const x of page) putMirrorMsg(m, x.id!, x.date || 0, x.message || "");
    added += page.length;
    if (page.length < 100) break;
    offsetId = Math.min(...page.map((x) => x.id!));
  }
  m.updatedAt = Date.now();
  if (added) invalidateCheckCache();
  saveMirror(m);
}

// Re-read the latest posts: picks up edits, and drops posts deleted since.
async function mirrorRefresh(channel: CheckChannel, m: Mirror) {
  const seen = new Set<number>();
  let offsetId = 0;
  let low = Infinity;
  for (let i = 0; i < MIRROR_REFRESH_PAGES; i++) {
    const page = realMessages(await mirrorFetch(channel, { limit: 100, offsetId }));
    for (const x of page) {
      seen.add(x.id!);
      putMirrorMsg(m, x.id!, x.date || 0, x.message || "");
      low = Math.min(low, x.id!);
    }
    if (page.length < 100) break;
    offsetId = low;
  }
  if (seen.size) {
    for (const id of [...m.msgs.keys()]) {
      if (id >= low && !seen.has(id)) {
        m.msgs.delete(id);
        touchMirror(m);
      }
    }
  }
  m.refreshedAt = Date.now();
  invalidateCheckCache();
  saveMirror(m, true);
}

function mirrorWork(channel: CheckChannel): "update" | "backfill" | "refresh" | null {
  if (Date.now() < (mirrorErrorUntil.get(chatIdKey(channel.id)) || 0)) return null;
  const m = loadMirror(channel);
  if (m.newest && Date.now() - m.updatedAt > MIRROR_UPDATE_MS) return "update";
  if (!m.complete) return "backfill";
  if (Date.now() - m.refreshedAt > MIRROR_REFRESH_MS) return "refresh";
  return null;
}

// Our own channel, so posts written there by hand (not filed through the bot)
// are found too. Searched like a plain blacklist channel.
function epbCheckChannel(): CheckChannel | null {
  const id = bindings.channelId || PINNED_CHANNEL;
  return id ? { id: String(id), title: CHANNEL_NAME, addedAt: 0 } : null;
}

function mirrorChannels(): CheckChannel[] {
  const list = [...checkChannels()];
  const epb = epbCheckChannel();
  if (epb && !list.some((c) => sameChat(c.id, epb.id))) list.push(epb);
  return list;
}

// One small step at a time, only while no check is waiting for the userbot, so
// the copy never slows a real search down.
let mirrorBusy = false;
export async function mirrorTick(maxSteps = 3): Promise<number> {
  if (mirrorBusy || !hasUserbot() || !checkEnabled()) return 0;
  mirrorBusy = true;
  let steps = 0;
  try {
    const channels = mirrorChannels();
    const keep = new Set(channels.map((c) => chatIdKey(c.id)));
    for (const key of [...mirrors.keys()]) if (!keep.has(key)) dropMirror(key);
    for (; steps < maxSteps; steps++) {
      if (Date.now() < userBlockedUntil || userbotQueued > 0) break;
      // updates first (freshness), then history, then the periodic re-read
      let pick: { ch: CheckChannel; work: "update" | "backfill" | "refresh" } | null = null;
      for (const want of ["update", "backfill", "refresh"] as const) {
        const ch = channels.find((c) => mirrorWork(c) === want);
        if (ch) {
          pick = { ch, work: want };
          break;
        }
      }
      if (!pick) break;
      const m = loadMirror(pick.ch);
      try {
        if (pick.work === "update") await mirrorUpdate(pick.ch, m);
        else if (pick.work === "backfill") await mirrorBackfill(pick.ch, m);
        else await mirrorRefresh(pick.ch, m);
      } catch (err) {
        const wait = floodSeconds(err);
        if (wait) {
          userBlockedUntil = Date.now() + (wait + 5) * 1000;
          console.warn(`[epb] userbot FLOOD_WAIT ${wait}s (channel copy)`);
          break;
        }
        // This channel can't be read right now (left, private, timeout): retry later.
        mirrorErrorUntil.set(m.key, Date.now() + 15 * 60_000);
        if (!(err as { errorMessage?: string })?.errorMessage && /timeout|no user session|connect/i.test(String((err as Error)?.message))) {
          dropUserbot();
          break;
        }
      }
    }
  } finally {
    mirrorBusy = false;
  }
  return steps;
}

// A post the bot itself received (it is a member of the channel): into the copy
// right away, without waiting for the next update.
function mirrorAddPost(channel: CheckChannel, messageId: number, text: string, date: number) {
  const m = mirrors.get(chatIdKey(channel.id)) || (existsSync(mirrorPath(chatIdKey(channel.id))) ? loadMirror(channel) : null);
  if (!m) return;
  putMirrorMsg(m, messageId, date, text);
  saveMirror(m);
}

// Search one channel's copy.
function searchMirror(channel: CheckChannel, m: Mirror, subject: { username: string; id: string; nick: string }): CheckHit[] {
  const strict = isStrictChannel(channel);
  const needles: string[] = [];
  if (subject.username) needles.push(subject.username.toLowerCase());
  const digits = (subject.id || "").replace(/\D/g, "");
  if (digits.length >= 5) needles.push(digits);
  if (subject.nick) {
    const words = subject.nick.toLowerCase().split(/[\s_.\-]+/u).filter(Boolean);
    const longest = words.sort((a, b) => b.length - a.length)[0];
    if (longest) needles.push(longest);
  }
  if (!needles.length) return [];
  const out: CheckHit[] = [];
  // a forum nickname can be written many ways: those searches read every post
  for (const msg of subject.nick ? m.msgs.values() : mirrorCandidates(m, needles)) {
    if (!needles.some((n) => msg.low.includes(n))) continue;
    if (!postMatchesSubject(msg.text, subject.username, subject.id, strict, subject.nick, channel.username)) continue;
    out.push({
      channelId: channel.id,
      channelTitle: channel.title || "канал",
      messageId: msg.id,
      link: messageLink(channel, msg.id),
      date: (msg.date || 0) * 1000,
      snippet: snippetAround(msg.text, subject.username || subject.id || subject.nick),
    });
  }
  return out;
}

// A word index of a copy, so a search by @username or ID looks at the few posts
// that contain it instead of every post. Deleted/edited posts may leave stale
// ids behind; candidates are always re-checked against the current text.
const INDEX_WORD_RE = /[a-z0-9_]{5,}/g;
function indexPost(m: Mirror, msg: MirrorMsg) {
  if (!m.index) return;
  // digit runs on their own too ("id9300777" is found by 9300777)
  for (const w of new Set([...(msg.low.match(INDEX_WORD_RE) || []), ...(msg.low.match(/\d{5,}/g) || [])])) {
    const list = m.index.get(w);
    if (list) list.push(msg.id);
    else m.index.set(w, [msg.id]);
  }
}
function mirrorIndex(m: Mirror): Map<string, number[]> {
  if (!m.index) {
    m.index = new Map();
    for (const msg of m.msgs.values()) indexPost(m, msg);
  }
  return m.index;
}
// The posts that may mention any of the needles: from the index when every
// needle is an indexable word, otherwise (a Cyrillic nickname, a short word)
// all posts.
function mirrorCandidates(m: Mirror, needles: string[]): Iterable<MirrorMsg> {
  if (!needles.length || !needles.every((n) => /^[a-z0-9_]{5,}$/.test(n))) return m.msgs.values();
  const idx = mirrorIndex(m);
  const ids = new Set<number>();
  for (const n of needles) for (const id of idx.get(n) || []) ids.add(id);
  const out: MirrorMsg[] = [];
  for (const id of ids) {
    const msg = m.msgs.get(id);
    if (msg) out.push(msg);
  }
  return out;
}

// Confirm hits from the copy with one request: deleted posts are dropped (and
// removed from the copy), edited ones re-checked. If Telegram can't be asked
// right now, the copy is trusted.
async function confirmMirrorHits(
  channel: CheckChannel,
  m: Mirror,
  hits: CheckHit[],
  subject: { username: string; id: string; nick: string },
): Promise<CheckHit[]> {
  const now = Date.now();
  const need = hits
    .map((h) => h.messageId)
    .filter((id) => now - (mirrorVerified.get(`${m.key}:${id}`) || 0) > MIRROR_VERIFY_MS)
    .slice(0, 100);
  // no search account (switched off): the saved copy is trusted as it is
  if (!need.length || now < userBlockedUntil || !hasUserbot()) return hits;
  try {
    const got = realMessages(await mirrorFetch(channel, { ids: need }));
    const alive = new Map(got.map((x) => [x.id!, x]));
    const strict = isStrictChannel(channel);
    const dropped = new Set<number>();
    for (const id of need) {
      const x = alive.get(id);
      if (!x) {
        m.msgs.delete(id);
        touchMirror(m);
        dropped.add(id);
        continue;
      }
      putMirrorMsg(m, id, x.date || 0, x.message || "");
      if (!postMatchesSubject(x.message || "", subject.username, subject.id, strict, subject.nick, channel.username)) dropped.add(id);
      else mirrorVerified.set(`${m.key}:${id}`, now);
    }
    if (mirrorVerified.size > 50_000) mirrorVerified.clear();
    saveMirror(m);
    return hits.filter((h) => !dropped.has(h.messageId));
  } catch (err) {
    const wait = floodSeconds(err);
    if (wait) userBlockedUntil = Date.now() + (wait + 5) * 1000;
    return hits;
  }
}

// How far a copy has got. Channel message ids grow from 1, so the share of
// 1..newest already covered (oldest..newest) is a good progress estimate.
function mirrorProgress(m: Mirror): number {
  if (m.complete) return 100;
  if (!m.newest || !m.oldest) return 0;
  return Math.max(0, Math.min(99, Math.round((1 - m.oldest / m.newest) * 100)));
}

// Distinct @usernames / ids mentioned in a copy (for the admin stats), cached
// until the copy changes.
const mirrorTokenCache = new Map<string, { version: number; usernames: Set<string>; ids: Set<string> }>();
function mirrorTokens(m: Mirror) {
  const hit = mirrorTokenCache.get(m.key);
  if (hit && hit.version === m.version) return hit;
  const usernames = new Set<string>();
  const ids = new Set<string>();
  for (const msg of m.msgs.values()) {
    const t = tokensFromText(msg.text);
    for (const u of t.usernames) usernames.add(u);
    for (const id of t.ids) ids.add(id);
  }
  const value = { version: m.version, usernames, ids };
  mirrorTokenCache.set(m.key, value);
  return value;
}

export function mirrorStats() {
  const allUsernames = new Set<string>();
  const allIds = new Set<string>();
  const channels = mirrorChannels().map((c) => {
    const m = loadMirror(c);
    const t = mirrorTokens(m);
    for (const u of t.usernames) allUsernames.add(u);
    for (const id of t.ids) allIds.add(id);
    return {
      title: c.title || c.username || c.id,
      posts: m.msgs.size,
      usernames: t.usernames.size,
      complete: m.complete,
      progress: mirrorProgress(m),
      failing: Date.now() < (mirrorErrorUntil.get(m.key) || 0),
    };
  });
  return {
    channels,
    posts: channels.reduce((sum, c) => sum + c.posts, 0),
    usernames: allUsernames.size,
    ids: allIds.size,
    verifiedPairs: Object.keys(idCache).length,
  };
}

// Accused accounts in one channel's copy, cached until the copy changes: in posts
// with fields only the people in the fields, otherwise every name (minus the
// channel's own handle and the signature line). A username and an id tied
// together in one post are one account.
// Each post is parsed once; the result is kept on the post itself (a compact
// string), so while a channel is still being copied only new posts are parsed,
// and an edited post (a new object) is parsed again.
type AccusedEntry = { version: number; usernames: Set<string>; ids: Set<string>; paired: Set<string> };
const accusedCache = new Map<string, AccusedEntry>();
function postAccused(ch: CheckChannel, msg: MirrorMsg, strict: boolean, self: string): { hs: string[]; is: string[] } {
  if (msg.acc === undefined) {
    const { hs, is } = accusedInPost(msg.text, strict, ch.username, self);
    msg.acc = [...hs, ...is].join(" ");
  }
  const names = msg.acc ? msg.acc.split(" ") : [];
  return { hs: names.filter((n) => n.startsWith("@")), is: names.filter((n) => !n.startsWith("@")) };
}
function mirrorAccused(ch: CheckChannel, m: Mirror) {
  const hit = accusedCache.get(m.key);
  if (hit && hit.version === m.version) return hit;
  const usernames = new Set<string>();
  const ids = new Set<string>();
  const paired = new Set<string>();
  const self = ch.username ? `@${ch.username.replace(/^@/, "").toLowerCase()}` : "";
  const strict = isStrictChannel(ch);
  for (const msg of m.msgs.values()) {
    const { hs, is } = postAccused(ch, msg, strict, self);
    for (const h of hs) usernames.add(h);
    for (const i of is) ids.add(i);
    if (hs.length === 1 && is.length === 1) paired.add(hs[0]!);
  }
  const value = { version: m.version, usernames, ids, paired };
  accusedCache.set(m.key, value);
  return value;
}

function accusedInPost(text: string, strict: boolean, channelUsername: string | undefined, self: string) {
  let names = strict ? [] : [...accusedFields(text, channelUsername)];
  if (strict) {
    // arbitration channels (ads and rankings mixed in): only the accused side
    // of "X на пользователя Y" and "Ответчик: Y" lines
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(INVISIBLE_RE, "");
      const accused = arbitrationAccused(line, true);
      if (accused) {
        names.push(...nameTokens(accused).map((t) => t.value));
        continue;
      }
      const tokens = nameTokens(line);
      if (tokens.length && ACCUSED_PREFIX_RE.test(line.slice(0, tokens[0]!.index))) names.push(...tokens.map((t) => t.value));
    }
  } else if (!names.length && postHasScamContext(text)) {
    const lines = text.split(/\r?\n/);
    const sig = signatureLineIndex(lines);
    names = lines.flatMap((l, i) => {
      if (i === sig) return [];
      const line = l.replace(INVISIBLE_RE, "");
      return nameTokens(line)
        .filter((t) => !notAccusedHere(line, t.index))
        .map((t) => t.value);
    });
  }
  names = [...new Set(names)].filter((n) => n !== self && !IGNORE_USERNAMES.has(n.slice(1)));
  return {
    hs: names.filter((n) => n.startsWith("@")),
    is: names.filter((n) => !n.startsWith("@") && n.length >= 6),
  };
}

// How many accounts a check can find: the channel copies, EPB complaints and
// manual entries together (no channel names, safe to show to arbiters).
export function blacklistBase() {
  const usernames = new Set<string>();
  const ids = new Set<string>();
  const paired = new Set<string>();
  let posts = 0;
  let complete = 0;
  let progressSum = 0;
  const channels = mirrorChannels();
  for (const c of channels) {
    const m = loadMirror(c);
    posts += m.msgs.size;
    if (m.complete) complete++;
    progressSum += mirrorProgress(m);
    const a = mirrorAccused(c, m);
    for (const u of a.usernames) usernames.add(u);
    for (const i of a.ids) ids.add(i);
    for (const u of a.paired) paired.add(u);
  }
  for (const rec of Object.values(pendingPosts)) {
    if (rec.status !== "published" || rec.removedFromCheck) continue;
    const accs = pendingAccounts(rec);
    for (const acc of accs) {
      const u = acc.username ? `@${acc.username.replace(/^@/, "").toLowerCase()}` : "";
      if (u) usernames.add(u);
      if (acc.id) ids.add(acc.id);
      if (u && acc.id) paired.add(u);
    }
  }
  for (const e of bindings.manualBlacklist || []) {
    const u = e.username ? `@${e.username.replace(/^@/, "").toLowerCase()}` : "";
    if (u) usernames.add(u);
    if (e.telegramId) ids.add(e.telegramId);
    if (u && e.telegramId) paired.add(u);
  }
  const unpaired = [...usernames].filter((u) => !paired.has(u)).length;
  return {
    accounts: ids.size + unpaired,
    usernames: usernames.size,
    ids: ids.size,
    posts,
    channels: channels.length,
    complete,
    progress: channels.length ? Math.round(progressSum / channels.length) : 100,
  };
}

// Start copying right away (a channel was just added) instead of on the next tick.
function kickMirror() {
  setTimeout(() => void mirrorTick(5).catch(() => {}), 300);
}

// Owner diagnostics: how far each channel's copy has got.
export function mirrorStatus(): { title: string; posts: number; complete: boolean; updatedAt: number }[] {
  return mirrorChannels().map((c) => {
    const m = loadMirror(c);
    return { title: c.title || c.username || c.id, posts: m.msgs.size, complete: m.complete, updatedAt: m.updatedAt };
  });
}

if (botToken() && process.env.NODE_ENV !== "test" && (process.env.PUBLIC_URL || process.env.NODE_ENV === "production")) {
  setInterval(() => void mirrorTick().catch(() => {}), 8_000).unref?.();
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
  const st = await userbotStatus();
  if (!st.ok) return `Аккаунт не отвечает: ${st.error || "ошибка"}`;
  // Also resolve the username to a numeric id and match on that — blacklist
  // posts almost always carry "id: <number>", which search never mis-tokenizes.
  let resolvedId = id;
  if (uname && !resolvedId) {
    const r = await resolveUsernameMtproto(uname, "");
    if (r && r !== "busy" && r.id) resolvedId = r.id;
  }
  const idDigits = (resolvedId || "").replace(/\D/g, "");
  const mentions = (body: string) =>
    (uname && body.toLowerCase().includes(uname)) || (idDigits.length >= 5 && body.includes(idDigits));
  const lines: string[] = [`Аккаунт: ${st.name || "ок"}. Ищу «${q}».`];
  if (uname && !id) {
    lines.push(
      resolvedId
        ? `ID по нику: ${resolvedId} (ищу и по нему).`
        : "ID по нику узнать не удалось — аккаунт удалён, сменил ник или Telegram не ответил. Ищу только по нику.",
    );
  }
  lines.push("");
  const subject = { username: uname, id: resolvedId, nick: /[_.]/.test(uname) ? uname : "" };
  let total = 0;
  for (const ch of mirrorChannels()) {
    const title = ch.title || ch.username || ch.id;
    // The local copy: what a real check uses.
    const m = loadMirror(ch);
    const found = m.msgs.size ? searchMirror(ch, m, subject) : [];
    total += found.length;
    let line =
      `• ${title}: копия ${m.msgs.size.toLocaleString("ru-RU")} постов (${m.complete ? "вся история" : "докачивается"}) — ` +
      `найдено ${found.length}${found[0] ? ` (${found[0].link})` : ""}`;
    // Telegram's own search, for comparison (only for the connected channels).
    if (isCheckChannel(ch.id)) {
      try {
        const { client } = await userbot();
        const peer = await userInputPeer(client, channelRef(ch));
        const byId = new Map<number, TgMsgLite>();
        for (const msg of await serverSearch(client, peer, q)) if (msg.id) byId.set(msg.id, msg);
        const msgs = [...byId.values()];
        const mentioned = msgs.filter((x) => x.id && mentions(x.message || ""));
        const relevant = msgs.filter((x) => x.id && postMatchesSubject(x.message || "", uname, resolvedId, isStrictChannel(ch), "", ch.username));
        line += `; поиск Telegram: упомянут ${mentioned.length}, в тему ${relevant.length}`;
      } catch (err) {
        line += `; поиск Telegram: ошибка — ${(err as Error)?.message || String(err)}`;
      }
    }
    lines.push(line);
  }
  lines.push("", `Итого по копии: ${total}.`);
  return lines.join("\n");
}



// What Telegram tells about an account when its username is resolved (no extra
// request): name, all its usernames, and Telegram's own SCAM / FAKE marks.
type TgUserRaw = {
  id?: unknown;
  username?: string;
  usernames?: { username?: string; active?: boolean }[];
  firstName?: string;
  lastName?: string;
  premium?: boolean;
  scam?: boolean;
  fake?: boolean;
  bot?: boolean;
  verified?: boolean;
  deleted?: boolean;
  status?: { className?: string; wasOnline?: number };
  photo?: { className?: string };
  restricted?: boolean;
  restrictionReason?: { reason?: string; text?: string }[];
};
type LastSeen = { kind: "online" | "recently" | "week" | "month" | "time" | "hidden"; at?: number };
type TgProfile = {
  name: string;
  usernames: string[];
  premium: boolean;
  scam: boolean;
  fake: boolean;
  bot: boolean;
  verified: boolean;
  lastSeen: LastSeen;
  hasPhoto: boolean;
  restricted: string; // Telegram's restriction note, "" if none
  at: number;
  // from users.getFullUser (one extra request, cached for a day)
  about?: string;
  channel?: { title: string; username?: string };
  fullAt?: number;
};
const profileCache = new Map<string, TgProfile>();
// The raw user object from the last resolve (carries the access hash), kept
// briefly so the profile request needs no second username lookup.
const rawUsers = new Map<string, { user: TgUserRaw; at: number }>();

function lastSeenOf(status?: TgUserRaw["status"]): LastSeen {
  const c = status?.className || "";
  if (c === "UserStatusOnline") return { kind: "online" };
  if (c === "UserStatusRecently") return { kind: "recently" };
  if (c === "UserStatusLastWeek") return { kind: "week" };
  if (c === "UserStatusLastMonth") return { kind: "month" };
  if (c === "UserStatusOffline" && status?.wasOnline) return { kind: "time", at: Number(status.wasOnline) };
  return { kind: "hidden" };
}

function rememberProfile(id: string, u: TgUserRaw) {
  const usernames = [u.username, ...(u.usernames || []).filter((x) => x.active !== false).map((x) => x.username)]
    .filter((x): x is string => Boolean(x))
    .map((x) => x.toLowerCase());
  const unique = [...new Set(usernames)];
  for (const name of unique) noteUsername(id, name);
  const prev = profileCache.get(id);
  profileCache.set(id, {
    name: [u.firstName, u.lastName].filter(Boolean).join(" ").slice(0, 80),
    usernames: unique,
    premium: Boolean(u.premium),
    scam: Boolean(u.scam),
    fake: Boolean(u.fake),
    bot: Boolean(u.bot),
    verified: Boolean(u.verified),
    lastSeen: lastSeenOf(u.status),
    hasPhoto: Boolean(u.photo && u.photo.className !== "UserProfilePhotoEmpty"),
    restricted: u.restricted ? (u.restrictionReason || []).map((r) => r.text || r.reason || "").filter(Boolean)[0] || "restricted" : "",
    at: Date.now(),
    about: prev?.about,
    channel: prev?.channel,
    fullAt: prev?.fullAt,
  });
  rawUsers.set(id, { user: u, at: Date.now() });
  if (rawUsers.size > 500) rawUsers.delete(rawUsers.keys().next().value!);
  if (profileCache.size > 5000) profileCache.delete(profileCache.keys().next().value!);
}

// Tests put in a profile as Telegram would have returned it.
export function __setProfileForTests(id: string, u: TgUserRaw, full?: { about?: string; channel?: { title: string; username?: string } }) {
  rememberProfile(id, u);
  const p = profileCache.get(id);
  if (p && full) Object.assign(p, full, { fullAt: Date.now() });
}

// "About" text and personal channel: one users.getFullUser request, at most once
// a day per account and within its own small budget, so a burst of checks never
// pushes the bot towards Telegram's limits. Skipped while Telegram asks to wait.
async function fetchFullProfile(id: string): Promise<void> {
  const prof = profileCache.get(id);
  const raw = rawUsers.get(id);
  if (!prof || !raw || Date.now() - raw.at > 5 * 60_000) return;
  if (prof.fullAt && Date.now() - prof.fullAt < 24 * 60 * 60_000) return;
  if (!botToken() || Date.now() < mtBlockedUntil) return;
  if (tooMany("mtproto:full", 15, 60_000) || tooMany("mtproto:full:h", 200, 60 * 60_000)) return;
  try {
    const { client, Api } = await mtproto();
    const res = (await withTimeout(client.invoke(new Api.users.GetFullUser({ id: raw.user as never })), 10_000, "full user timeout")) as {
      fullUser?: { about?: string; personalChannelId?: { toString(): string } };
      chats?: { id?: { toString(): string }; title?: string; username?: string }[];
    };
    prof.fullAt = Date.now();
    prof.about = (res.fullUser?.about || "").slice(0, 300);
    const chId = res.fullUser?.personalChannelId?.toString();
    const ch = chId ? (res.chats || []).find((c) => c.id?.toString() === chId) : undefined;
    prof.channel = ch?.title ? { title: ch.title.slice(0, 80), username: ch.username || undefined } : undefined;
  } catch (err) {
    const wait = floodSeconds(err);
    if (wait) mtBlockedUntil = Date.now() + (wait + 5) * 1000;
    prof.fullAt = Date.now(); // don't retry this account for a day either way
  }
}

// Telegram never tells when an account was created. Ids are handed out in
// growing order, so known (id, month) points give an estimate: half-year
// precision at best, shown as "≈ середина 2024 (оценка по ID)".
const REG_ANCHORS: [number, number][] = [
  [1, 2013.6],
  [101_260_938, 2015.17],
  [222_021_233, 2016.44],
  [297_621_225, 2016.96],
  [400_169_472, 2017.58],
  [805_158_066, 2019.54],
  [1_974_255_900, 2021.78],
  [5_000_000_000, 2022.1],
  [6_000_000_000, 2023.3],
  [7_000_000_000, 2024.1],
  [8_000_000_000, 2025.05],
  [8_600_000_000, 2025.75],
];

export function registrationEstimate(id: string): { year: number; part: 0 | 1 | 2; later?: boolean; months?: number } | null {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 1) return null;
  let at = REG_ANCHORS[REG_ANCHORS.length - 1]![1];
  let later = false;
  if (n >= REG_ANCHORS[REG_ANCHORS.length - 1]![0]) later = true;
  else {
    for (let i = 1; i < REG_ANCHORS.length; i++) {
      const [id1, t1] = REG_ANCHORS[i]!;
      const [id0, t0] = REG_ANCHORS[i - 1]!;
      if (n <= id1) {
        at = t0 + ((n - id0) / (id1 - id0)) * (t1 - t0);
        break;
      }
    }
  }
  const year = Math.floor(at);
  const month = Math.min(11, Math.floor((at - year) * 12));
  const now = new Date();
  const nowYears = now.getUTCFullYear() + now.getUTCMonth() / 12;
  const months = later ? undefined : Math.max(0, Math.round((nowYears - at) * 12));
  return { year, part: month < 4 ? 0 : month < 8 ? 1 : 2, later: later || undefined, months };
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
        users?: TgUserRaw[];
      };
      const user = result.users?.[0];
      const id = String(user?.id ?? result.peer?.userId ?? "");
      if (!/^\d{5,15}$/.test(id)) {
        mtMisses.set(key, Date.now());
        return null;
      }
      if (user) rememberProfile(id, user);
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
  // Per-user cap first, so one user can't use up the shared lookup budget.
  if ((userId && tooMany(`resolve:${userId}`, 20, 60_000)) || tooMany("resolve:global", 80, 60_000)) {
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
    ...(app.source ? [`Подана через: ${sourceLabel(app.source)}`] : []),
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
    `<b>Жалоба ${escapeHtml(app.id)}</b>${app.source ? ` · ${sourceLabel(app.source)}` : ""}`,
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
    const rec = pendingPosts[key]!;
    rows.push([
      { text: "✏ Изменить текст", callback_data: `pedit:${key}` },
      { text: `🖼 Фото (${postMedia(rec).length})`, callback_data: `pfoto:${key}` },
    ]);
    rows.push([{ text: "👁 Предпросмотр", callback_data: `pview:${key}` }]);
    if (rec.postHtml) rows.push([{ text: "↩ Вернуть исходный текст", callback_data: `porig:${key}` }]);
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
): Promise<{ message_id: number; chat: { id: number }; fileId?: string; kind: "photo" | "video" | "document" }> {
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
  try {
    const sent = await tgForm<{ message_id: number; chat: { id: number }; photo?: { file_id: string }[] }>(
      "sendPhoto",
      form,
    );
    return { ...sent, fileId: sent.photo?.at(-1)?.file_id, kind: "photo" };
  } catch (err) {
    // Telegram refuses some pictures as photos (a very long screenshot, an odd
    // format): the same file goes as a document instead of being lost.
    if (!isPhotoRefused(err)) throw err;
    form.delete("photo");
    form.set("document", blob, (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg");
    const sent = await tgForm<{ message_id: number; chat: { id: number }; document?: { file_id: string } }>("sendDocument", form);
    return { ...sent, fileId: sent.document?.file_id, kind: "document" };
  }
}

function isPhotoRefused(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /PHOTO_INVALID_DIMENSIONS|PHOTO_SAVE_FILE_INVALID|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID|PHOTO_INVALID|wrong file identifier|failed to get HTTP URL content|IMAGE_INVALID/i.test(text);
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
    source: app.source,
  };
  savePending();
}

function sourceLabel(source?: "app" | "bot"): string {
  return source === "app" ? "📱 приложение" : source === "bot" ? "🤖 бот" : "";
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
  const reason = kind === "rejected" && record?.rejectReason ? `\n\n${btUser(chatId, "rejectReason")} ${record.rejectReason}` : "";
  await tgSoft("sendMessage", { chat_id: chatId, text: text + reason, disable_web_page_preview: true });
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
      ...(c.status === "rejected" && c.rejectReason ? { rejectReason: c.rejectReason } : {}),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- /im: a member's card in a group ----------
// The card of the app (metal by tier, the person's name, the base count) as a
// short looping animation that tilts in 3D, with the person's numbers below.
// Drawing one takes ~3 s of CPU (in worker threads, so the bot itself is not
// held up; about 1 s on a 4-core server), so cards are drawn one at a time and
// a finished one is reused (by Telegram file id): as it is for 10 minutes,
// after that it is drawn anew, unless the person had cards drawn just now
// (repeated /im): then the last one is sent again. The bot draws at most 30 a
// minute; sending a saved card is not limited by that.
const imCache = new Map<string, { fileId: string; at: number }>();
let imQueue: Promise<unknown> = Promise.resolve();
let imWaiting = 0;
const IM_FRESH_MS = 10 * 60_000;

function memberStats(uid: string) {
  let filed = 0;
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  for (const rec of Object.values(pendingPosts)) {
    if (rec.victimId !== uid) continue;
    filed++;
    if (rec.status === "published") accepted += rec.deletedEverywhere ? 0 : 1;
    else if (rec.status === "rejected") rejected++;
    else pending++;
  }
  // older accepted ones may have been pruned from the records: the card counter keeps them
  accepted = Math.max(accepted, publishedCountFor(uid));
  filed = Math.max(filed, accepted + rejected + pending);
  return { filed, accepted, rejected, pending };
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

type MemberInfo = {
  uid: string;
  holder: string;
  metal: string;
  // under the front: who and which card; under the back: the numbers too
  caption: string;
  captionBack: string;
  back: { signature: string; lines: [string, string][] };
};

function regLabel(id: string): string {
  const r = registrationEstimate(id);
  if (!r) return "—";
  if (r.later) return `${r.year} ИЛИ ПОЗЖЕ`;
  return `${["НАЧАЛО", "СЕРЕДИНА", "КОНЕЦ"][r.part]} ${r.year}`;
}

// What the back of the card says about a person (the bot's /im card and the
// app's card show the same): name, username, id, the registration estimate,
// whether the person is in the blacklist base and the complaint numbers.
function memberFacts(from: TgUser) {
  const uid = String(from.id);
  const published = publishedCountFor(uid);
  const st = memberStats(uid);
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  // is the person in the blacklist base? (local base only, no lookups)
  const botPosts = new Set<number>();
  for (const rec of Object.values(pendingPosts)) for (const mid of rec.channelMsgIds || []) botPosts.add(mid);
  const find = parsLookup({ id: uid, usernames: from.username ? [from.username.toLowerCase()] : [], name }, checkChannels(), botPosts);
  const sources = find ? Math.max(1, find.epb.length + find.manual.length + new Set(find.posts.map((p) => p.channelTitle)).size) : 0;
  return { uid, name, published, st, sources };
}

export type MemberCardBack = {
  name: string;
  username: string;
  id: string;
  reg: { year: number; part: 0 | 1 | 2; later: boolean } | null;
  // in how many sources of the blacklist base the person is (0: not listed)
  listed: number;
  accepted: number;
  filed: number;
};

// The app's card: the level and its back.
export function memberCardFor(u: { id: string; username?: string; firstName?: string; lastName?: string }): { published: number; back: MemberCardBack } {
  const f = memberFacts({ id: Number(u.id), username: u.username, first_name: u.firstName, last_name: u.lastName });
  const r = registrationEstimate(f.uid);
  return {
    published: f.published,
    back: {
      name: f.name,
      username: u.username || "",
      id: f.uid,
      reg: r ? { year: r.year, part: r.part, later: Boolean(r.later) } : null,
      listed: f.sources,
      accepted: f.st.accepted,
      filed: f.st.filed,
    },
  };
}

// Everything the card shows for one person: the caption under it, the metal,
// and the details engraved on its back.
function memberInfo(from: TgUser): MemberInfo {
  const { uid, name, published, st, sources } = memberFacts(from);
  const tier = tierFor(published);
  const next = nextTier(published);
  const holder = from.username || name || "EPB Member";
  const who = from.username ? `@${escapeHtml(from.username)}` : escapeHtml(holder);
  const caption = `${who} — карта <b>${tier.name}</b>`;
  const captionBack = [
    caption,
    "",
    `✅ Принято: <b>${st.accepted}</b> · ❌ Отклонено: <b>${st.rejected}</b>`,
    next
      ? `${pickEmoji("🏆", "⭐")} До ${next.name} — ещё ${next.min - st.accepted} ${plural(next.min - st.accepted, "блеклист", "блеклиста", "блеклистов")}`
      : `${pickEmoji("👑", "🏆")} Высшая карта участника`,
  ].join("\n");
  const listed = sources ? `ДА · ${sources} ${plural(sources, "ИСТОЧНИК", "ИСТОЧНИКА", "ИСТОЧНИКОВ")}` : "НЕТ";
  return {
    uid,
    holder,
    metal: tier.metal,
    caption,
    captionBack,
    back: {
      signature: name || holder,
      lines: [
        ["НИК", name || "—"],
        ["USERNAME", from.username ? `@${from.username}` : "—"],
        ["ID", uid],
        ["РЕГИСТРАЦИЯ", regLabel(uid)],
        ["В БАЗЕ БЛЕКЛИСТА", listed],
        ["КАРТА", `${tier.name} · ПРИНЯТО ${st.accepted} ИЗ ${st.filed}`],
      ],
    },
  };
}

// `menu`: the card was opened from the bot's menu ("Мой профиль"), so it leads
// back there instead of to the bot.
function memberMarkup(uid: string, side: "front" | "back", menu = false) {
  return {
    inline_keyboard: [
      [{ text: "🔄 Перевернуть", callback_data: `imf:${uid}:${side === "front" ? "b" : "f"}${menu ? ":m" : ""}` }],
      menu
        ? [{ text: tb(langOf(uid), "inMenu"), callback_data: "imhome" }]
        : [{ text: "Подать жалобу", url: `https://t.me/${BOT_USERNAME}?start=im` }],
    ],
  };
}

// The animation of one side: Telegram file id when it was sent recently,
// otherwise drawn now (one at a time). The front is the same for everyone with
// that name and metal; the back is the person's own.
function animationKey(info: MemberInfo, side: "front" | "back") {
  return side === "front" ? `${info.metal}|${info.holder}` : `back|${info.uid}|${info.metal}|${info.back.lines.map((l) => l[1]).join("|")}`;
}

function drawMemberVideo(info: MemberInfo, side: "front" | "back"): Promise<Buffer> {
  imWaiting++;
  const job = imQueue.then(async () => {
    try {
      const { renderMemberVideo } = await import("@/lib/member-gif.server");
      return await renderMemberVideo({
        metal: info.metal,
        holder: info.holder,
        count: blacklistBaseCached() || null,
        ...(side === "back" ? { back: info.back } : {}),
      });
    } finally {
      imWaiting--;
    }
  });
  imQueue = job.catch(() => {});
  return job;
}

async function memberAnimation(info: MemberInfo, side: "front" | "back"): Promise<{ fileId: string } | { video: Buffer } | null> {
  const key = animationKey(info, side);
  const cached = imCache.get(key);
  if (cached && Date.now() - cached.at < IM_FRESH_MS) return { fileId: cached.fileId };
  // drawn ahead (or still being drawn): only the upload is left
  const ahead = imAhead.get(key);
  if (ahead) {
    imAhead.delete(key);
    const video = Date.now() - ahead.at < IM_AHEAD_MS ? await ahead.video : null;
    if (video) return { video };
  }
  // a few drawings per person, and for the whole bot: a burst of /im in many
  // chats waits instead of piling up; meanwhile the last card is sent again
  if (imWaiting >= 10 || tooMany(`im-draw:${info.uid}`, 3, 5 * 60_000) || tooMany("im-render", 30, 60_000)) {
    return cached ? { fileId: cached.fileId } : null;
  }
  return { video: await drawMemberVideo(info, side) };
}

// The other side is drawn while the person looks at this one, so that
// "Перевернуть" only has to upload it. Only when the queue is quiet.
const imAhead = new Map<string, { at: number; video: Promise<Buffer | null> }>();
const IM_AHEAD_MS = 5 * 60_000;
function drawAhead(info: MemberInfo, side: "front" | "back") {
  const key = animationKey(info, side);
  const cached = imCache.get(key);
  if ((cached && Date.now() - cached.at < IM_FRESH_MS) || imAhead.has(key)) return;
  if (imWaiting >= 3 || tooMany("im-ahead", 15, 60_000)) return;
  for (const [k, v] of imAhead) if (Date.now() - v.at > IM_AHEAD_MS) imAhead.delete(k);
  if (imAhead.size >= 40) imAhead.delete(imAhead.keys().next().value!);
  imAhead.set(key, { at: Date.now(), video: drawMemberVideo(info, side).catch(() => null) });
}

// Card captions carry the owner's Premium emoji (in groups too); if Telegram
// refuses them, the same call is made again with the plain emoji.
// A chat that refused them gets plain emoji for a day (no second upload each time).
const ceRefused = new Map<string, number>();
async function withCardCaption<T>(chatId: number | string, text: string, call: (caption: string) => Promise<T>): Promise<T> {
  const refusedAt = ceRefused.get(String(chatId));
  const rich = customEmojiEnabled() && !(refusedAt && Date.now() - refusedAt < 86_400_000) ? applyCustomEmoji(text) : text;
  if (rich === text) return call(text);
  try {
    return await call(rich);
  } catch (err) {
    if (!(err instanceof Error && /emoji|entit/i.test(err.message))) throw err;
    if (ceRefused.size > 5000) ceRefused.clear();
    ceRefused.set(String(chatId), Date.now());
    return call(text);
  }
}

// The card is a short silent MP4, which Telegram plays as a looping animation.
const CARD_VIDEO_SIZE = { width: 800, height: 550, duration: 3 };
function cardFile(video: Buffer) {
  return new File([new Uint8Array(video)], "card.mp4", { type: "video/mp4" });
}

function rememberAnimation(info: MemberInfo, side: "front" | "back", sent: { animation?: { file_id: string }; document?: { file_id: string } } | null) {
  const fileId = sent?.animation?.file_id || sent?.document?.file_id;
  if (!fileId) return;
  const key = side === "front" ? `${info.metal}|${info.holder}` : `back|${info.uid}|${info.metal}|${info.back.lines.map((l) => l[1]).join("|")}`;
  imCache.set(key, { fileId, at: Date.now() });
  if (imCache.size > 500) imCache.delete(imCache.keys().next().value!);
}

async function replyMemberCard(msg: TgMessage) {
  const from = msg.from!;
  const chatId = msg.chat.id;
  if (tooMany(`im:${from.id}`, 1, 3000) || tooMany(`im-chat:${chatId}`, 30, 60_000)) return;
  if ((await sendMemberCard(chatId, from, { replyTo: msg.message_id })) === "busy") {
    await tgSoft("sendMessage", { chat_id: chatId, text: "Сейчас рисую карты для других — попробуйте через минуту.", reply_to_message_id: msg.message_id });
  }
}

// The card's front as a new message: in a chat (/im) or in private from the
// menu ("Мой профиль").
async function sendMemberCard(chatId: number, from: TgUser, opts: { replyTo?: number; menu?: boolean } = {}): Promise<"sent" | "busy"> {
  const info = memberInfo(from);
  const markup = memberMarkup(info.uid, "front", opts.menu);
  const reply = opts.replyTo ? { reply_to_message_id: opts.replyTo } : {};
  void tgSoft("sendChatAction", { chat_id: chatId, action: "upload_video" });
  try {
    const anim = await memberAnimation(info, "front");
    if (!anim) return "busy";
    let video: Buffer | null = "video" in anim ? anim.video : null;
    if ("fileId" in anim) {
      const sent = await withCardCaption(chatId, info.caption, (caption) =>
        tg("sendAnimation", { chat_id: chatId, animation: anim.fileId, caption, parse_mode: "HTML", ...reply, reply_markup: markup }),
      ).catch(() => null);
      if (sent) {
        drawAhead(info, "back");
        return "sent";
      }
      // the saved file stopped working: draw it again
      imCache.delete(`${info.metal}|${info.holder}`);
      const again = await memberAnimation(info, "front");
      video = again && "video" in again ? again.video : null;
    }
    if (!video) throw new Error("no card");
    const file = video;
    const sent = await withCardCaption(chatId, info.caption, (caption) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", caption);
      form.set("parse_mode", "HTML");
      if (opts.replyTo) form.set("reply_to_message_id", String(opts.replyTo));
      form.set("reply_markup", JSON.stringify(markup));
      form.set("animation", cardFile(file));
      for (const [k, v] of Object.entries(CARD_VIDEO_SIZE)) form.set(k, String(v));
      return tgForm<{ animation?: { file_id: string } }>("sendAnimation", form);
    });
    rememberAnimation(info, "front", sent);
    drawAhead(info, "back");
  } catch (err) {
    console.error("[epb] im", err);
    // without the picture the words still reach the chat
    await withCardCaption(chatId, info.caption, (text) => tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...reply, reply_markup: markup })).catch(() => null);
  }
  return "sent";
}

const PROFILE_STEPS = [
  "💳 <b>Регистрируем карту…</b>",
  "🔐 <b>Выпускаем карту…</b>\n✅ Карта зарегистрирована",
  "✍️ <b>Ставим подпись…</b>\n✅ Карта зарегистрирована\n✅ Карта выпущена",
  "✨ <b>Наносим гравировку…</b>\n✅ Карта зарегистрирована\n✅ Карта выпущена\n✅ Подпись поставлена",
  "📦 <b>Упаковываем…</b>\n✅ Карта зарегистрирована\n✅ Карта выпущена\n✅ Подпись поставлена\n✅ Гравировка нанесена",
];

// "Мой профиль" in the bot's menu: the card replaces the menu message, and
// "В меню" under it brings the menu back.
async function openMemberProfile(cb: NonNullable<TgUpdate["callback_query"]>) {
  const answer = (text?: string, alert = false) => tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  if (!cb.message || !cb.from || cb.message.chat.type !== "private") return answer();
  if (tooMany(`im:${cb.from.id}`, 1, 3000)) return answer("Секунду…");
  // When the card has to be drawn, the menu message tells how it is being made
  // (step by step) instead of just waiting.
  const info = memberInfo(cb.from);
  const saved = imCache.get(animationKey(info, "front"));
  let making: ReturnType<typeof setInterval> | null = null;
  if (!saved || Date.now() - saved.at >= IM_FRESH_MS) {
    void answer();
    let step = 0;
    const m = cb.message as { message_id: number; chat: { id: number }; caption?: string; photo?: unknown };
    const field = m.caption || m.photo ? "caption" : "text";
    // only edits (never a new message, even if an edit fails)
    const show = () => {
      if (step >= PROFILE_STEPS.length) return;
      void tgSoft(field === "caption" ? "editMessageCaption" : "editMessageText", {
        chat_id: m.chat.id,
        message_id: m.message_id,
        [field]: PROFILE_STEPS[step++],
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });
    };
    show();
    making = setInterval(show, 800);
  }
  const result = await sendMemberCard(cb.message.chat.id, cb.from, { menu: true }).finally(() => making && clearInterval(making));
  if (result === "busy" && making) {
    await editCard(cb, await startCaption(langOf(cb.from.id)), applyKeyboard(langOf(cb.from.id)));
    await tgSoft("sendMessage", { chat_id: cb.message.chat.id, text: "Сейчас рисую карты для других — попробуйте через минуту." });
    return;
  }
  if (result === "busy") return answer("Сейчас рисую карты для других — попробуйте через минуту.", true);
  if (!making) await answer();
  void tgSoft("deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
}

// "Перевернуть": only the person who asked for the card can turn it over.
async function flipMemberCard(cb: NonNullable<TgUpdate["callback_query"]>) {
  const [, uid = "", to = "b", from = ""] = (cb.data || "").split(":");
  const answer = (text?: string, alert = false) => tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  if (!cb.message || !cb.from) return answer();
  if (String(cb.from.id) !== uid) {
    await answer("Перевернуть карту может только её владелец — напишите /im, чтобы получить свою.", true);
    return;
  }
  if (tooMany(`imflip:${uid}`, 1, 4000)) {
    await answer("Секунду…");
    return;
  }
  const side = to === "f" ? "front" : "back";
  await answer(side === "back" ? "Переворачиваю…" : "Обратно на лицевую сторону…");
  const info = memberInfo(cb.from);
  const markup = memberMarkup(uid, side, from === "m");
  try {
    const anim = await memberAnimation(info, side);
    if (!anim) {
      await answer("Сейчас рисую карты для других — попробуйте через минуту.", true);
      return;
    }
    // the numbers are under the back only
    const text = side === "back" ? info.captionBack : info.caption;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    if ("fileId" in anim) {
      const ok = await withCardCaption(chatId, text, (caption) =>
        tg("editMessageMedia", { chat_id: chatId, message_id: messageId, media: { type: "animation", caption, parse_mode: "HTML", media: anim.fileId }, reply_markup: markup }),
      ).catch(() => null);
      if (ok) {
        drawAhead(info, side === "back" ? "front" : "back");
        return;
      }
    }
    const video = "video" in anim ? anim.video : null;
    if (!video) return;
    const sent = await withCardCaption(chatId, text, (caption) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("message_id", String(messageId));
      form.set("media", JSON.stringify({ type: "animation", caption, parse_mode: "HTML", ...CARD_VIDEO_SIZE, media: "attach://card" }));
      form.set("card", cardFile(video));
      form.set("reply_markup", JSON.stringify(markup));
      return tgForm<{ animation?: { file_id: string } }>("editMessageMedia", form);
    });
    rememberAnimation(info, side, sent);
    drawAhead(info, side === "back" ? "front" : "back");
  } catch (err) {
    console.error("[epb] im flip", err);
  }
}

// ---------- /pars: check a chat's members against the blacklist base ----------
// The owner types /pars in a group. The bot answers there with one quiet line
// (deleted again after a minute together with the command) and carries on in
// private. The userbot reads the member list slowly, page by page with pauses,
// and only reads: nothing is posted to the chat, nobody is contacted, no one is
// added or removed. Members are matched against the local base only (EPB
// complaints, the saved copies of the blacklist channels, the manual list), so
// the userbot does no extra work per member; only the few posts that match are
// re-checked with Telegram. The owner gets the report in private.
type ParsTarget = { chatId: string; title: string; username?: string; members?: number; at: number };
type ParsMember = { id: string; usernames: string[]; name: string };
type ParsFind = {
  member: ParsMember;
  epb: { key: string; date: number; link?: string }[];
  manual: CheckResult["manual"];
  posts: CheckHit[];
};
const parsTargets = new Map<string, ParsTarget>();
let parsRunning: ParsTarget | null = null;
const parsFinished = new Map<string, number>();
const PARS_PAGE = 200;
const PARS_MAX = 10_000;
const PARS_PAUSE_MS = 1500;
const PARS_COOLDOWN_MS = 10 * 60_000;
const PARS_LINK_TTL = 30 * 60_000;
// longest FLOOD_WAIT we sit out; anything longer ends the read with what we have
const PARS_MAX_WAIT_S = 120;

async function parsAskInGroup(msg: TgMessage) {
  const chatId = String(msg.chat.id);
  for (const [k, v] of parsTargets) if (Date.now() - v.at > PARS_LINK_TTL) parsTargets.delete(k);
  const token = randomUUID().replace(/-/g, "").slice(0, 12);
  const chat = await tgSoft<{ title?: string; username?: string }>("getChat", { chat_id: chatId });
  const members = await tgSoft<number>("getChatMemberCount", { chat_id: chatId });
  parsTargets.set(token, {
    chatId,
    title: chat?.title || msg.chat.title || chatId,
    username: chat?.username || undefined,
    members: typeof members === "number" ? members : undefined,
    at: Date.now(),
  });
  const sent = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: "Продолжите в личных сообщениях бота.",
    disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: "Открыть бота", url: `https://t.me/${BOT_USERNAME}?start=pars_${token}` }]] },
  });
  // keep the chat clean: the command and the answer go away after a minute
  const t = setTimeout(() => {
    void tgSoft("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    if (sent?.message_id) void tgSoft("deleteMessage", { chat_id: chatId, message_id: sent.message_id });
  }, 60_000);
  (t as { unref?: () => void }).unref?.();
}

function parsMinutes(n: number): number {
  return Math.max(1, Math.ceil((Math.ceil(Math.min(n, PARS_MAX) / PARS_PAGE) * (PARS_PAUSE_MS + 700)) / 60_000));
}

async function parsOffer(chatId: number | string, token: string) {
  const t = parsTargets.get(token);
  if (!t || Date.now() - t.at > PARS_LINK_TTL) {
    await tgSoft("sendMessage", { chat_id: chatId, text: "Ссылка устарела. Напишите /pars в чате ещё раз." });
    return;
  }
  const lines = [
    "🔎 <b>Проверка участников чата</b>",
    "",
    `Чат: <b>${escapeHtml(t.title)}</b>${t.username ? ` (@${escapeHtml(t.username)})` : ""}`,
    t.members ? `Участников: ${t.members}` : "",
    "",
    "Юзербот спокойно, с паузами выгрузит список участников (юзернеймы и ID) и сверит каждого с базой: жалобы EPB, копии блеклист-каналов и ручной список. Отчёт придёт сюда.",
    "В самом чате никому ничего не отправится.",
    "Если юзербота нет в чате, бот пригласит его по одноразовой ссылке, а после проверки он выйдет. Если список участников скрыт, юзербот на время проверки получит только право «Управление чатом», потом оно снимается.",
    "",
    t.members && t.members > PARS_MAX ? `В больших чатах Telegram отдаёт не больше ${PARS_MAX} участников — проверятся они.` : "",
    t.members ? `Займёт примерно ${parsMinutes(t.members)} мин.` : "",
  ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i < a.length - 1));
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Начать проверку", callback_data: `pars:go:${token}` }],
        [{ text: "Отмена", callback_data: `pars:no:${token}` }],
      ],
    },
  });
}

async function handleParsCallback(cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
  const [, action, token = ""] = (cb.data || "").split(":");
  const answer = (text?: string, alert = false) => tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  if (!isOwner(cb.from?.id) || !cb.message) {
    await answer();
    return;
  }
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  if (action === "no") {
    parsTargets.delete(token);
    await answer("Отменено");
    await tgSoft("editMessageText", { chat_id: chatId, message_id: msgId, text: "Проверка чата отменена." });
    return;
  }
  const t = parsTargets.get(token);
  if (!t || Date.now() - t.at > PARS_LINK_TTL) {
    await answer("Ссылка устарела. Напишите /pars в чате ещё раз.", true);
    return;
  }
  if (!hasUserbot()) {
    await answer("Юзербот не подключён. Подключите аккаунт: /userbot", true);
    return;
  }
  if (parsRunning) {
    await answer(`Уже идёт проверка чата «${parsRunning.title}». Дождитесь отчёта.`, true);
    return;
  }
  const last = parsFinished.get(t.chatId) || 0;
  if (Date.now() - last < PARS_COOLDOWN_MS) {
    const min = Math.ceil((PARS_COOLDOWN_MS - (Date.now() - last)) / 60_000);
    await answer(`Этот чат недавно проверялся. Повторить можно через ${min} мин.`, true);
    return;
  }
  if (Date.now() < userBlockedUntil) {
    const min = Math.ceil((userBlockedUntil - Date.now()) / 60_000);
    await answer(`Telegram попросил юзербот подождать ещё ~${min} мин. Попробуйте позже.`, true);
    return;
  }
  parsTargets.delete(token);
  parsRunning = t;
  await answer("Начинаю");
  await tgSoft("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text: `🔎 Проверка чата «${t.title}» началась. Отчёт придёт отдельным сообщением.`,
  });
  // runs in the background: the bot keeps answering everyone meanwhile
  void parsScan(t, chatId)
    .catch((err) => console.error("[epb] pars", err))
    .finally(() => {
      parsFinished.set(t.chatId, Date.now());
      parsRunning = null;
    });
}

let userbotSelfId = "";
async function userbotSelf(): Promise<string> {
  if (userbotSelfId) return userbotSelfId;
  const { client, Api } = await userbot();
  const me = (await withTimeout(client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] })), 12_000, "timeout")) as {
    id?: { toString(): string };
  }[];
  userbotSelfId = me?.[0]?.id?.toString() || "";
  if (!userbotSelfId) throw new Error("userbot id");
  return userbotSelfId;
}

const PARS_ADMIN_OFF = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_manage_topics: false,
};

// Makes sure the userbot can read the member list. Not in the chat: the bot
// makes a one-time invite link and the userbot joins with it. Member list
// hidden: the userbot gets a single admin right, "manage chat" (it lets him see
// members and nothing else that changes the chat). Both are undone afterwards
// (parsRestore), also after a restart.
async function parsPrepare(t: ParsTarget, say: (text: string) => Promise<void>): Promise<unknown | null> {
  const uid = await userbotSelf();
  const member = await tgSoft<{ status?: string; is_member?: boolean }>("getChatMember", { chat_id: t.chatId, user_id: uid });
  const status = member?.status || "left";
  if (status === "kicked") throw new Error("USERBOT_BANNED");
  const inChat = status === "creator" || status === "administrator" || status === "member" || (status === "restricted" && member?.is_member !== false);
  let peer: unknown | null = null;
  const cleanup = { chatId: t.chatId, userbotId: uid, joined: false, promoted: false };
  if (!inChat) {
    await say(`⏳ «${t.title}»: юзербота нет в чате — приглашаю по одноразовой ссылке…`);
    const link = await tgSoft<{ invite_link?: string }>("createChatInviteLink", {
      chat_id: t.chatId,
      name: "EPB check",
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 600,
    });
    if (!link?.invite_link) throw new Error("BOT_CANT_INVITE");
    const hash = link.invite_link.replace(/^.*\/(?:\+|joinchat\/)?/, "");
    bindings.parsCleanup = { ...cleanup, joined: true };
    saveBindings();
    const { client, Api } = await userbot();
    try {
      const res = (await withTimeout(client.invoke(new Api.messages.ImportChatInvite({ hash })), 20_000, "timeout")) as {
        chats?: { className?: string; id?: unknown; accessHash?: unknown }[];
      };
      const chat = res?.chats?.[0];
      if (chat?.className === "Channel") peer = new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash });
      else if (chat?.className === "Chat") peer = new Api.InputPeerChat({ chatId: chat.id });
    } catch (err) {
      const text = (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message || "";
      if (/INVITE_REQUEST_SENT/.test(text)) {
        // the chat asks to approve joiners: the bot approves its own invite
        await tgSoft("approveChatJoinRequest", { chat_id: t.chatId, user_id: uid });
      } else if (!/USER_ALREADY_PARTICIPANT/.test(text)) {
        bindings.parsCleanup = undefined;
        saveBindings();
        throw err;
      }
    } finally {
      void tgSoft("revokeChatInviteLink", { chat_id: t.chatId, invite_link: link.invite_link });
    }
    cleanup.joined = true;
    await sleep(1500);
  }
  const chat = await tgSoft<{ has_hidden_members?: boolean }>("getChat", { chat_id: t.chatId });
  const isAdmin = status === "creator" || status === "administrator";
  if (chat?.has_hidden_members && !isAdmin) {
    await say(`⏳ «${t.title}»: список участников скрыт — на время проверки даю юзерботу право «управление чатом»…`);
    bindings.parsCleanup = { ...cleanup, promoted: true };
    saveBindings();
    const ok = await tgSoft("promoteChatMember", { chat_id: t.chatId, user_id: uid, ...PARS_ADMIN_OFF, can_manage_chat: true });
    if (!ok) {
      bindings.parsCleanup = cleanup.joined ? cleanup : undefined;
      saveBindings();
      throw new Error("BOT_CANT_PROMOTE");
    }
    cleanup.promoted = true;
    await sleep(1500);
  }
  bindings.parsCleanup = cleanup.joined || cleanup.promoted ? cleanup : undefined;
  saveBindings();
  return peer;
}

// Undoes what parsPrepare changed: the admin right is taken back and, if the
// userbot joined only for the check, it leaves the chat.
async function parsRestore() {
  const c = bindings.parsCleanup;
  if (!c) return;
  if (c.promoted) await tgSoft("promoteChatMember", { chat_id: c.chatId, user_id: c.userbotId, ...PARS_ADMIN_OFF });
  if (c.joined) {
    try {
      const { client, Api } = await userbot();
      const peer = (await withTimeout(userInputPeer(client, Number(c.chatId)), 20_000, "timeout")) as { className?: string; chatId?: unknown };
      if (peer?.className === "InputPeerChat") {
        await withTimeout(client.invoke(new Api.messages.DeleteChatUser({ chatId: peer.chatId, userId: new Api.InputUserSelf() })), 15_000, "timeout");
      } else {
        await withTimeout(client.invoke(new Api.channels.LeaveChannel({ channel: peer })), 15_000, "timeout");
      }
    } catch (err) {
      // already gone is fine; anything else is retried on the next start
      const text = (err as { errorMessage?: string })?.errorMessage || (err as Error)?.message || "";
      if (!/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE|CHAT_ID_INVALID|PEER_ID_INVALID/.test(text)) return;
    }
  }
  // keep the record a moment so the "left" service message is still cleaned up
  setTimeout(() => {
    if (bindings.parsCleanup === c) {
      bindings.parsCleanup = undefined;
      saveBindings();
    }
  }, 15_000);
}
if (process.env.NODE_ENV !== "test") {
  // a check cut short by a restart: undo its changes once the bot is up
  setTimeout(() => {
    if (bindings.parsCleanup && hasUserbot() && !parsRunning) void parsRestore().catch(() => {});
  }, 20_000);
}

function parsErrorText(err: unknown): string {
  const text = (err as { errorMessage?: string; message?: string })?.errorMessage || (err as Error)?.message || String(err);
  if (/USERBOT_BANNED/.test(text)) return "Аккаунт юзербота заблокирован в этом чате — снимите блокировку и повторите /pars.";
  if (/BOT_CANT_INVITE/.test(text)) {
    return "Юзербота нет в чате, а у бота нет права приглашать по ссылке. Дайте боту в этом чате право «Пригласительные ссылки» (или добавьте юзербота вручную) и повторите /pars.";
  }
  if (/BOT_CANT_PROMOTE/.test(text)) {
    return "Список участников в чате скрыт, а у бота нет права назначать админов. Дайте боту право «Назначение администраторов» (юзербот на время проверки получит только «Управление чатом») или сделайте юзербота админом вручную, и повторите /pars.";
  }
  if (/CHAT_ADMIN_REQUIRED/i.test(text)) {
    return "В этом чате список участников скрыт — его видят только админы. Сделайте аккаунт юзербота администратором (можно без прав) и повторите /pars.";
  }
  if (/CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|CHAT_FORBIDDEN|PEER_ID_INVALID|Could not find the input entity|Cannot find any entity/i.test(text)) {
    return "Аккаунт юзербота не состоит в этом чате (или не видит его). Добавьте его в чат и повторите /pars.";
  }
  if (floodSeconds(err)) return "Telegram попросил юзербот подождать. Попробуйте позже.";
  return `Не удалось получить участников: ${text.slice(0, 200)}`;
}

// The member list, read gently: pages of 200 with a pause between them. A
// FLOOD_WAIT is waited out once if short; a long one ends the read with what
// was collected (the report then says so).
async function parsFetchMembers(
  t: ParsTarget,
  onProgress: (got: number) => void,
  known: unknown | null = null,
): Promise<{ members: ParsMember[]; partial: string }> {
  const { client, Api } = await userbot();
  const ref = t.username ? t.username : Number(t.chatId);
  const peer = (known || (await withTimeout(userInputPeer(client, ref), 30_000, "resolve timeout"))) as { className?: string; chatId?: unknown };
  const out = new Map<string, ParsMember>();
  const take = (users: unknown[]) => {
    for (const raw of users || []) {
      const u = raw as {
        id?: { toString(): string };
        username?: string;
        usernames?: { username?: string; active?: boolean }[];
        firstName?: string;
        lastName?: string;
        bot?: boolean;
        deleted?: boolean;
        className?: string;
      };
      if (!u?.id || u.bot || u.deleted || (u.className && u.className !== "User")) continue;
      const id = u.id.toString();
      const names = new Set<string>();
      if (u.username) names.add(u.username.toLowerCase());
      for (const x of u.usernames || []) if (x?.username && x.active !== false) names.add(x.username.toLowerCase());
      out.set(id, { id, usernames: [...names].slice(0, 4), name: [u.firstName, u.lastName].filter(Boolean).join(" ") });
    }
  };
  if (peer?.className === "InputPeerChat") {
    // an old-style small group: one request returns everybody
    const full = (await withTimeout(client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId })), 20_000, "timeout")) as {
      users?: unknown[];
    };
    take(full?.users || []);
    onProgress(out.size);
    return { members: [...out.values()], partial: "" };
  }
  let offset = 0;
  let partial = "";
  let waited = false;
  while (offset < PARS_MAX) {
    let res: { users?: unknown[]; participants?: unknown[]; count?: number };
    try {
      res = (await withTimeout(
        client.invoke(
          new Api.channels.GetParticipants({
            channel: peer,
            filter: new Api.ChannelParticipantsRecent(),
            offset,
            limit: PARS_PAGE,
            hash: 0,
          }),
        ),
        20_000,
        "timeout",
      )) as typeof res;
    } catch (err) {
      const wait = floodSeconds(err);
      if (wait && wait <= PARS_MAX_WAIT_S && !waited) {
        waited = true;
        await sleep((wait + 3) * 1000);
        continue;
      }
      if (wait) userBlockedUntil = Date.now() + (wait + 5) * 1000;
      if (out.size) {
        partial = wait ? "Telegram попросил юзербот сделать паузу, поэтому список выгружен не полностью." : "Список выгружен не полностью (Telegram перестал отвечать).";
        break;
      }
      throw err;
    }
    const page = res?.participants?.length || 0;
    take(res?.users || []);
    onProgress(out.size);
    if (page < PARS_PAGE) break;
    offset += page;
    // a calm pace with a little jitter, so the account never looks like a scraper
    await sleep(PARS_PAUSE_MS + Math.floor(Math.random() * 700));
  }
  if (offset >= PARS_MAX) partial = `Telegram отдаёт не больше ${PARS_MAX} участников большого чата — проверены они.`;
  return { members: [...out.values()], partial };
}

// One member against the local base: no network at all.
function parsLookup(m: ParsMember, channels: CheckChannel[], botPosts: Set<number>): ParsFind | null {
  if (isExcludedAccount(m.usernames, m.id)) return null;
  const names = m.usernames.filter((u) => !isIgnoredHandle(u));
  const epb: ParsFind["epb"] = [];
  let hasBotRecord = false;
  for (const [key, rec] of Object.entries(pendingPosts)) {
    const accounts = pendingAccounts(rec);
    const match = accounts.some(
      (a) => (a.id && a.id === m.id) || (a.username && names.includes(a.username.replace(/^@/, "").toLowerCase())),
    );
    if (!match) continue;
    hasBotRecord = true;
    if (rec.status !== "published" || !rec.channelPosted || rec.removedFromCheck || rec.deletedEverywhere) continue;
    const chan = rec.channelChatId || bindings.channelId || "";
    const mid = rec.channelMsgIds?.[0];
    epb.push({ key, date: rec.createdAt || 0, link: chan && mid ? messageLink({ id: chan, addedAt: 0 }, mid) : undefined });
  }
  const manual = names.map((u) => matchManualBlacklist(u, "")).flat().concat(matchManualBlacklist("", m.id));
  const seen = new Set<string>();
  const posts: CheckHit[] = [];
  const subjects = [
    ...names.map((u, i) => ({ username: u, id: i === 0 ? m.id : "", nick: "" })),
    ...(names.length ? [] : [{ username: "", id: m.id, nick: "" }]),
    // earlier usernames of the same account
    ...knownUsernames(m.id)
      .map((k) => k.username)
      .filter((u) => !names.includes(u))
      .slice(0, 3)
      .map((u) => ({ username: u, id: "", nick: "" })),
  ];
  const epbChannel = epbCheckChannel();
  for (const ch of [...channels, ...(epbChannel && !hasBotRecord ? [epbChannel] : [])]) {
    const mirror = loadMirror(ch);
    if (!mirror.msgs.size) continue;
    for (const sub of subjects) {
      for (const h of searchMirror(ch, mirror, sub)) {
        if (epbChannel && ch === epbChannel && botPosts.has(h.messageId)) continue;
        const k = `${chatIdKey(h.channelId)}:${h.messageId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        posts.push(h);
      }
    }
  }
  const uniqueManual = manual.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  if (!epb.length && !uniqueManual.length && !posts.length) return null;
  posts.sort((a, b) => b.date - a.date);
  return { member: m, epb, manual: uniqueManual, posts };
}

// Posts found in the saved copies are re-checked with Telegram (still there,
// still accusing this person); a handful of light requests in total.
async function parsConfirm(finds: ParsFind[]): Promise<ParsFind[]> {
  const out: ParsFind[] = [];
  let budget = 60;
  for (const f of finds) {
    if (f.posts.length && budget > 0 && hasUserbot() && Date.now() >= userBlockedUntil) {
      const byChannel = new Map<string, CheckHit[]>();
      for (const h of f.posts) byChannel.set(chatIdKey(h.channelId), [...(byChannel.get(chatIdKey(h.channelId)) || []), h]);
      const kept: CheckHit[] = [];
      for (const [key, hits] of byChannel) {
        const ch = [...checkChannels(), ...(epbCheckChannel() ? [epbCheckChannel()!] : [])].find((c) => chatIdKey(c.id) === key);
        if (!ch || budget <= 0) {
          kept.push(...hits);
          continue;
        }
        budget--;
        const subject = { username: f.member.usernames[0] || "", id: f.member.id, nick: "" };
        kept.push(...(await confirmMirrorHits(ch, loadMirror(ch), hits, subject)));
        await sleep(400);
      }
      f.posts = kept;
    }
    if (f.epb.length || f.manual.length || f.posts.length) out.push(f);
  }
  return out;
}

function parsDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

function parsFindHtml(f: ParsFind): string {
  const who = f.member.usernames.length ? f.member.usernames.map((u) => `@${escapeHtml(u)}`).join(", ") : escapeHtml(f.member.name || "без юзернейма");
  const lines = [`• <b>${who}</b> · ID <code>${f.member.id}</code>${f.member.name && f.member.usernames.length ? ` · ${escapeHtml(f.member.name.slice(0, 40))}` : ""}`];
  for (const e of f.epb.slice(0, 3)) {
    lines.push(`   EPB: ${e.link ? `<a href="${escapeHtml(e.link)}">жалоба ${escapeHtml(e.key)}</a>` : `жалоба ${escapeHtml(e.key)}`}${e.date ? ` (${parsDate(e.date)})` : ""}`);
  }
  const byTitle = new Map<string, CheckHit[]>();
  for (const h of f.posts) byTitle.set(h.channelTitle || "канал", [...(byTitle.get(h.channelTitle || "канал") || []), h]);
  for (const [title, hits] of byTitle) {
    const links = hits
      .slice(0, 3)
      .map((h) => `<a href="${escapeHtml(h.link)}">${parsDate(h.date) || "пост"}</a>`)
      .join(", ");
    lines.push(`   ${escapeHtml(title)}: ${links}${hits.length > 3 ? ` и ещё ${hits.length - 3}` : ""}`);
  }
  for (const x of f.manual.slice(0, 2)) lines.push(`   Ручной список: ${escapeHtml(x.source || x.account)}`);
  return lines.join("\n");
}

function parsFindText(f: ParsFind): string {
  const who = f.member.usernames.length ? f.member.usernames.map((u) => `@${u}`).join(", ") : f.member.name || "без юзернейма";
  const lines = [`${who} | ID ${f.member.id}${f.member.name ? ` | ${f.member.name}` : ""}`];
  for (const e of f.epb) lines.push(`  EPB: жалоба ${e.key}${e.link ? ` ${e.link}` : ""}`);
  for (const h of f.posts) lines.push(`  ${h.channelTitle}: ${h.link}`);
  for (const x of f.manual) lines.push(`  Ручной список: ${x.source || x.account}`);
  return lines.join("\n");
}

async function parsScan(t: ParsTarget, ownerChat: number | string) {
  const status = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: ownerChat,
    text: `⏳ «${t.title}»: выгружаю участников…`,
  });
  let lastEdit = 0;
  const say = async (text: string, force = false) => {
    if (!status?.message_id) return;
    if (!force && Date.now() - lastEdit < 4000) return;
    lastEdit = Date.now();
    await tgSoft("editMessageText", { chat_id: ownerChat, message_id: status.message_id, text });
  };
  let members: ParsMember[];
  let partial = "";
  try {
    const peer = await parsPrepare(t, (text) => say(text, true));
    const got = await parsFetchMembers(t, (n) => void say(`⏳ «${t.title}»: выгружено участников: ${n}${t.members ? ` из ~${Math.min(t.members, PARS_MAX)}` : ""}…`), peer);
    members = got.members;
    partial = got.partial;
  } catch (err) {
    await say(`⚠️ «${t.title}»: ${parsErrorText(err)}`, true);
    return;
  } finally {
    // the chat is left as it was before the check
    await parsRestore().catch(() => {});
  }
  await say(`⏳ «${t.title}»: сверяю ${members.length} участников с базой…`, true);
  const channels = checkChannels();
  const botPosts = new Set<number>();
  for (const rec of Object.values(pendingPosts)) for (const mid of rec.channelMsgIds || []) botPosts.add(mid);
  const raw: ParsFind[] = [];
  for (let i = 0; i < members.length; i++) {
    const f = parsLookup(members[i]!, channels, botPosts);
    if (f) raw.push(f);
    // let the bot breathe between small batches
    if (i % 50 === 49) {
      await new Promise((r) => setImmediate(r));
      void say(`⏳ «${t.title}»: сверено ${i + 1} из ${members.length}…`);
    }
  }
  const finds = await parsConfirm(raw);
  const hidden = t.members && members.length < t.members * 0.5 && t.members > 50;
  const head = [
    `✅ <b>Проверка чата завершена</b>`,
    `Чат: <b>${escapeHtml(t.title)}</b>`,
    `Проверено участников: ${members.length}${t.members ? ` из ${t.members}` : ""} (боты и удалённые аккаунты не считаются)`,
    partial ? `⚠️ ${escapeHtml(partial)}` : "",
    hidden && !partial ? "⚠️ Telegram отдал меньше половины участников — возможно, список участников скрыт настройками чата (тогда юзербот должен быть админом)." : "",
    "",
    finds.length ? `🚨 Найдено в базе: <b>${finds.length}</b>` : "Никого из участников нет в базе блеклистов 👍",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
  await say(`✅ «${t.title}»: готово, отчёт ниже.`, true);
  const shown = finds.slice(0, 40);
  const body = shown.map(parsFindHtml).join("\n\n");
  for (const part of splitHtml(body ? `${head}\n\n${body}` : head, 4000)) {
    await tgSoft("sendMessage", { chat_id: ownerChat, text: part, parse_mode: "HTML", disable_web_page_preview: true });
  }
  if (finds.length > shown.length || finds.length > 15) {
    // the full list as a file, easy to forward or keep
    const text = [`Проверка чата: ${t.title}`, `Проверено: ${members.length}`, `Найдено: ${finds.length}`, "", ...finds.map(parsFindText)].join("\n\n");
    const form = new FormData();
    form.set("chat_id", String(ownerChat));
    form.set("caption", `Полный список найденных: ${finds.length}`);
    form.set("document", new File([text], `pars-${t.chatId}.txt`, { type: "text/plain" }));
    try {
      await tgForm("sendDocument", form);
    } catch {
      /* the message above already has the main part */
    }
  }
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

// The owner's private panel (/userbot): the search account, the source channels
// with how far each one's copy has got, adding and removing channels. Never shown
// in the arbiter chat.
async function sendOwnerPanel(chatId: string | number, editMessageId?: number) {
  const st = await userbotStatus();
  const connected = st.ok;
  const channels = checkChannels();
  const n = (v: number) => v.toLocaleString("ru-RU");
  const lines = [
    "<b>Юзербот для поиска по блеклистам</b>",
    connected
      ? `Аккаунт: ${escapeHtml(st.name || "подключён")} ✅`
      : hasUserbot()
        ? `Аккаунт не отвечает: ${escapeHtml(st.error || "ошибка")}`
        : "Аккаунт не подключён",
    `Каналов для поиска: ${channels.length}`,
  ];
  const rows: { text: string; callback_data: string }[][] = [];
  if (hasUserbot()) {
    const base = blacklistBaseStats() || blacklistBase();
    const ms = mirrorStats();
    lines.push(
      "",
      "<b>📊 База блеклиста</b>",
      `~${n(base.accounts)} аккаунтов (ников ${n(base.usernames)}, ID ${n(base.ids)}) · постов ${n(base.posts)}`,
      `Скопировано целиком: ${base.complete} из ${base.channels} каналов${base.complete < base.channels ? ` · всего ~${base.progress}%` : ""}`,
      `Проверенных пар username → ID: ${n(ms.verifiedPairs)}`,
      "",
      ...ms.channels.slice(0, 25).map(
        (c) =>
          `• ${escapeHtml(cut(c.title, 32))} — ${n(c.posts)} постов — ` +
          (c.complete ? "✅ вся история" : c.failing ? "⚠️ нет доступа, повтор через 15 мин" : `⏳ ~${c.progress}%`),
      ),
    );
    if (ms.channels.length > 25) lines.push(`…и ещё ${ms.channels.length - 25}`);
    for (const c of channels.slice(0, 25)) rows.push([{ text: `🗑 ${cut(c.title || c.username || c.id, 36)}`, callback_data: `ub:del:${c.id}` }]);
    rows.push([{ text: "📡 Выбрать из подписок", callback_data: "ub:chans" }, { text: "➕ Добавить по @/ID", callback_data: "ub:add" }]);
    rows.push([{ text: "🔄 Обновить", callback_data: "ub:panel" }]);
    rows.push([{ text: "🔌 Переподключить аккаунт", callback_data: "ub:connect" }]);
    rows.push([{ text: "❌ Отключить аккаунт", callback_data: "ub:off" }]);
  } else {
    lines.push("", "Подключите свой аккаунт Telegram, затем выберите каналы, по которым искать. Понадобятся api_id и api_hash с my.telegram.org.");
    rows.push([{ text: "➕ Подключить аккаунт", callback_data: "ub:connect" }]);
  }
  const payload = { chat_id: chatId, text: lines.join("\n").slice(0, 4000), parse_mode: "HTML", reply_markup: { inline_keyboard: rows } };
  if (editMessageId) {
    const edited = await tgSoft("editMessageText", { ...payload, message_id: editMessageId });
    if (edited) return;
  }
  await tgSoft("sendMessage", payload);
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
  kickMirror();
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
  } else if (action === "panel") {
    await answer();
    await sendOwnerPanel(chatId, cb.message?.message_id);
  } else if (action === "add") {
    checkChannelSetup.add(String(chatId));
    await answer();
    await tgSoft("sendMessage", { chat_id: chatId, text: "Пришлите @username или ID канала (-100…). Аккаунт поиска должен быть на него подписан." });
  } else if (action === "del") {
    const target = rest.join(":");
    bindings.checkChannels = checkChannels().filter((c) => !sameChat(c.id, target));
    saveBindings();
    removeCheckChannelFromIndex(target);
    dropMirror(target);
    await answer("Канал убран");
    await sendOwnerPanel(chatId, cb.message?.message_id);
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
  invalidateCheckCache();
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
  // Hits per searched source (keys from checkSources()), for the app's scan animation.
  sourceHits?: Record<string, number>;
  // What is known about the account itself (see accountCard).
  account?: AccountCard;
};

export type AccountCard = {
  id: string;
  // where the id came from: typed in, Telegram (by username), or blacklist posts
  idSource: "input" | "telegram" | "posts";
  usernames: string[]; // current, when known
  name: string;
  premium: boolean;
  scam: boolean;
  fake: boolean;
  bot: boolean;
  verified: boolean;
  reg: { year: number; part: 0 | 1 | 2; later?: boolean; months?: number } | null;
  // usernames this account had before (seen in blacklist posts or by the bot)
  previous: { username: string; since: number; source: "post" | "bot"; where?: string }[];
  lastSeen?: LastSeen;
  hasPhoto?: boolean;
  restricted?: string;
  about?: string;
  channel?: { title: string; username?: string };
  // our own data: first time this account showed up in a blacklist, and where
  firstListed?: number; // unix seconds
  listedIn?: number; // sources
};

// id <-> username links found in blacklist posts: a post whose accused fields
// hold exactly one @username and one id ties the two together.
function postLinks(q: { username?: string; id?: string }): { username: string; id: string; date: number; where: string }[] {
  const needle = q.id || (q.username || "").toLowerCase();
  if (!needle) return [];
  const out: { username: string; id: string; date: number; where: string }[] = [];
  for (const ch of mirrorChannels()) {
    const m = loadMirror(ch);
    for (const msg of mirrorCandidates(m, [needle])) {
      if (!msg.low.includes(needle)) continue;
      const fields = [...accusedFields(msg.text)];
      const handles = fields.filter((f) => f.startsWith("@"));
      const ids = fields.filter((f) => !f.startsWith("@"));
      if (handles.length !== 1 || ids.length !== 1) continue;
      const link = { username: handles[0]!.slice(1), id: ids[0]!, date: msg.date, where: ch.title || ch.username || "" };
      if ((q.id && link.id === q.id) || (q.username && link.username === q.username.toLowerCase())) out.push(link);
    }
  }
  return out;
}

// Every username known for an account id: what the bot has seen itself plus
// what blacklist posts tie to the id. Oldest sighting first.
function knownUsernames(id: string): { username: string; since: number; source: "post" | "bot"; where?: string }[] {
  const byName = new Map<string, { username: string; since: number; source: "post" | "bot"; where?: string }>();
  const add = (username: string, since: number, source: "post" | "bot", where?: string) => {
    const u = username.toLowerCase();
    const have = byName.get(u);
    if (!have || (since && (!have.since || since < have.since))) byName.set(u, { username: u, since: since || have?.since || 0, source, where });
  };
  for (const e of usernameHistory[id] || []) add(e.u, e.first, "bot");
  for (const [u, v] of Object.entries(idCache)) if (v === id) add(u, 0, "bot");
  for (const l of postLinks({ id })) add(l.username, l.date, "post", l.where);
  return [...byName.values()].sort((a, b) => (a.since || Infinity) - (b.since || Infinity));
}

// Display name of a connected check channel (WWH channels collapse into one "WWH").
function checkSourceName(title: string): string {
  return /wwh/i.test(title || "") ? "WWH" : title || "Источник";
}

// What a counterparty check searches, in display order: our blacklist, every
// connected channel/chat, then the third-party (manual) blacklist.
export function checkSources(): { key: string; title: string }[] {
  if (!checkEnabled()) return [];
  const out: { key: string; title: string }[] = [{ key: "epb", title: "Europe Private Blacklist" }];
  for (const c of checkChannels()) {
    const name = checkSourceName(c.title || c.username || "");
    if (!out.some((o) => o.key === `ch:${name}`)) out.push({ key: `ch:${name}`, title: name });
  }
  out.push({ key: "manual", title: "Сторонние блеклисты" });
  return out;
}

// A compact entry for the "recent blacklists" list. Deliberately light (no
// story/summary) so the list loads fast; the full text is fetched on tap.
export type BlacklistEntry = {
  kind: "epb" | "manual" | "find";
  id: string;
  account: string;
  amount?: string;
  currency?: string;
  date: number;
  source?: string;
  note?: string;
};

const DEFAULT_MANUAL_SOURCE = "Сторонний источник";
const RECENT_FINDS_MAX = 25;

// Record a successful counterparty check into the shared recent list. De-duped
// by username/id (an existing entry is refreshed and moved to the front), capped.
function recordFind(uname: string, id: string, display: string, result: CheckResult) {
  // Only external forum/chat discoveries are worth recording — anything in the
  // EPB or manual blacklist is already shown in the recent list on its own.
  if (!result.channels.length) return;
  if (!uname && !id) return;
  // Name the actual source channels (WWH shortened), not a generic label.
  const sources: string[] = [];
  for (const c of result.channels) {
    const title = c.channelTitle || "источник";
    const name = /wwh/i.test(title) ? "WWH" : title;
    if (!sources.includes(name)) sources.push(name);
  }
  const list = [...(bindings.recentFinds || [])];
  const same = (f: RecentFind) =>
    (uname && (f.username || "").toLowerCase() === uname) || (id && f.telegramId === id);
  const prev = list.find(same);
  const entry: RecentFind = {
    id: prev?.id || `find-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    username: uname || undefined,
    telegramId: id || undefined,
    label: display || (uname ? `@${uname}` : `ID ${id}`),
    sources,
    at: Date.now(),
  };
  bindings.recentFinds = [entry, ...list.filter((f) => !same(f))].slice(0, RECENT_FINDS_MAX);
  saveBindings();
}

// The most recent blacklist entries, newest first: our EPB blacklist plus the
// manually added (third-party) ones. The home ticker filters to EPB only; the
// check page shows both.
export function recentBlacklist(limit = 24): BlacklistEntry[] {
  if (!checkEnabled()) return [];
  const out: BlacklistEntry[] = [];
  // Handles/ids already represented by an EPB or manual entry, so the same
  // account isn't shown twice when it's also in the recent-finds list.
  const shownKeys = new Set<string>();
  const key = (v?: string) => (v || "").replace(/^@/, "").toLowerCase().trim();
  for (const [k, rec] of Object.entries(pendingPosts)) {
    if (rec.status !== "published" || !rec.channelPosted || rec.removedFromCheck) continue;
    out.push({
      kind: "epb",
      id: k,
      account: scamLabel(rec),
      amount: rec.amount || "",
      currency: rec.currency || "",
      date: rec.createdAt || 0,
    });
    for (const a of pendingAccounts(rec)) {
      if (a.username) shownKeys.add(key(a.username));
      if (a.id) shownKeys.add(key(a.id));
    }
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
    if (e.username) shownKeys.add(key(e.username));
    if (e.telegramId) shownKeys.add(key(e.telegramId));
  }
  for (const f of bindings.recentFinds || []) {
    // Skip a find that's already shown as an EPB/manual entry.
    if ((f.username && shownKeys.has(key(f.username))) || (f.telegramId && shownKeys.has(key(f.telegramId)))) continue;
    out.push({ kind: "find", id: f.id, account: f.label, date: f.at, source: (f.sources || []).join(" · ") });
  }
  out.sort((a, b) => b.date - a.date);
  return out.slice(0, Math.max(1, limit));
}

// Full detail for one blacklist entry, fetched when a card is opened.
export type BlacklistDetailResult = {
  kind: "epb" | "manual" | "find";
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
      // Public card: only the short summary that went into the post. The detailed
      // story is for arbiters only and is never sent to the app.
      story: "",
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
  const find = (bindings.recentFinds || []).find((f) => f.id === id);
  if (find) {
    return {
      kind: "find",
      id,
      account: find.label,
      date: find.at,
      source: (find.sources || []).join(" · "),
      note: "Найден по запросу проверки контрагента.",
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
// Recent results per query, so repeated checks of the same handle (by many
// people, or someone hammering it) don't hit the userbot again.
const checkCache = new Map<string, { at: number; res: CheckResult }>();
const checkInflight = new Map<string, Promise<CheckResult>>();

// At most a few scans of the channel copies run at the same time (pure CPU work);
// the rest wait their turn. Same total speed, but the bot keeps answering other
// people in between. Telegram requests are not held by this.
const SEARCH_SLOTS = 4;
let searchBusy = 0;
const searchWaiters: (() => void)[] = [];
async function withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (searchBusy >= SEARCH_SLOTS) await new Promise<void>((r) => searchWaiters.push(r));
  searchBusy++;
  try {
    return await fn();
  } finally {
    searchBusy--;
    searchWaiters.shift()?.();
  }
}
const CHECK_CACHE_TTL = 5 * 60_000;

// A forum nickname typed as plain text (WWH nicknames can contain spaces):
// used only when the input is neither a @username, a link nor an id.
export function nicknameFromInput(input: string): string {
  const t = (input || "").replace(/^@/, "").replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > 40) return "";
  if (!/\p{L}/u.test(t) || /[<>{}\[\]\\/|]/.test(t) || /t\.me|https?:/i.test(t)) return "";
  return t;
}

export async function checkCounterparty(input: string): Promise<CheckResult> {
  if (!checkEnabled()) return { query: { username: "", id: "" }, epb: [], channels: [], manual: [] };
  const cacheKey = (() => {
    const p = parseTelegramInput(input);
    const nick = p.username || p.id ? "" : nicknameFromInput(input).toLowerCase().replace(/[\s_.\-]+/g, " ");
    return `${p.username.replace(/^@/, "").toLowerCase()}|${p.id}|${nick}`;
  })();
  const hit = checkCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CHECK_CACHE_TTL && cacheKey !== "||") return hit.res;
  // many people checking the same account at once: one search for all of them
  const running = cacheKey !== "||" ? checkInflight.get(cacheKey) : undefined;
  if (running) return running;
  const job = checkCounterpartyUncached(input);
  if (cacheKey !== "||") {
    checkInflight.set(cacheKey, job);
    void job.catch(() => {}).finally(() => checkInflight.delete(cacheKey));
  }
  const res = await job;
  if (cacheKey !== "||") {
    checkCache.set(cacheKey, { at: Date.now(), res });
    if (checkCache.size > 2000) checkCache.delete(checkCache.keys().next().value!);
  }
  return res;
}

async function checkCounterpartyUncached(input: string): Promise<CheckResult> {
  const parsed = parseTelegramInput(input);
  // Off-limits service handles (@ctoroot, @sbepbank, the arbiter, the bot) are
  // never searched or shown; an id in the same input is still honoured.
  const uname = isIgnoredHandle(parsed.username) ? "" : parsed.username.replace(/^@/, "").toLowerCase();
  const id = parsed.id;
  // "Dark Money": a forum nickname with a space, searched in the channels only.
  const nick = !parsed.username && !id ? nicknameFromInput(input) : "";
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
  let effectiveId = id;
  let idSource: AccountCard["idSource"] | "" = id ? "input" : "";
  if (uname && !effectiveId) {
    // Resolve the username to its id so we can also match on the numeric id,
    // which blacklist posts carry and search never mis-tokenizes.
    const r = await resolveUsernameMtproto(uname, "");
    if (r && r !== "busy" && r.id) {
      effectiveId = r.id;
      idSource = "telegram";
    }
  }
  if (uname && !effectiveId) {
    // Telegram doesn't know the username any more (account deleted or renamed):
    // blacklist posts often still tie it to the id ("Кидала: @x / ID: 123").
    const counts = new Map<string, number>();
    for (const l of postLinks({ username: uname })) counts.set(l.id, (counts.get(l.id) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      effectiveId = best[0];
      idSource = "posts";
    }
  }
  // Earlier usernames of the same account are searched too (posts written
  // before a rename carry only the old one).
  const known = effectiveId ? knownUsernames(effectiveId) : [];
  const profile = effectiveId ? profileCache.get(effectiveId) : undefined;
  const oldNames = known
    .map((k) => k.username)
    .filter((u) => u !== uname && !profile?.usernames.includes(u))
    .slice(0, 3);
  // The saved copies are searched even when the search account is switched off
  // or gone: what was copied stays searchable.
  const haveCopies = hasUserbot() || channels.some((c) => loadMirror(c).msgs.size > 0);
  if (haveCopies && channels.length && (uname || id || nick)) {
    // postMatchesSubject then decides whether a post actually accuses this
    // username/id/nickname (vs mentions it as a contact/ad).
    // A handle like "dark_money" is often written "Dark Money" on the forum: also
    // look for it as a nickname (strict rules only, see postMatchesSubject).
    const subject = { username: uname, id: effectiveId, nick: nick || (/[_.]/.test(uname) ? uname : "") };
    const searchTerms = [uname, effectiveId, nick].filter(Boolean) as string[];
    // The local copies first (instant, whole history), channel by channel with a
    // pause in between so no single search holds the bot.
    const scanned = await withSearchSlot(async () => {
      const out: { channel: CheckChannel; m: Mirror; found: CheckHit[]; old: { sub: { username: string; id: string; nick: string }; found: CheckHit[] }[] }[] = [];
      for (const channel of channels) {
        await new Promise((r) => setImmediate(r));
        const m = loadMirror(channel);
        const found = m.msgs.size ? searchMirror(channel, m, subject) : [];
        const old = m.msgs.size
          ? oldNames.map((o) => {
              const sub = { username: o, id: "", nick: "" };
              return { sub, found: searchMirror(channel, m, sub) };
            })
          : [];
        out.push({ channel, m, found, old });
      }
      return out;
    });
    for (const { channel, m, found, old } of scanned) {
      if (found.length) push(await confirmMirrorHits(channel, m, found, subject));
      if (!m.complete && hasUserbot()) {
        // Copy not finished yet: older posts may be missing from it, so also ask
        // Telegram's search (the recent posts are already in the copy, so the
        // slow history scan is skipped once the copy has started).
        // The 800-post scan is skipped only once the copy (filled newest first)
        // already holds at least that many posts.
        for (const term of searchTerms) push(await userSearchChannel(channel, term, subject, m.msgs.size >= 800));
      }
      for (const o of old) if (o.found.length) push(await confirmMirrorHits(channel, m, o.found, o.sub));
    }
  } else if (uname || id) {
    // Fallback: posts indexed by the bot since each channel was connected.
    for (const token of [uname ? `@${uname}` : "", id].filter(Boolean)) push(checkIndex[token] || []);
  }
  // Posts written by hand in our own channel. Skipped when this person has any
  // complaint filed through the bot: those are found above (and an admin's
  // "remove from check" must not be undone by the channel post).
  const epbChannel = epbCheckChannel();
  const hasBotRecord = Object.values(pendingPosts).some((rec) =>
    pendingAccounts(rec).some(
      (a) => (uname && a.username.replace(/^@/, "").toLowerCase() === uname) || (id && a.id === id),
    ),
  );
  if (epbChannel && (uname || id) && !hasBotRecord) {
    const m = loadMirror(epbChannel);
    if (m.msgs.size) {
      const botPosts = new Set<number>();
      for (const rec of Object.values(pendingPosts)) for (const mid of rec.channelMsgIds || []) botPosts.add(mid);
      const subject = { username: uname, id: effectiveId, nick: "" };
      const found = searchMirror(epbChannel, m, subject).filter((h) => !botPosts.has(h.messageId));
      push(found.length ? await confirmMirrorHits(epbChannel, m, found, subject) : []);
    }
  }
  hits.sort((a, b) => b.date - a.date);
  // taken out of the search by the arbiters: other channels' posts don't count
  if (isExcludedAccount([uname, ...oldNames], effectiveId || id)) hits.length = 0;
  const manual = matchManualBlacklist(uname, id);
  const sourceHits: Record<string, number> = { epb: epb.length, manual: manual.length };
  for (const h of hits) {
    const ch = isCheckChannel(h.channelId);
    const key =
      epbChannel && !ch && sameChat(h.channelId, epbChannel.id)
        ? "epb"
        : `ch:${checkSourceName(ch?.title || ch?.username || h.channelTitle)}`;
    sourceHits[key] = (sourceHits[key] || 0) + 1;
  }
  const result: CheckResult = { query: { username: uname, id }, epb, channels: hits.slice(0, 30), manual, sourceHits };
  if (effectiveId || known.length) {
    // Wait for the profile request at most 2.5 s; a slow answer still lands in
    // the cache for the next check.
    if (effectiveId && idSource === "telegram") await Promise.race([fetchFullProfile(effectiveId), sleep(2500)]);
    let usernames = profile?.usernames || (idSource === "telegram" && uname ? [uname] : []);
    let name = profile?.name || "";
    if (!uname && effectiveId && !profile) {
      // An id typed in: the Bot API knows users who have met the bot.
      const chat = await tgSoft<{ type?: string; username?: string; first_name?: string; last_name?: string }>("getChat", { chat_id: effectiveId });
      if (chat?.type === "private") {
        if (chat.username) {
          usernames = [chat.username.toLowerCase()];
          noteUsername(effectiveId, chat.username);
        }
        name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
      }
    }
    result.account = {
      id: effectiveId,
      idSource: (idSource || "posts") as AccountCard["idSource"],
      usernames,
      name,
      premium: Boolean(profile?.premium),
      scam: Boolean(profile?.scam),
      fake: Boolean(profile?.fake),
      bot: Boolean(profile?.bot),
      verified: Boolean(profile?.verified),
      reg: effectiveId ? registrationEstimate(effectiveId) : null,
      previous: known.filter((k) => !usernames.includes(k.username)).slice(0, 8),
      lastSeen: profile?.lastSeen,
      hasPhoto: profile ? profile.hasPhoto : undefined,
      restricted: profile?.restricted || undefined,
      about: profile?.about || undefined,
      channel: profile?.channel,
    };
    // Our own data: when this account first showed up in a blacklist, and in how many sources.
    const dates = [...epb.map((e) => Math.floor(e.date / 1000)), ...hits.map((h) => Math.floor(h.date / 1000)), ...manual.map((m) => Math.floor(m.date / 1000))].filter((d) => d > 0);
    if (dates.length) result.account.firstListed = Math.min(...dates);
    const srcCount = Object.values(sourceHits).filter((n) => n > 0).length;
    if (srcCount) result.account.listedIn = srcCount;
  }
  const display = uname ? `@${parsed.username.replace(/^@/, "")}` : id ? `ID ${id}` : "";
  return result;
}

// Viewing check data (latest list, a post, a complaint card) is cheap: it has its
// own per-user budget and never uses up the search limits.
export function allowView(initData: string): { ok: true; userId: string } | { ok: false; error: string } {
  if (!checkEnabled()) return { ok: false, error: "disabled" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`view:${user.id}`, 90, 60_000)) return { ok: false, error: "too many" };
  return { ok: true, userId: user.id };
}

export function allowCheck(initData: string): { ok: true; userId: string } | { ok: false; error: string } {
  if (!checkEnabled()) return { ok: false, error: "disabled" };
  const user = verifyTelegramInitData(initData);
  if (!user) return { ok: false, error: "telegram auth required" };
  if (tooMany(`check:${user.id}`, 30, 60_000)) return { ok: false, error: "too many" };
  if (tooMany("check:global", 600, 60_000)) return { ok: false, error: "busy" };
  return { ok: true, userId: user.id };
}

// ---- Captcha for frequent counterparty checks (app and bot share it). ----
// After CAPTCHA_AFTER checks within CAPTCHA_WINDOW a user must solve an image
// captcha (a distorted Russian word); solving grants CAPTCHA_CREDIT checks.
const CAPTCHA_AFTER = 5;
const CAPTCHA_WINDOW = 3 * 60_000;
const CAPTCHA_CREDIT = 15;
const checkTimes = new Map<string, number[]>();
const captchaCredit = new Map<string, number>();
// purpose "check" unlocks more counterparty checks; "submit" unlocks sending one
// complaint. They are kept apart so a check captcha never skips the complaint one.
type CaptchaPurpose = "check" | "submit";
const captchaPending = new Map<string, { word: string; exp: number; tries: number; purpose: CaptchaPurpose }>();
// A solved captcha also allows sending one complaint within 15 minutes.
const submitPass = new Map<string, number>();

export function hasSubmitPass(userId: string): boolean {
  // No owner exemption: everyone, the owner included, solves the captcha.
  const uid = String(userId);
  const exp = submitPass.get(uid) || 0;
  return exp > Date.now();
}

export function consumeSubmitPass(userId: string) {
  submitPass.delete(String(userId));
}

// Returns true when this user must solve a captcha before the next check;
// otherwise records the check.
export function captchaRequired(userId: string): boolean {
  const uid = String(userId);
  const credit = captchaCredit.get(uid) || 0;
  if (credit > 0) {
    captchaCredit.set(uid, credit - 1);
    return false;
  }
  const now = Date.now();
  const times = (checkTimes.get(uid) || []).filter((t) => now - t < CAPTCHA_WINDOW);
  if (times.length >= CAPTCHA_AFTER) {
    checkTimes.set(uid, times);
    return true;
  }
  times.push(now);
  checkTimes.set(uid, times);
  if (checkTimes.size > 20_000) checkTimes.clear();
  return false;
}

// A fresh captcha image for this user (null when they request too many images).
// Wrong answers per user in the last 30 min. Past the limit no new picture is
// given, so a script can't just keep guessing words from the list.
const captchaWrong = new Map<string, number[]>();
const CAPTCHA_WRONG_MAX = 8;
const CAPTCHA_WRONG_WINDOW = 30 * 60_000;

function recentWrong(uid: string): number[] {
  const now = Date.now();
  const list = (captchaWrong.get(uid) || []).filter((t) => now - t < CAPTCHA_WRONG_WINDOW);
  if (list.length) captchaWrong.set(uid, list);
  else captchaWrong.delete(uid);
  return list;
}

export function newCaptchaImage(userId: string, purpose: CaptchaPurpose = "check"): Buffer | null {
  const uid = String(userId);
  if (recentWrong(uid).length >= CAPTCHA_WRONG_MAX) return null;
  if (tooMany(`capimg:${uid}`, 12, 10 * 60_000)) return null;
  const word = randomCaptchaWord();
  captchaPending.set(uid, { word, exp: Date.now() + 5 * 60_000, tries: 0, purpose });
  if (captchaPending.size > 20_000) {
    const now = Date.now();
    for (const [k, v] of captchaPending) if (v.exp < now) captchaPending.delete(k);
    if (captchaPending.size > 50_000) captchaPending.clear();
  }
  return renderCaptcha(word);
}

// "again": wrong, and this picture is used up (a new one is needed).
export function solveCaptcha(userId: string, answer: string): "ok" | "wrong" | "again" | "expired" {
  const uid = String(userId);
  const p = captchaPending.get(uid);
  if (!p || Date.now() > p.exp) {
    captchaPending.delete(uid);
    return "expired";
  }
  if (normalizeCaptchaAnswer(answer) === normalizeCaptchaAnswer(p.word)) {
    captchaPending.delete(uid);
    if (p.purpose === "submit") {
      submitPass.set(uid, Date.now() + 15 * 60_000);
      if (submitPass.size > 20_000) submitPass.clear();
    } else {
      checkTimes.delete(uid);
      captchaCredit.set(uid, CAPTCHA_CREDIT);
    }
    return "ok";
  }
  p.tries += 1;
  const wrong = recentWrong(uid);
  wrong.push(Date.now());
  captchaWrong.set(uid, wrong);
  if (captchaWrong.size > 20_000) captchaWrong.clear();
  if (p.tries >= 2 || wrong.length >= CAPTCHA_WRONG_MAX) {
    captchaPending.delete(uid);
    return "again";
  }
  return "wrong";
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
    let result: { message_id: number; photo?: { file_id: string }[]; video?: { file_id: string } }[];
    try {
      result = await tgForm("sendMediaGroup", form);
    } catch (err) {
      // one picture Telegram won't take as a photo spoils the whole album:
      // send this part one by one (the odd picture goes as a document)
      if (!isPhotoRefused(err)) throw err;
      for (const [idx, file] of chunk.entries()) {
        const sent = await sendMediaFile(chatId, file, i === 0 && idx === 0 && packed.caption ? { caption: packed.caption } : {});
        if (sent.fileId) files.push({ type: sent.kind, file_id: sent.fileId });
        if (i === 0 && idx === 0) firstId = sent.message_id;
      }
      continue;
    }
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
    // Only a real Telegram username shape is kept (it ends up in posts and markers).
    if (!/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(account.username)) account.username = "";
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
  if (!scammerAccounts(app).some((a) => a.telegramId)) {
    return { ok: false, error: btUser(userId, "needAccountSubmit") };
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

// The channel and the relay chats get one post: the text plus as much evidence
// as fits in a single album (photos and videos first, up to 10). The arbiters'
// chat still receives every file.
function oneAlbum<T extends { type?: string; kind?: string }>(files: T[]): T[] {
  const visual = files.filter((f) => (f.type || f.kind) !== "document");
  return (visual.length ? visual : files).slice(0, 10);
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
  files = oneAlbum(files);
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
  forgetPublished(key);
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
    (postMedia(rec).length
      ? `\nК посту приложится: ${Math.min(10, postMedia(rec).length)} (в канал уходит не больше 10)${rec.postFiles ? " — фото изменены" : ""}`
      : "\nБез фото") +
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

// ---- Rejecting with a reason ----
function rejectChoiceKeyboard(key: string) {
  return {
    inline_keyboard: [
      [{ text: "✍ Указать причину", callback_data: `rejr:${key}` }],
      [{ text: "Отклонить без причины", callback_data: `rejn:${key}` }],
      [{ text: "↩ Назад", callback_data: `rejb:${key}` }],
    ],
  };
}

type ReviewCard = { chatId: number | string; messageId: number; text: string; isMedia: boolean };
// prompt (chat:message) -> the complaint and its review card
const rejectPrompts = new Map<string, { key: string; card: ReviewCard; at: number }>();

async function askRejectReason(card: NonNullable<NonNullable<TgUpdate["callback_query"]>["message"]>, key: string, text: string) {
  const prompt = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: card.chat.id,
    text: `<b>Причина отказа по заявке ${escapeHtml(key)}</b>\n\nОтветьте на это сообщение причиной — она уйдёт заявителю.`,
    parse_mode: "HTML",
    reply_to_message_id: card.message_id,
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Причина отказа" },
  });
  if (!prompt?.message_id) return;
  for (const [k, v] of rejectPrompts) if (Date.now() - v.at > 60 * 60_000) rejectPrompts.delete(k);
  rejectPrompts.set(`${card.chat.id}:${prompt.message_id}`, {
    key,
    card: { chatId: card.chat.id, messageId: card.message_id, text, isMedia: Boolean((card as { photo?: unknown }).photo || (card as { video?: unknown }).video || (card as { caption?: string }).caption) },
    at: Date.now(),
  });
}

async function handleRejectReasonReply(msg: TgMessage): Promise<boolean> {
  const replyTo = msg.reply_to_message?.message_id;
  if (!replyTo) return false;
  const pending = rejectPrompts.get(`${msg.chat.id}:${replyTo}`);
  if (!pending) return false;
  const reason = (msg.text || msg.caption || "").replace(/\s+\n/g, "\n").trim();
  if (reason.length < 2) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Причина пустая. Ответьте на сообщение бота ещё раз.", reply_to_message_id: msg.message_id });
    return true;
  }
  rejectPrompts.delete(`${msg.chat.id}:${replyTo}`);
  const rec = pendingPosts[pending.key];
  if (rec?.status === "published" || publishing.has(pending.key)) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Заявка уже опубликована.", reply_to_message_id: msg.message_id });
    return true;
  }
  await rejectComplaint(pending.key, reason.slice(0, 600), pending.card);
  void tgSoft("deleteMessage", { chat_id: msg.chat.id, message_id: replyTo });
  return true;
}

async function rejectComplaint(key: string, reason: string, card: ReviewCard) {
  const record = key ? pendingPosts[key] : undefined;
  if (record && record.status !== "rejected") {
    record.status = "rejected";
    if (reason) record.rejectReason = reason;
    savePending();
    await notifyApplicant(record, key, "rejected");
  }
  const next = `${escapeHtml(stripServiceMarker(card.text))}\n\nСтатус: отклонено${reason ? `\nПричина: ${escapeHtml(reason)}` : ""}`;
  await replaceReplyMarkup(
    { chat: { id: Number(card.chatId), type: "supergroup" }, message_id: card.messageId, ...(card.isMedia ? { caption: card.text } : { text: card.text }) } as never,
    { inline_keyboard: [] },
    next,
  );
}

// ---- The post's photos: remove some, add the arbiters' own ----
function postMedia(rec: PendingPost): MediaRef[] {
  return rec.postFiles ?? rec.files ?? [];
}

// reply prompt (chat:message) -> complaint key; album id -> complaint key
const photoPrompts = new Map<string, { key: string; at: number }>();
const photoAlbums = new Map<string, { key: string; at: number }>();
const POST_MEDIA_MAX = 30;

function photoManagerKeyboard(key: string) {
  const rec = pendingPosts[key];
  const list = rec ? postMedia(rec) : [];
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < list.length; i += 5) {
    rows.push(list.slice(i, i + 5).map((_, j) => ({ text: `✖ ${i + j + 1}`, callback_data: `pfdel:${key}:${i + j}` })));
  }
  rows.push([{ text: "➕ Добавить свои", callback_data: `pfadd:${key}` }]);
  if (rec?.postFiles) rows.push([{ text: "↩ Вернуть фото из заявки", callback_data: `pforig:${key}` }]);
  rows.push([{ text: "✅ Готово — предпросмотр", callback_data: `pview:${key}` }]);
  return { inline_keyboard: rows };
}

function photoManagerText(key: string): string {
  const rec = pendingPosts[key];
  const n = rec ? postMedia(rec).length : 0;
  return [
    `<b>Фото поста ${escapeHtml(key)}</b>`,
    "",
    n ? `Сейчас в посте: ${n}. Номера — как подписи на фото выше.` : "Сейчас пост без фото.",
    n > 10 ? "В канал и рассылку уйдут первые 10." : "",
    "✖ — убрать фото из поста (из заявки оно не удаляется). ➕ — прислать свои.",
  ]
    .filter(Boolean)
    .join("\n");
}

// The current media as numbered albums, so the arbiters see what each number is.
async function showPostMedia(chatId: number | string, key: string) {
  const rec = pendingPosts[key];
  if (!rec) return;
  const list = postMedia(rec);
  for (let i = 0; i < list.length; i += 10) {
    const part = list.slice(i, i + 10);
    const visual = part.every((f) => f.type !== "document");
    if (part.length > 1 && visual) {
      await tgSoft("sendMediaGroup", {
        chat_id: chatId,
        media: part.map((f, j) => ({ type: f.type, media: f.file_id, caption: `№${i + j + 1}` })),
      });
    } else {
      for (const [j, f] of part.entries()) {
        const method = f.type === "video" ? "sendVideo" : f.type === "document" ? "sendDocument" : "sendPhoto";
        await tgSoft(method, { chat_id: chatId, [f.type === "video" ? "video" : f.type === "document" ? "document" : "photo"]: f.file_id, caption: `№${i + j + 1}` });
      }
    }
  }
  await tgSoft("sendMessage", { chat_id: chatId, text: photoManagerText(key), parse_mode: "HTML", reply_markup: photoManagerKeyboard(key) });
}

async function handlePostPhotoCallback(cb: NonNullable<TgUpdate["callback_query"]>) {
  const [action, key = "", idxRaw = ""] = (cb.data || "").split(":");
  const rec = pendingPosts[key];
  const chatId = cb.message!.chat.id;
  if (!rec || (rec.status || "pending") !== "pending") {
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже обработана", show_alert: true });
    return;
  }
  if (action === "pfoto") {
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
    await showPostMedia(chatId, key);
    return;
  }
  if (action === "pfdel") {
    const idx = Number(idxRaw);
    const list = [...postMedia(rec)];
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Этого фото уже нет" });
      return;
    }
    list.splice(idx, 1);
    rec.postFiles = list;
    savePending();
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: `Фото №${idx + 1} убрано` });
    // numbers shift after a removal: show the post's media again
    await showPostMedia(chatId, key);
    return;
  }
  if (action === "pforig") {
    delete rec.postFiles;
    savePending();
    await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Вернули фото из заявки" });
    await showPostMedia(chatId, key);
    return;
  }
  // pfadd
  await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Ответьте на сообщение бота фото или видео" });
  const prompt = await tgSoft<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: `<b>Добавить фото в пост ${escapeHtml(key)}</b>\n\nОтветьте на это сообщение фото или видео (можно альбомом).`,
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Фото или видео" },
  });
  if (prompt?.message_id) {
    for (const [k, v] of photoPrompts) if (Date.now() - v.at > 60 * 60_000) photoPrompts.delete(k);
    photoPrompts.set(`${chatId}:${prompt.message_id}`, { key, at: Date.now() });
  }
}

const photoAlbumTimers = new Map<string, ReturnType<typeof setTimeout>>();
async function handlePostPhotoReply(msg: TgMessage): Promise<boolean> {
  const replyTo = msg.reply_to_message?.message_id;
  let target = replyTo ? photoPrompts.get(`${msg.chat.id}:${replyTo}`) : undefined;
  // the rest of an album sent as the answer (only its first part may carry the reply)
  if (!target && msg.media_group_id) target = photoAlbums.get(`${msg.chat.id}:${msg.media_group_id}`);
  if (!target) return false;
  const rec = pendingPosts[target.key];
  if (!rec || (rec.status || "pending") !== "pending") {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Заявка уже обработана, фото не добавлены.", reply_to_message_id: msg.message_id });
    return true;
  }
  const media: MediaRef | null = msg.photo?.length
    ? { type: "photo", file_id: msg.photo.at(-1)!.file_id }
    : msg.video?.file_id
      ? { type: "video", file_id: msg.video.file_id }
      : null;
  if (!media) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: "Нужны фото или видео. Ответьте на сообщение бота ещё раз.", reply_to_message_id: msg.message_id });
    return true;
  }
  const list = [...postMedia(rec)];
  if (list.length >= POST_MEDIA_MAX) {
    await tgSoft("sendMessage", { chat_id: msg.chat.id, text: `В посте уже ${POST_MEDIA_MAX} файлов — сначала уберите лишние.`, reply_to_message_id: msg.message_id });
    return true;
  }
  list.push(media);
  rec.postFiles = list;
  savePending();
  const albumKey = msg.media_group_id ? `${msg.chat.id}:${msg.media_group_id}` : "";
  if (albumKey) photoAlbums.set(albumKey, { key: target.key, at: Date.now() });
  // one summary after the whole album has arrived
  const timerKey = albumKey || `${msg.chat.id}:${msg.message_id}`;
  const prev = photoAlbumTimers.get(timerKey);
  if (prev) clearTimeout(prev);
  const key = target.key;
  photoAlbumTimers.set(
    timerKey,
    setTimeout(() => {
      photoAlbumTimers.delete(timerKey);
      if (albumKey) photoAlbums.delete(albumKey);
      void showPostMedia(msg.chat.id, key);
    }, 1500),
  );
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
  const files = stored?.postFiles ? stored.postFiles : stored?.files?.length ? stored.files : extraFiles;
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
    rememberPublished(key);
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

type TgUser = { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
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
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
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
  // The current wizard prompt's message id, so the next step can replace it
  // (delete + resend) instead of stacking a new message each time.
  stepMsgId?: number;
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
  rows.push([{ text: tb(locale, "myProfileBtn"), callback_data: "myprofile" }]);
  if (checkEnabled()) rows.push([{ text: tb(locale, "checkMenuBtn"), callback_data: "bcheck" }]);
  rows.push([{ text: tb(locale, "sponsorsMenuBtn"), callback_data: "bsponsors" }]);
  rows.push([
    { text: tb(locale, "channel"), url: CHANNEL_URL },
    { text: tb(locale, "ownersBtn"), callback_data: "owners" },
  ]);
  rows.push([{ text: tb(locale, "langBtn"), callback_data: "lang" }]);
  return { inline_keyboard: rows };
}

// Users who tapped "Проверить контрагента" — their next text is the query.
const checkWait = new Set<string>();

function backToMenuKeyboard(locale: Locale) {
  return { inline_keyboard: [[{ text: `⬅️ ${tb(locale, "back")}`, callback_data: "home" }]] };
}

function checkResultKeyboard(locale: Locale) {
  return {
    inline_keyboard: [
      [{ text: tb(locale, "checkMore"), callback_data: "bcheck" }],
      [{ text: tb(locale, "inMenu"), callback_data: "home" }],
    ],
  };
}

// Sponsors list for the bot: chat titles as links (admin-set links only).
async function botSponsorsText(locale: Locale): Promise<string> {
  const list = await listSponsors().catch(() => [] as Awaited<ReturnType<typeof listSponsors>>);
  const lines = [`<b>${tb(locale, "sponsorsMenuBtn").replace(/^\s*[^\p{L}\p{N}]+\s*/u, "")}</b>`, ""];
  if (!list.length) {
    lines.push(tb(locale, "sponsorsEmptyB"));
    return lines.join("\n");
  }
  for (const s of list.slice(0, 20)) {
    lines.push(s.link ? `• <a href="${s.link}">${escapeHtml(s.title)}</a>` : `• ${escapeHtml(s.title)}`);
  }
  if (list.length > 20) lines.push(`… +${list.length - 20}`);
  return lines.join("\n");
}

// Formats a counterparty-check result for a bot message.
export function regEstimateText(locale: Locale, reg: AccountCard["reg"]): string {
  if (!reg) return "";
  const en = locale === "en";
  if (reg.later) return en ? `late ${reg.year} or later` : `конец ${reg.year} или позже`;
  const part = en ? ["early", "mid", "late"][reg.part] : ["начало", "середина", "конец"][reg.part];
  return `${part} ${reg.year}`;
}

export function ageText(locale: Locale, months?: number): string {
  if (months == null) return "";
  const en = locale === "en";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (en) return [y ? `${y} yr` : "", m ? `${m} mo` : ""].filter(Boolean).join(" ") || "under a month";
  const yWord = y % 10 === 1 && y % 100 !== 11 ? "год" : [2, 3, 4].includes(y % 10) && ![12, 13, 14].includes(y % 100) ? "года" : "лет";
  return [y ? `${y} ${yWord}` : "", m ? `${m} мес` : ""].filter(Boolean).join(" ") || "меньше месяца";
}

export function lastSeenText(locale: Locale, ls?: LastSeen): string {
  if (!ls) return "";
  const en = locale === "en";
  switch (ls.kind) {
    case "online":
      return en ? "online now" : "сейчас в сети";
    case "recently":
      return en ? "recently" : "недавно";
    case "week":
      return en ? "within a week" : "на этой неделе";
    case "month":
      return en ? "within a month" : "в этом месяце";
    case "time": {
      const d = new Date((ls.at || 0) * 1000);
      return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
    }
    default:
      return en ? "hidden or long ago" : "скрыто или давно";
  }
}

function monthYear(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

// The "👤 Account" block of a bot check reply.
function accountLines(locale: Locale, a?: AccountCard): string[] {
  if (!a) return [];
  const en = locale === "en";
  const out = [en ? "👤 <b>Account</b>" : "👤 <b>Аккаунт</b>"];
  if (a.id) out.push(`ID: <code>${escapeHtml(a.id)}</code>${a.idSource === "posts" ? (en ? " (from blacklist posts)" : " (по постам блеклистов)") : ""}`);
  if (a.name) out.push(`${en ? "Name" : "Имя"}: ${escapeHtml(a.name)}`);
  if (a.usernames.length) out.push(`${en ? "Now" : "Сейчас"}: ${a.usernames.map((u) => `@${escapeHtml(u)}`).join(", ")}`);
  else if (a.idSource === "posts") out.push(en ? "The username belongs to no one now (account deleted or renamed)." : "Ник сейчас никому не принадлежит (аккаунт удалён или сменил ник).");
  if (a.scam) out.push(en ? "⚠️ Telegram marked this account as <b>SCAM</b>" : "⚠️ Telegram пометил аккаунт как <b>SCAM</b>");
  if (a.fake) out.push(en ? "⚠️ Telegram marked this account as <b>FAKE</b>" : "⚠️ Telegram пометил аккаунт как <b>FAKE</b>");
  if (a.restricted) out.push(`⚠️ ${en ? "Restricted by Telegram" : "Ограничен Telegram"}: ${escapeHtml(a.restricted.slice(0, 120))}`);
  const tags = [
    a.premium ? "⭐ Premium" : "",
    a.bot ? (en ? "🤖 bot" : "🤖 бот") : "",
    a.verified ? (en ? "✔️ verified" : "✔️ верифицирован") : "",
    a.hasPhoto === false ? (en ? "no profile photo" : "без фото профиля") : "",
  ].filter(Boolean);
  if (tags.length) out.push(tags.join(" · "));
  if (a.lastSeen) out.push(`${en ? "Last seen" : "Был(а) в сети"}: ${lastSeenText(locale, a.lastSeen)}`);
  if (a.about) out.push(`${en ? "About" : "О себе"}: ${escapeHtml(a.about.replace(/\s+/g, " ").slice(0, 200))}`);
  if (a.channel) out.push(`${en ? "Channel" : "Канал"}: ${a.channel.username ? `@${escapeHtml(a.channel.username)}` : escapeHtml(a.channel.title)}`);
  if (a.reg) {
    const age = ageText(locale, a.reg.months);
    out.push(`${en ? "Registered" : "Регистрация"}: ≈ ${regEstimateText(locale, a.reg)}${age ? ` (≈ ${age})` : ""} ${en ? "— estimate by ID" : "— оценка по ID"}`);
  }
  if (a.firstListed) {
    out.push(
      `${en ? "First seen in blacklists" : "Впервые в блеклистах"}: ${monthYear(a.firstListed)}${a.listedIn ? ` · ${en ? "sources" : "источников"}: ${a.listedIn}` : ""}`,
    );
  }
  if (a.previous.length) {
    out.push(en ? "Known usernames before:" : "Ранее известные ники:");
    for (const p of a.previous.slice(0, 6)) {
      const when = monthYear(p.since);
      const src =
        p.source === "post"
          ? `${en ? "post in" : "пост в"} ${escapeHtml(p.where || (en ? "a blacklist" : "блеклисте"))}`
          : en ? "seen by the bot" : "видел бот";
      out.push(`• @${escapeHtml(p.username)} — ${src}${when ? `, ${when}` : ""}`);
    }
  }
  return [...out, ""];
}

function formatBotCheck(locale: Locale, input: string, res: CheckResult): string {
  const q = res.query.username ? `@${res.query.username}` : res.query.id ? `ID ${res.query.id}` : input.trim();
  const found = res.epb.length || res.manual.length || res.channels.length;
  if (!found) return [...accountLines(locale, res.account), tb(locale, "checkClean", { q: escapeHtml(q) })].join("\n").slice(0, 3900);
  const lines: string[] = [`🔎 <b>${escapeHtml(q)}</b>`, "", ...accountLines(locale, res.account)];
  if (res.epb.length) {
    lines.push(tb(locale, "checkEpbHdr"));
    for (const e of res.epb.slice(0, 6)) {
      lines.push(`• ${escapeHtml(e.accounts)}${e.amount ? ` — ${escapeHtml(e.amount)} ${escapeHtml(e.currency)}` : ""}`);
    }
    lines.push("");
  }
  for (const m of res.manual.slice(0, 6)) lines.push(`📛 ${escapeHtml(m.source)}: ${escapeHtml(m.account)}`);
  if (res.channels.length) {
    const allWwh = res.channels.every((c) => /wwh/i.test(c.channelTitle || ""));
    lines.push(allWwh ? tb(locale, "checkFoundForum") : tb(locale, "checkFoundChats"));
    for (const c of res.channels.slice(0, 8)) {
      const wwh = /wwh/i.test(c.channelTitle || "");
      const name = wwh ? "WWH" : c.channelTitle || "источник";
      // WWH shown without a message link (same rule as the app).
      lines.push(wwh ? `• ${escapeHtml(name)}` : `• <a href="${c.link}">${escapeHtml(name)}</a>`);
    }
    lines.push("");
  }
  lines.push(tb(locale, "checkDispute"));
  return lines.join("\n").slice(0, 3900);
}

// Bot users waiting to answer a captcha: chat -> the check they asked for, or
// SUBMIT_CAPTCHA when the captcha guards sending a complaint.
const botCaptchaWait = new Map<string, string>();
const SUBMIT_CAPTCHA = "\u0000submit";

// The captcha picture currently shown in each chat, so only one is ever on
// screen (an older one would carry a word that no longer counts).
const botCaptchaMsg = new Map<string, number>();

function dropBotCaptchaMsg(chatId: number | string) {
  const id = botCaptchaMsg.get(String(chatId));
  botCaptchaMsg.delete(String(chatId));
  if (id) void tgSoft("deleteMessage", { chat_id: chatId, message_id: id });
}

type BotCapText = "check" | "submit" | "new" | "wrong" | "again" | "expired" | "locked" | "failed";
function botCapText(chatId: number | string, key: BotCapText): string {
  const en = langOf(chatId) === "en";
  const ru: Record<BotCapText, string> = {
    check: "🤖 Много проверок подряд. Напишите слово с картинки, чтобы продолжить.",
    submit: "🤖 Последний шаг: напишите слово с картинки, чтобы отправить жалобу.",
    new: "🔄 Новое слово:",
    wrong: "❌ Неверно. Попробуйте ещё раз.",
    again: "❌ Неверно. Вот новое слово:",
    expired: "⌛ Картинка устарела. Новое слово:",
    locked: "⛔ Слишком много неверных ответов. Попробуйте позже.",
    failed: "⚠️ Не удалось показать картинку. Попробуйте ещё раз через минуту.",
  };
  const enT: Record<BotCapText, string> = {
    check: "🤖 Many checks in a row. Type the word from the picture (in Russian) to continue.",
    submit: "🤖 Last step: type the word from the picture (in Russian) to send the complaint.",
    new: "🔄 New word:",
    wrong: "❌ Wrong. Try again.",
    again: "❌ Wrong. Here is a new word:",
    expired: "⌛ The picture expired. New word:",
    locked: "⛔ Too many wrong answers. Please try again later.",
    failed: "⚠️ Couldn't show the picture. Please try again in a minute.",
  };
  return (en ? enT : ru)[key];
}

async function sendBotCaptcha(chatId: number | string, intro: string, purpose?: CaptchaPurpose): Promise<boolean> {
  const why: CaptchaPurpose = purpose ?? (botCaptchaWait.get(String(chatId)) === SUBMIT_CAPTCHA ? "submit" : "check");
  const png = newCaptchaImage(String(chatId), why);
  dropBotCaptchaMsg(chatId);
  if (!png) {
    botCaptchaWait.delete(String(chatId));
    await sendCeMessage(chatId, botCapText(chatId, "locked"));
    return false;
  }
  const en = langOf(chatId) === "en";
  const buildForm = (rich: boolean) => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", rich ? applyCustomEmoji(escapeHtml(intro)) : intro);
    if (rich) form.set("parse_mode", "HTML");
    form.set(
      "reply_markup",
      JSON.stringify({
        inline_keyboard: [
          [{ text: en ? "🔄 Another picture" : "🔄 Другая картинка", callback_data: "bcap:new" }],
          [{ text: en ? "✖ Cancel" : "✖ Отмена", callback_data: "bcap:x" }],
        ],
      }),
    );
    form.set("photo", new File([new Uint8Array(png)], "captcha.png", { type: "image/png" }));
    return form;
  };
  const rich = customEmojiEnabled() && isPrivateChat(chatId) && hasCustomEmoji(applyCustomEmoji(intro));
  try {
    const sent = await tgForm<{ message_id: number }>("sendPhoto", buildForm(rich)).catch((err) => {
      if (rich && /emoji/i.test(err instanceof Error ? err.message : "")) return tgForm<{ message_id: number }>("sendPhoto", buildForm(false));
      throw err;
    });
    if (sent?.message_id) botCaptchaMsg.set(String(chatId), sent.message_id);
    if (botCaptchaMsg.size > 20_000) botCaptchaMsg.clear();
    return true;
  } catch (err) {
    console.error("[epb] captcha photo failed:", err);
    await sendCeMessage(chatId, botCapText(chatId, "failed"));
    return false;
  }
}

async function runBotCheck(chatId: number | string, input: string, skipGate = false, from?: TgUser) {
  if (!skipGate) {
    if (tooMany(`check:${chatId}`, 30, 60_000)) {
      await sendCeMessage(chatId, langOf(chatId) === "en" ? "⏳ Too many checks. Please wait a minute." : "⏳ Слишком много проверок. Подождите минуту.");
      return;
    }
    if (captchaRequired(String(chatId))) {
      botCaptchaWait.set(String(chatId), input);
      await sendBotCaptcha(chatId, botCapText(chatId, "check"), "check");
      return;
    }
  }
  const locale = langOf(chatId);
  const en = locale === "en";
  const empty: CheckResult = { query: { username: "", id: "" }, epb: [], channels: [], manual: [] };
  const search = checkCounterparty(input).catch(() => empty);
  const sources = checkSources();
  let res: CheckResult;
  // Telegram allows a bot ~30 messages a second in total: with very many checks
  // at once the live animation is skipped and only the result is sent.
  if (sources.length && activeCheckAnimations < CHECK_ANIM_MAX) {
    await Promise.race([loadPackEmoji(), sleep(1500)]);
    res = await animateBotCheck(chatId, en, sources, search, input);
  } else {
    await tgSoft("sendChatAction", { chat_id: chatId, action: "typing" });
    res = await search;
  }
  logSearch(from || { id: chatId }, input, res, "bot");
  await sendCeMessage(chatId, formatBotCheck(locale, input, res), {
    reply_markup: checkResultKeyboard(locale),
    disable_web_page_preview: true,
  });
}

// The live progress message of a check, edited in place about once a second.
// While the search runs it names the source being checked ("⏳ Animal Planet
// Blacklist · 2 of 15"); once the answer is in, the results appear a few lines
// at a time in a quote, and the final message folds the list (expandable quote)
// under a one-line verdict. Premium icons when the pack has them.
const CHECK_FRAME_MS = 900;
const CHECK_ANIM_MAX = 40;
let activeCheckAnimations = 0;
async function animateBotCheck(...args: Parameters<typeof runCheckAnimation>): Promise<CheckResult> {
  activeCheckAnimations++;
  try {
    return await runCheckAnimation(...args);
  } finally {
    activeCheckAnimations--;
  }
}
// Slower frames when many animations run together, so the edits stay well under
// the bot's overall limit (12 at once: ~1 frame/s each; 36: one every ~3 s).
function checkFrameMs() {
  return CHECK_FRAME_MS * Math.max(1, Math.ceil(activeCheckAnimations / 12));
}
async function runCheckAnimation(
  chatId: number | string,
  en: boolean,
  sources: { key: string; title: string }[],
  search: Promise<CheckResult>,
  query = "",
): Promise<CheckResult> {
  const I = {
    head: "🔎",
    ok: pickEmoji("✅", "✔️"),
    hit: pickEmoji("⛔", "⛔️", "🚫", "❌", "❗"),
    busy: pickEmoji("⏳", "⌛", "🔄", "🔍"),
  };
  const n = sources.length;
  const who = escapeHtml(query.trim().slice(0, 64));
  let res: CheckResult | null = null;
  void search.then((r) => (res = r));
  let done = 0; // results shown
  let cursor = 0; // the source named while waiting
  let slow = false;
  const frame = (final: boolean) => {
    const hits = (res as CheckResult | null)?.sourceHits || {};
    const line = (src: { key: string; title: string }) => {
      const k = hits[src.key] || 0;
      return k ? `${I.hit} <b>${escapeHtml(src.title)}</b> · ${en ? "found" : "найдено"}: ${k}` : `${I.ok} ${escapeHtml(src.title)}`;
    };
    const head = `${I.head} <b>${en ? "Checking" : "Проверяем"}${who ? ` ${who}` : ""}</b>`;
    if (final) {
      const found = sources.filter((src) => (hits[src.key] || 0) > 0).length;
      return [
        `${I.head} <b>${who || (en ? "Check" : "Проверка")}</b> · ${en ? `${n} sources checked` : `проверено источников: ${n}`}`,
        "",
        found
          ? `${I.hit} <b>${en ? `Found in ${found} of ${n}` : `Найдено в ${found} из ${n}`}</b>`
          : `${I.ok} <b>${en ? "Clean in every source" : "Чисто во всех источниках"}</b>`,
        // found ones first, the rest folded
        `<blockquote expandable>${[...sources.filter((x) => hits[x.key]), ...sources.filter((x) => !hits[x.key])].map(line).join("\n")}</blockquote>`,
      ].join("\n");
    }
    if (!res) {
      const src = sources[cursor % n]!;
      return [
        head,
        "",
        `${I.busy} <i>${escapeHtml(src.title)}</i>`,
        `<i>${en ? `source ${Math.min(cursor + 1, n)} of ${n}` : `источник ${Math.min(cursor + 1, n)} из ${n}`}</i>`,
        ...(slow ? ["", `<i>${en ? "The search can take up to 30 seconds." : "Поиск может занять до 30 секунд."}</i>`] : []),
      ].join("\n");
    }
    return [head, "", `<blockquote>${sources.slice(0, done).map(line).join("\n")}</blockquote>`, `<i>${done} / ${n}</i>`].join("\n");
  };

  let useCe = customEmojiEnabled() && isPrivateChat(chatId);
  let messageId = 0;
  let pausedUntil = 0;
  // One edit, never retried or waited on: a frame Telegram refuses is skipped.
  // In-between frames also share one budget for the whole bot (15 a second), so
  // the answers people are waiting for always go first.
  const show = async (text: string, must = false) => {
    if (Date.now() < pausedUntil) return;
    if (!must && messageId && tooMany("anim:frames", 15, 1000)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = { chat_id: chatId, text: useCe ? applyCustomEmoji(text) : text, parse_mode: "HTML", disable_web_page_preview: true };
      try {
        if (!messageId) messageId = (await tgOnce<{ message_id: number }>("sendMessage", body)).message_id;
        else await tgOnce("editMessageText", { ...body, message_id: messageId });
        return;
      } catch (err) {
        if (isNotModified(err)) return;
        if (useCe && isCustomEmojiError(err)) {
          useCe = false;
          continue;
        }
        if (err instanceof TgError && err.code === 429) pausedUntil = Date.now() + ((err.retryAfter ?? 3) + 1) * 1000;
        return;
      }
    }
  };

  const stepOut = Math.max(1, Math.ceil(n / 4)); // results revealed per frame
  const started = Date.now();
  await show(frame(false), true);
  if (activeCheckAnimations <= 12) void tgSoft("sendChatAction", { chat_id: chatId, action: "typing" });
  while (done < n) {
    const frameMs = checkFrameMs();
    await Promise.race([search, sleep(frameMs)]);
    // busy: once the answer is in, go straight to the summary
    if (res && activeCheckAnimations > 12) break;
    if (res) {
      // the answer can come early: still finish the current frame's pause
      await sleep(Math.max(0, frameMs - ((Date.now() - started) % frameMs)));
      done = Math.min(n, done + stepOut);
    } else {
      cursor = (cursor + 1) % n;
      if (!slow && Date.now() - started > 4000) slow = true;
      if (Date.now() - started > 60_000) break; // the search has its own timeouts; never spin forever
    }
    if (done < n) await show(frame(false));
  }
  const result = (res as CheckResult | null) || (await search);
  res = result;
  done = n;
  // the last frame must land, so it waits out a flood pause instead of skipping
  if (Date.now() < pausedUntil) await sleep(Math.min(10_000, pausedUntil - Date.now()));
  pausedUntil = 0;
  await show(frame(true), true);
  return result;
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
      [{ text: `⬅️ ${tb(locale, "back")}`, callback_data: "home" }],
    ],
  };
}

function langKeyboard(withBack = false) {
  const rows: Record<string, unknown>[][] = [
    [
      { text: "Русский", callback_data: "lang:ru" },
      { text: "English", callback_data: "lang:en" },
    ],
  ];
  if (withBack) rows.push([{ text: "⬅️ Назад / Back", callback_data: "home" }]);
  return { inline_keyboard: rows };
}

const LANG_PROMPT = "Выберите язык / Choose language";

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
  // Premium custom emoji in private-chat captions and button icons, with a plain
  // retry if Telegram rejects them, so the card is never lost.
  const useCe = customEmojiEnabled() && isPrivateChat(chatId);
  const rich = useCe ? applyCustomEmoji(caption) : caption;
  const plainMarkup = extra.reply_markup;
  const richMarkup = useCe ? decorateButtons(plainMarkup, true) : plainMarkup;
  const needsRich = useCe && (hasCustomEmoji(rich) || markupHasIconableButton(plainMarkup));
  const cap = needsRich ? rich : caption;
  const rest = (markup: unknown) => {
    const { reply_markup: _omit, ...other } = extra;
    return markup === undefined ? other : { ...other, reply_markup: markup };
  };
  const trySend = async (method: string, build: (c: string, markup: unknown) => Record<string, unknown>) => {
    try {
      return await tg(method, build(cap, needsRich ? richMarkup : plainMarkup));
    } catch (err) {
      if (needsRich && isCustomEmojiError(err)) {
        return await tgSoft(method, build(caption, plainMarkup));
      }
      return null;
    }
  };

  // The /start card is an animation (medallion + circling stars); the still
  // picture below stays as the fallback if Telegram refuses it.
  if (kind === "welcome") {
    const cachedAnim = bindings.cards?.welcomeAnim3;
    if (cachedAnim) {
      const sent = await trySend("sendAnimation", (c, markup) => ({
        chat_id: chatId,
        animation: cachedAnim,
        caption: c,
        parse_mode: "HTML",
        ...rest(markup),
      }));
      if (sent) return;
      if (bindings.cards) delete bindings.cards.welcomeAnim3;
      saveBindings();
    }
    let mp4: Buffer | null = null;
    try {
      mp4 = Buffer.from(WELCOME_MP4_BASE64, "base64");
    } catch {
      mp4 = null;
    }
    if (mp4?.length) {
      const sendAnim = (c: string, markup: unknown) => {
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("caption", c);
        form.set("parse_mode", "HTML");
        form.set("width", "960");
        form.set("height", "540");
        form.set("duration", "15");
        if (markup) form.set("reply_markup", JSON.stringify(markup));
        form.set("animation", new File([new Uint8Array(mp4!)], "welcome.mp4", { type: "video/mp4" }));
        return tgForm<{ animation?: { file_id: string }; document?: { file_id: string } }>("sendAnimation", form);
      };
      try {
        let sent: { animation?: { file_id: string }; document?: { file_id: string } };
        try {
          sent = await sendAnim(cap, needsRich ? richMarkup : plainMarkup);
        } catch (err) {
          if (needsRich && isCustomEmojiError(err)) sent = await sendAnim(caption, plainMarkup);
          else throw err;
        }
        const fileId = sent.animation?.file_id || sent.document?.file_id;
        if (fileId) {
          bindings.cards = { ...bindings.cards, welcomeAnim3: fileId };
          saveBindings();
        }
        return;
      } catch {
        /* fall back to the still card */
      }
    }
  }

  const cached = bindings.cards?.[kind];
  if (cached) {
    const sent = await trySend("sendPhoto", (c, markup) => ({
      chat_id: chatId,
      photo: cached,
      caption: c,
      parse_mode: "HTML",
      ...rest(markup),
    }));
    if (sent) return;
    if (bindings.cards) delete bindings.cards[kind];
    saveBindings();
  }
  const bytes = cardBytes(kind);
  if (bytes?.length) {
    const sendForm = (c: string, markup: unknown) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", c);
      form.set("parse_mode", "HTML");
      if (markup) form.set("reply_markup", JSON.stringify(markup));
      form.set("photo", new File([new Uint8Array(bytes)], `${kind}.jpg`, { type: "image/jpeg" }));
      return tgForm<{ photo?: { file_id: string }[] }>("sendPhoto", form);
    };
    try {
      let sent: { photo?: { file_id: string }[] };
      try {
        sent = await sendForm(cap, needsRich ? richMarkup : plainMarkup);
      } catch (err) {
        if (needsRich && isCustomEmojiError(err)) sent = await sendForm(caption, plainMarkup);
        else throw err;
      }
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
  await trySend("sendMessage", (c, markup) => ({
    chat_id: chatId,
    text: c,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...rest(markup),
  }));
}

// The /start caption. Shared by the first send and by in-place "back to menu"
// edits. (The connected-chats/audience line was removed on request.)
async function startCaption(locale: Locale): Promise<string> {
  const text = startText(locale);
  const n = blacklistBaseCached();
  if (!n) return text;
  return `${text}\n\n${tb(locale, "baseLine", { n: n.toLocaleString(locale === "en" ? "en-US" : "ru-RU") })}`;
}

// The base card at the top of the app (when there are no banners): size, number
// of sources, and when the copies last took in new posts. Public, no names.
export function publicBaseStats(): { accounts: number; sources: number; updatedAt: number } | null {
  const accounts = blacklistBaseCached();
  if (!accounts) return null;
  let updatedAt = baseCountCache.at;
  for (const c of mirrorChannels()) {
    const m = mirrors.get(chatIdKey(c.id));
    if (m && m.updatedAt > 0 && m.updatedAt <= Date.now()) updatedAt = Math.max(updatedAt, m.updatedAt);
  }
  return { accounts, sources: checkSources().length, updatedAt };
}

// ---- Full post on tap (app): text from the channel copy, photos fetched once ----
// The text is already in the local copy (no Telegram request). Photos are
// downloaded by the search account only when someone opens the post, at a
// medium size, and kept in data/post-media (oldest dropped past a size cap), so
// the next open costs nothing. Rate-limited per user and overall, never while
// Telegram asked the account to wait.
const POST_MEDIA_DIR = join(DATA_DIR, "post-media");
const POST_MEDIA_MAX_BYTES = 40 * 1024 * 1024;
const POST_PHOTOS_MAX = 6;
const POST_PHOTO_MAX_BYTES = 300 * 1024; // ~800 px photos are 60–150 KB
// links: the post's links by position in the text (o = offset, l = length,
// u = url) — also the ones hidden behind words, which the text alone loses.
type PostLink = { o: number; l: number; u: string };
export type PostDetail =
  | { ok: true; text: string; date: number; source: string; photos: string[]; more: number; links?: PostLink[]; photosPending?: boolean }
  | { ok: false; error: string };
type PostMeta = { text: string; date: number; photos: number; more: number; at: number; links?: PostLink[] };
const postInflight = new Map<string, Promise<{ text: string; date: number; photos: Buffer[]; more: number; links: PostLink[] } | null>>();

type MtEntity = { className?: string; offset?: number; length?: number; url?: string };
// Only web and t.me links are kept (no tg://, javascript: and the like).
function postLinksFrom(text: string, entities: MtEntity[] | undefined): PostLink[] {
  const out: PostLink[] = [];
  for (const e of entities || []) {
    const o = Number(e.offset);
    const l = Number(e.length);
    if (!Number.isInteger(o) || !Number.isInteger(l) || o < 0 || l <= 0 || o + l > text.length) continue;
    const piece = text.slice(o, o + l);
    let u = "";
    if (e.className === "MessageEntityTextUrl") u = String(e.url || "");
    else if (e.className === "MessageEntityUrl") u = /^https?:\/\//i.test(piece) ? piece : `https://${piece}`;
    else if (e.className === "MessageEntityMention" && /^@[a-z0-9_]{4,32}$/i.test(piece)) u = `https://t.me/${piece.slice(1)}`;
    if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 600) continue;
    out.push({ o, l, u });
    if (out.length >= 60) break;
  }
  return out;
}

type UserClientMedia = UserClientSearch & { downloadMedia: (msg: unknown, opts?: { thumb?: unknown }) => Promise<Buffer | string | undefined> };
type TgMediaMsg = TgMsgLite & {
  groupedId?: unknown;
  photo?: { sizes?: { className?: string; type?: string; w?: number; h?: number }[] };
  media?: { className?: string };
  entities?: MtEntity[];
};

function postMediaPath(key: string, name: string) {
  return join(POST_MEDIA_DIR, `${key}${name}`);
}

function prunePostMedia() {
  try {
    const files = readdirSync(POST_MEDIA_DIR).map((f) => {
      const st = statSync(join(POST_MEDIA_DIR, f));
      return { f, size: st.size, at: st.mtimeMs };
    });
    let total = files.reduce((n, x) => n + x.size, 0);
    if (total <= POST_MEDIA_MAX_BYTES) return;
    // whole posts go together: drop the oldest post's files first
    files.sort((x, y) => x.at - y.at);
    for (const x of files) {
      if (total <= POST_MEDIA_MAX_BYTES * 0.8) break;
      try {
        unlinkSync(join(POST_MEDIA_DIR, x.f));
        total -= x.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function fetchPostMedia(ch: CheckChannel, messageId: number) {
  const { client } = await userbot();
  const c = client as unknown as UserClientMedia;
  const peer = await userInputPeer(client, channelRef(ch));
  // the post and its neighbours in one request (an album is several messages)
  const ids: number[] = [];
  for (let id = Math.max(1, messageId - 9); id <= messageId + 9; id++) ids.push(id);
  const page = ((await paced(() => withTimeout(c.getMessages(peer, { ids }), 20_000, "post timeout"))) || []) as (TgMediaMsg | undefined)[];
  const target = page.find((x) => x?.id === messageId);
  if (!target) return null;
  const group = target.groupedId
    ? page.filter((x): x is TgMediaMsg => Boolean(x && x.groupedId && String(x.groupedId) === String(target.groupedId))).sort((x, y) => x.id! - y.id!)
    : [target];
  const withText = group.find((x) => x.message) || target;
  const text = withText.message || "";
  const links = postLinksFrom(text, withText.entities);
  const photos: Buffer[] = [];
  let more = 0;
  for (const x of group) {
    if (!x.photo) {
      if (x.media && x.media.className !== "MessageMediaWebPage") more++;
      continue;
    }
    if (photos.length >= POST_PHOTOS_MAX) {
      more++;
      continue;
    }
    // a medium size (~800 px) rather than the original
    const sizes = (x.photo.sizes || []).filter((z) => z.w && z.h);
    const pick = sizes.filter((z) => (z.w || 0) <= 1000).sort((p, q) => (q.w || 0) - (p.w || 0))[0] || sizes[0];
    const buf = await paced(() => withTimeout(c.downloadMedia(x, pick ? { thumb: pick } : {}), 20_000, "photo timeout"));
    if (Buffer.isBuffer(buf) && buf.length && buf.length <= POST_PHOTO_MAX_BYTES) photos.push(buf);
  }
  return { text, date: (target.date || 0) * 1000, photos, more, links };
}

export async function postDetail(userId: string, channelId: string, messageId: number): Promise<PostDetail> {
  const ch = mirrorChannels().find((c) => sameChat(c.id, channelId));
  if (!ch || !Number.isInteger(messageId) || messageId <= 0) return { ok: false, error: "not found" };
  const key = `${chatIdKey(ch.id)}_${messageId}`;
  const source = checkSourceName(ch.title || ch.username || "");
  const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;
  // already fetched once
  const meta = readJson<PostMeta>(postMediaPath(key, ".json"));
  if (meta) {
    const photos: string[] = [];
    for (let i = 0; i < meta.photos; i++) {
      try {
        photos.push(dataUrl(readFileSync(postMediaPath(key, `_${i}.jpg`))));
      } catch {
        /* pruned */
      }
    }
    // (an entry saved before links were kept is fetched once more)
    if (photos.length === meta.photos && (meta.links || !hasUserbot())) {
      return { ok: true, text: meta.text, date: meta.date, source, photos, more: meta.more, links: meta.links || [] };
    }
  }
  const copy = (mirrors.get(chatIdKey(ch.id)) || loadMirror(ch)).msgs.get(messageId);
  const base = { text: copy?.text || "", date: (copy?.date || 0) * 1000 };
  const canFetch =
    hasUserbot() && Date.now() >= userBlockedUntil && userbotQueued < 10 && !tooMany(`post:${userId}`, 8, 60_000) && !tooMany("post:global", 40, 60_000);
  if (!canFetch) return { ok: true, ...base, source, photos: [], more: 0, photosPending: hasUserbot() };
  let job = postInflight.get(key);
  if (!job) {
    job = fetchPostMedia(ch, messageId)
      .catch((err) => {
        const wait = floodSeconds(err);
        if (wait) userBlockedUntil = Date.now() + (wait + 5) * 1000;
        console.warn("[epb] post media:", err instanceof Error ? err.message : err);
        return undefined as never;
      })
      .finally(() => postInflight.delete(key));
    postInflight.set(key, job);
  }
  const got = await job;
  if (got === undefined) return { ok: true, ...base, source, photos: [], more: 0, photosPending: true };
  if (got === null) return base.text ? { ok: true, ...base, source, photos: [], more: 0 } : { ok: false, error: "deleted" };
  try {
    mkdirSync(POST_MEDIA_DIR, { recursive: true });
    got.photos.forEach((b, i) => writeFileSync(postMediaPath(key, `_${i}.jpg`), b));
    const value: PostMeta = { text: got.text || base.text, date: got.date || base.date, photos: got.photos.length, more: got.more, at: Date.now(), links: got.text ? got.links : [] };
    writeFileSync(postMediaPath(key, ".json"), JSON.stringify(value));
    prunePostMedia();
  } catch {
    /* cache is optional */
  }
  return { ok: true, text: got.text || base.text, date: got.date || base.date, source, photos: got.photos.map(dataUrl), more: got.more, links: got.text ? got.links : [] };
}

// The app's "blacklist base" page: totals and, per source, how much has been
// copied and how many accounts it adds. Counted at most once a minute; before
// the background count has run, the per-source account numbers are left out
// (never a slow count while someone waits).
export type BaseSource = { name: string; posts: number; accounts: number | null; complete: boolean; progress: number; updatedAt: number };
export type BaseDetails = {
  accounts: number;
  usernames: number;
  ids: number;
  posts: number;
  sources: BaseSource[];
  epb: number;
  manual: number;
  updatedAt: number;
};
let baseDetailsCache: { at: number; value: BaseDetails | null } = { at: 0, value: null };
export function publicBaseDetails(): BaseDetails | null {
  if (!checkEnabled()) return null;
  if (Date.now() - baseDetailsCache.at < 60_000 && baseDetailsCache.value) return baseDetailsCache.value;
  const totals = blacklistBaseStats();
  if (!totals) return baseDetailsCache.value;
  const ready = Boolean(baseStatsCache.value);
  const byName = new Map<string, BaseSource>();
  let updatedAt = 0;
  for (const c of mirrorChannels()) {
    const m = loadMirror(c);
    const epbChan = epbCheckChannel();
    const name = epbChan && sameChat(c.id, epbChan.id) ? "Europe Private Blacklist" : checkSourceName(c.title || c.username || "");
    const a = ready ? mirrorAccused(c, m) : null;
    const accounts = a ? a.ids.size + [...a.usernames].filter((u) => !a.paired.has(u)).length : null;
    const prev = byName.get(name);
    const row: BaseSource = {
      name,
      posts: (prev?.posts || 0) + m.msgs.size,
      accounts: accounts === null ? null : (prev?.accounts || 0) + accounts,
      complete: (prev ? prev.complete : true) && m.complete,
      progress: prev ? Math.min(prev.progress, mirrorProgress(m)) : mirrorProgress(m),
      updatedAt: Math.max(prev?.updatedAt || 0, m.updatedAt || 0),
    };
    byName.set(name, row);
    updatedAt = Math.max(updatedAt, m.updatedAt || 0);
  }
  const epb = Object.values(pendingPosts).filter((r) => r.status === "published" && !r.removedFromCheck).length;
  const value: BaseDetails = {
    accounts: totals.accounts,
    usernames: totals.usernames,
    ids: totals.ids,
    posts: totals.posts,
    sources: [...byName.values()].sort((x, y) => y.posts - x.posts),
    epb,
    manual: (bindings.manualBlacklist || []).length,
    updatedAt: updatedAt || Date.now(),
  };
  baseDetailsCache = { at: Date.now(), value };
  return value;
}

// The newest posts copied from the blacklist channels, for the list at the bottom
// of the app's home screen: the accused account, where and when, and the damage
// when the post has a "Сумма/Ущерб" field. One row per account, cached a minute.
export type LatestParsed = { id: string; account: string; source: string; date: number; amount?: string; channelId: string; messageId: number; link: string };
let latestParsedCache = { at: 0, items: [] as LatestParsed[] };
const AMOUNT_RE = /(?:сумм[аы]?|ущерб|damage|amount)\s*[:\-–—]?\s*([~≈]?\s*\d[\d\s.,]*\s*(?:\$|usdt|usd|€|eur|евро|руб\.?|₽|rub|грн|₴|k|к)?)/i;
export function latestParsed(limit = 30): LatestParsed[] {
  if (!checkEnabled()) return [];
  if (Date.now() - latestParsedCache.at < 60_000) return latestParsedCache.items.slice(0, limit);
  const rows: (LatestParsed & { key: string })[] = [];
  for (const c of mirrorChannels()) {
    const m = mirrors.get(chatIdKey(c.id)) || loadMirror(c);
    if (!m.msgs.size) continue;
    const self = c.username ? `@${c.username.replace(/^@/, "").toLowerCase()}` : "";
    const strict = isStrictChannel(c);
    let taken = 0;
    // newest posts have the highest ids: walk down from the top, no sorting
    for (let msgId = m.newest, steps = 0; msgId > 0 && taken < limit && steps < 5000; msgId--, steps++) {
      const msg = m.msgs.get(msgId);
      if (!msg) continue;
      const p = postAccused(c, msg, strict, self);
      if (!p.hs.length && !p.is.length) continue;
      if (isExcludedAccount(p.hs, p.is[0]) || p.is.some((x) => isExcludedAccount([], x))) continue;
      const account = p.hs.length ? p.hs.slice(0, 2).join(", ") : `ID ${p.is[0]}`;
      const amount = msg.text.match(AMOUNT_RE)?.[1]?.replace(/\s+/g, " ").trim();
      rows.push({
        key: (p.hs[0] || p.is[0] || "").toLowerCase(),
        id: `${m.key}:${msg.id}`,
        channelId: c.id,
        messageId: msg.id,
        link: messageLink(c, msg.id),
        account,
        source: checkSourceName(c.title || c.username || ""),
        date: msg.date * 1000,
        ...(amount && /\d/.test(amount) ? { amount: amount.slice(0, 24) } : {}),
      });
      taken++;
    }
  }
  rows.sort((x, y) => y.date - x.date);
  const seen = new Set<string>();
  const items: LatestParsed[] = [];
  for (const { key, ...row } of rows) {
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(row);
    if (items.length >= 30) break;
  }
  latestParsedCache = { at: Date.now(), items };
  return items.slice(0, limit);
}

// The base size for the /start card, counted at most once a minute (every user
// sees the menu, the count only needs to be roughly current).
let baseCountCache = { at: 0, n: 0 };
function blacklistBaseCached(): number {
  return blacklistBaseStats()?.accounts || 0;
}

// The full base numbers, at most a minute old. Small copies are counted right
// away; big ones (hundreds of thousands of posts) are first parsed in the
// background in small slices, so the bot never freezes while counting — until
// then the previous numbers (or none) are shown.
let baseStatsCache: { at: number; value: ReturnType<typeof blacklistBase> | null } = { at: 0, value: null };
let baseRefreshing = false;
export function blacklistBaseStats(): ReturnType<typeof blacklistBase> | null {
  if (!checkEnabled()) return null;
  if (Date.now() - baseStatsCache.at <= 60_000 || baseRefreshing) return baseStatsCache.value;
  const total = mirrorChannels().reduce((n, c) => n + loadMirror(c).msgs.size, 0);
  if (total < 30_000) {
    try {
      baseStatsCache = { at: Date.now(), value: blacklistBase() };
      baseCountCache = { at: Date.now(), n: baseStatsCache.value!.accounts };
    } catch {
      baseStatsCache = { at: Date.now(), value: baseStatsCache.value };
    }
    return baseStatsCache.value;
  }
  baseRefreshing = true;
  void warmAccused()
    .then(() => {
      baseStatsCache = { at: Date.now(), value: blacklistBase() };
      baseCountCache = { at: Date.now(), n: baseStatsCache.value!.accounts };
    })
    .catch(() => {})
    .finally(() => (baseRefreshing = false));
  return baseStatsCache.value;
}

// Parse every not-yet-parsed post, 1500 at a time, yielding to the bot between slices.
async function warmAccused() {
  for (const c of mirrorChannels()) {
    const m = loadMirror(c);
    const self = c.username ? `@${c.username.replace(/^@/, "").toLowerCase()}` : "";
    const strict = isStrictChannel(c);
    let n = 0;
    for (const msg of [...m.msgs.values()]) {
      if (msg.acc !== undefined) continue;
      postAccused(c, msg, strict, self);
      if (++n % 1500 === 0) await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
    mirrorIndex(m);
    await new Promise((r) => setImmediate(r));
  }
}
if (botToken() && process.env.NODE_ENV !== "test") setTimeout(() => void blacklistBaseStats(), 4_000).unref?.();

async function replyStart(chatId: number, userId?: string | number) {
  warmCards();
  const locale = langOf(userId ?? chatId);
  await sendCard(chatId, "welcome", await startCaption(locale), { reply_markup: applyKeyboard(locale) });
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

// Sends the next wizard prompt, deleting the previous one so the complaint flow
// keeps a single live message instead of a growing stack. Falls back to a plain
// send if there is no session to track against.
async function sendStep(
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ message_id: number } | null> {
  const session = sessions.get(String(chatId));
  if (session?.stepMsgId) {
    void tgSoft("deleteMessage", { chat_id: chatId, message_id: session.stepMsgId });
    session.stepMsgId = undefined;
  }
  const sent = await sendCeMessage(chatId, text, extra);
  if (session && sent?.message_id) session.stepMsgId = sent.message_id;
  return sent;
}

// Clears the tracked wizard prompt (used when the flow ends or is cancelled).
function clearStepMessage(chatId: string | number, deleteIt = true) {
  const session = sessions.get(String(chatId));
  if (session?.stepMsgId) {
    if (deleteIt) void tgSoft("deleteMessage", { chat_id: chatId, message_id: session.stepMsgId });
    session.stepMsgId = undefined;
  }
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
  await sendStep(
    chatId,
    session?.accounts.length
      ? btUser(chatId, "accountsListed", { list: listed })
      : btUser(chatId, "stepAccounts"),
    { reply_markup: { inline_keyboard: rows } },
  );
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
  await sendStep(chatId, btUser(chatId, "stepSummary"), {
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askStory(chatId: number) {
  await sendStep(chatId, btUser(chatId, "stepStory"), {
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askAmount(chatId: number) {
  await sendStep(chatId, btUser(chatId, "stepAmount"), {
    reply_markup: { inline_keyboard: [applyCancelRow(chatId)] },
  });
}

async function askCurrency(chatId: number, amount: string) {
  await sendStep(chatId, btUser(chatId, "pickCurrency", { amount: formatAmount(amount) }), {
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
  await sendStep(chatId, btUser(chatId, "stepEvidence"), {
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
  await sendStep(
    chatId,
    btUser(chatId, "confirm", {
      accounts: formatSessionAccounts(session, chatId),
      victim,
      id: session.victimId,
      amount: session.amount,
      currency: session.currency,
      files,
      summary: session.summary,
      story: session.story,
    }),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: btUser(chatId, "sendReview"), callback_data: "apply:send" },
            { text: btUser(chatId, "cancelBtn"), callback_data: "apply:cancel" },
          ],
        ],
      },
    },
  );
}

async function startApply(chatId: number, from: TgUser) {
  botCaptchaWait.delete(String(chatId)); // a pending check captcha must not eat the complaint answers
  const session = newSession(from);
  sessions.set(String(from.id), session);
  await sendCeMessage(chatId, btUser(from.id, "applyStart"));
  await askScammer(chatId, session);
}

async function cancelApply(chatId: number, userId: string, notice?: string) {
  if (botCaptchaWait.get(String(chatId)) === SUBMIT_CAPTCHA) {
    botCaptchaWait.delete(String(chatId));
    dropBotCaptchaMsg(chatId);
  }
  clearStepMessage(chatId);
  sessions.delete(userId);
  // Back to the menu card (with its animation), the notice on top of the caption.
  const locale = langOf(userId);
  const caption = `${escapeHtml(notice || btUser(userId, "cancel"))}\n\n${await startCaption(locale)}`;
  await sendCard(chatId, "welcome", caption, { reply_markup: applyKeyboard(locale) });
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
    source: "bot",
  };
  const result = await sendApplicationToArbiters(app, session.evidence);
  if (!result.ok) {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: result.error || btUser(userId, "sendFail"),
    });
    return;
  }
  consumeSubmitPass(userId);
  clearStepMessage(chatId);
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
    if (!hasSubmitPass(userId)) {
      botCaptchaWait.set(String(chatId), SUBMIT_CAPTCHA);
      await sendBotCaptcha(chatId, botCapText(chatId, "submit"), "submit");
      return;
    }
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

// ---- Search history for /admin: who searched whom, when, and the outcome. ----
type SearchLogEntry = { at: number; userId: string; username?: string; name?: string; query: string; found: boolean; via: "app" | "bot"; platform?: string };
// Telegram app the mini app was opened in (Telegram.WebApp.platform).
const PLATFORM_NAMES: Record<string, string> = {
  ios: "iOS",
  android: "Android",
  android_x: "Android",
  tdesktop: "Telegram Desktop",
  macos: "macOS",
  weba: "Telegram Web",
  webk: "Telegram Web",
  web: "Telegram Web",
  unigram: "Unigram",
};
const SEARCH_LOG_MAX = 10;

export function logSearch(
  who: { id: string | number; username?: string; first_name?: string },
  query: string,
  res: CheckResult,
  via: "app" | "bot",
  platform?: string,
) {
  const found = Boolean(res.epb.length || res.manual.length || res.channels.length);
  const q = res.query.username ? `@${res.query.username}` : res.query.id ? `ID ${res.query.id}` : query.trim();
  const entry: SearchLogEntry = {
    at: Date.now(),
    userId: String(who.id),
    ...(who.username ? { username: who.username.slice(0, 64) } : {}),
    ...(who.first_name ? { name: who.first_name.slice(0, 64) } : {}),
    query: q.slice(0, 80),
    found,
    via,
    ...(via === "app" && platform && PLATFORM_NAMES[platform.toLowerCase()] ? { platform: PLATFORM_NAMES[platform.toLowerCase()] } : {}),
  };
  bindings.searchLog = [entry, ...(bindings.searchLog || [])].slice(0, SEARCH_LOG_MAX);
  saveBindingsSoon();
}

function adminSearchLog(): AdminView {
  const list = bindings.searchLog || [];
  const lines = [
    `<b>🔍 История поиска</b> (последние ${SEARCH_LOG_MAX})`,
    "📱 — поиск в мини-приложении (запрос подписан Telegram), 🤖 — поиск в чате с ботом.",
    "",
  ];
  if (!list.length) lines.push("Пока никто ничего не искал.");
  list.forEach((e, i) => {
    const who = e.username ? `@${escapeHtml(e.username)}` : escapeHtml(e.name || "без ника");
    const when = new Date(e.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
    lines.push(
      `${i + 1}. ${when} МСК (${ago(e.at)})`,
      `   Откуда: ${e.via === "bot" ? "🤖 бот" : `📱 мини-приложение${e.platform ? ` · ${escapeHtml(e.platform)}` : ""}`}`,
      `   Кто: ${who} · <code>${escapeHtml(e.userId)}</code>`,
      `   Искал: <code>${escapeHtml(e.query)}</code> — ${e.found ? "⛔ найдено" : "✅ чисто"}`,
    );
  });
  return {
    text: lines.join("\n").slice(0, 4000),
    keyboard: [
      [{ text: "🔄 Обновить", callback_data: "adm:sl" }],
      [{ text: "⬅ В меню", callback_data: "adm:home" }],
    ],
  };
}
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
    ...(checkEnabled()
      ? (() => {
          const b = blacklistBaseStats();
          if (!b) return [];
          const n = (v: number) => v.toLocaleString("ru-RU");
          return [
            `<b>База блеклиста</b>: ~${n(b.accounts)} аккаунтов (ников ${n(b.usernames)}, ID ${n(b.ids)}), постов ${n(b.posts)}` +
              (b.complete < b.channels ? ` · загружается ~${b.progress}%` : ""),
          ];
        })()
      : []),
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
      [
        { text: "🚫 Забанить", callback_data: "adm:ban" },
        { text: `⛔️ Баны (${(bindings.bannedUsers || []).length})`, callback_data: "adm:bans:0" },
      ],
      [{ text: `🔍 История поиска (${(bindings.searchLog || []).length})`, callback_data: "adm:sl" }],
      ...(checkEnabled()
        ? [
            [{ text: "➕ Добавить юзера в блеклист", callback_data: "adm:bladd" }],
            [{ text: "🧹 Убрать юзера из блеклиста", callback_data: "adm:ccrm" }],
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
      `Команда /im (карта участника): ${relay.imEnabled ? "включена" : "выключена"}`,
      relay.requestedAt ? `Запрос: ${ago(relay.requestedAt)}` : "",
      note ? `\n${note}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    keyboard: [
      [toggle],
      [{ text: relay.link ? "🔗 Изменить ссылку спонсора" : "🔗 Задать ссылку спонсора", callback_data: `adm:rlink:${suffix}` }],
      [{ text: "🔍 Проверить права бота", callback_data: `adm:rchk:${suffix}` }],
      [
        relay.imEnabled
          ? { text: "🎴 /im в чате: включено — выключить", callback_data: `adm:rimoff:${suffix}` }
          : { text: "🎴 /im в чате: выключено — включить", callback_data: `adm:rimon:${suffix}` },
      ],
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
    // And the posts about this account in the other blacklist channels: the
    // account is taken out of the search altogether.
    const exclusions = bindings.checkExclusions || [];
    let ex = exclusions.find((e) => (id && e.telegramId === id) || (uname && e.username === uname));
    if (!ex) {
      ex = { id: randomUUID().slice(0, 8), ...(uname ? { username: uname } : {}), ...(id ? { telegramId: id } : {}), addedAt: Date.now() };
      bindings.checkExclusions = [...exclusions, ex].slice(-5000);
      saveBindings();
    }
    if (removed) savePending();
    invalidateCheckCache();
    latestParsedCache = { at: 0, items: [] };
    const who = uname ? `@${uname}` : `ID ${id}`;
    await tgSoft("sendMessage", {
      chat_id: arbiterChatId,
      text:
        `${who} убран из блеклиста целиком.` +
        (removed ? `\nЖалоб и ручных записей скрыто: ${removed}.` : "") +
        "\nПосты о нём в других блеклист-каналах тоже больше не находятся (в боте, приложении и /pars).",
      reply_markup: { inline_keyboard: [[{ text: "↩ Вернуть в поиск", callback_data: `adm:unex:${ex.id}` }]] },
    });
    return;
  }
  if (removed) savePending();
  invalidateCheckCache();
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
  if (hasUserbot()) kickMirror();
  await tgSoft("sendMessage", {
    chat_id: arbiterChatId,
    text: [
      "Канал подключён для проверки.",
      escapeHtml(entry.title || entry.id),
      `ID: <code>${escapeHtml(entry.id)}</code>`,
      "",
      hasUserbot()
        ? "Начал копировать историю канала для быстрого поиска. Прогресс: /userbot."
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

const banSetup = new Set<string>();

function banLabel(b: BannedUser): string {
  return [b.username ? `@${b.username}` : "", b.id ? `ID ${b.id}` : ""].filter(Boolean).join(" · ") || "—";
}

function adminBans(page: number): AdminView {
  const list = bindings.bannedUsers || [];
  const per = 8;
  const items = list.slice(page * per, page * per + per);
  const rows: AdminView["keyboard"] = items.map((b) => [
    { text: `✅ Разбанить ${banLabel(b)}`.slice(0, 60), callback_data: `adm:unban:${b.id ? `i:${b.id}` : `u:${b.username}`}` },
  ]);
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: "⬅", callback_data: `adm:bans:${page - 1}` });
  if ((page + 1) * per < list.length) nav.push({ text: "➡", callback_data: `adm:bans:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "🚫 Забанить ещё", callback_data: "adm:ban" }], [{ text: "⬅ Назад", callback_data: "adm:home" }]);
  return {
    text: list.length ? `<b>Забаненные (${list.length})</b>\nНажмите, чтобы снять бан.` : "<b>Забаненных нет.</b>",
    keyboard: rows,
  };
}

function adminRecentFinds(page: number): AdminView {
  const list = bindings.recentFinds || [];
  const per = 8;
  const items = list.slice(page * per, page * per + per);
  const rows: AdminView["keyboard"] = items.map((f) => [
    { text: `🗑 ${f.label} — ${(f.sources || []).join(", ")}`.slice(0, 60), callback_data: `adm:rfdel:${f.id}:${page}` },
  ]);
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: "⬅", callback_data: `adm:rf:${page - 1}` });
  if ((page + 1) * per < list.length) nav.push({ text: "➡", callback_data: `adm:rf:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅ Назад", callback_data: "adm:home" }]);
  return {
    text: list.length
      ? `<b>Недавние проверки (${list.length})</b>\nПубличный список в приложении. Нажмите на ошибочную запись, чтобы удалить её.`
      : "<b>Недавних проверок нет.</b>",
    keyboard: rows,
  };
}

async function applyBan(chatId: number | string, raw: string) {
  banSetup.delete(String(chatId));
  const parsed = parseTelegramInput(raw.trim().split(/\s+/)[0] || "");
  const username = parsed.username.replace(/^@/, "").toLowerCase();
  const id = parsed.id;
  if (!username && !id) {
    await tgSoft("sendMessage", { chat_id: chatId, text: "Не понял. Пришлите @username или ID." });
    return;
  }
  if (id && isOwner(id)) {
    await tgSoft("sendMessage", { chat_id: chatId, text: "Владельца забанить нельзя." });
    return;
  }
  const list = (bindings.bannedUsers || []).filter(
    (b) => !((id && b.id === id) || (username && (b.username || "").toLowerCase() === username)),
  );
  const entry: BannedUser = { id: id || undefined, username: username || undefined, at: Date.now() };
  bindings.bannedUsers = [entry, ...list];
  saveBindings();
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: `🚫 Забанен: ${banLabel(entry)}\nБот и мини-приложение для него закрыты. Снять бан: /admin → ⛔️ Баны.`,
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
  if (action === "rimon" || action === "rimoff") {
    const relay = findRelay(target);
    if (!relay) {
      await answer("Чата уже нет в списке", true);
      return;
    }
    relay.imEnabled = action === "rimon";
    saveBindings();
    await answer(relay.imEnabled ? "/im включена в этом чате" : "/im выключена в этом чате");
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
  // The search account and the list of source channels are the owner's only
  // (/userbot in a private chat): the arbiter chat has other people in it.
  if (action === "cc" || action === "ccping" || action === "ccadd" || action === "ccdel") {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Аккаунт поиска и каналы настраивает владелец в личке бота: /userbot",
      show_alert: true,
    });
    return;
  }
  if (action === "ccrm") {
    removeFromCheckSetup.add(String(chatId));
    await answer("Пришлите номер жалобы или аккаунт");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите @username / ID аккаунта, которого нужно убрать из блеклиста целиком (например, ошибочный блек): перестанут находиться и жалобы EPB, и ручные записи, и посты о нём в других блеклист-каналах — в боте, приложении и /pars. Вернуть можно кнопкой под ответом.\n\nИли номер жалобы (EPB-…), чтобы скрыть только её.",
    });
    return;
  }
  if (action === "ban") {
    banSetup.add(String(chatId));
    await answer("Пришлите @username или ID");
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите @username или ID пользователя, которого нужно забанить. Ему закроется доступ к боту и мини-приложению.",
    });
    return;
  }
  if (action === "bans") {
    await answer();
    await renderAdmin(cb, adminBans(Number(rest[0] || 0)));
    return;
  }
  if (action === "unban") {
    const [kind, ...v] = rest;
    const val = v.join(":").toLowerCase();
    bindings.bannedUsers = (bindings.bannedUsers || []).filter((b) =>
      kind === "i" ? b.id !== val : (b.username || "").toLowerCase() !== val,
    );
    saveBindings();
    await answer("Бан снят");
    await renderAdmin(cb, adminBans(0));
    return;
  }
  if (action === "sl") {
    await answer();
    await renderAdmin(cb, adminSearchLog());
    return;
  }
  if (action === "rf") {
    await answer();
    await renderAdmin(cb, adminRecentFinds(Number(rest[0] || 0)));
    return;
  }
  if (action === "unex") {
    // undo "taken out of the search": other channels' posts count again
    const before = (bindings.checkExclusions || []).length;
    const gone = (bindings.checkExclusions || []).find((e) => e.id === rest[0]);
    bindings.checkExclusions = (bindings.checkExclusions || []).filter((e) => e.id !== rest[0]);
    if (bindings.checkExclusions.length !== before) saveBindings();
    invalidateCheckCache();
    latestParsedCache = { at: 0, items: [] };
    await answer(gone ? "Вернули в поиск" : "Уже возвращён");
    if (gone) {
      await tgSoft("editMessageText", {
        chat_id: chatId,
        message_id: cb.message?.message_id,
        text: `${gone.username ? `@${gone.username}` : `ID ${gone.telegramId}`} снова находится в постах других блеклист-каналов. (Скрытые жалобы EPB при этом остаются скрытыми.)`,
      });
    }
    return;
  }
  if (action === "rfdel") {
    const before = (bindings.recentFinds || []).length;
    bindings.recentFinds = (bindings.recentFinds || []).filter((f) => f.id !== rest[0]);
    if (bindings.recentFinds.length !== before) saveBindings();
    await answer("Удалено из недавних");
    await renderAdmin(cb, adminRecentFinds(Number(rest[1] || 0)));
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
      mirrorAddPost(ch, post.message_id, post.text || post.caption || "", post.date || 0);
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

  // Banned users get no bot in private chats (one short notice now and then).
  {
    const priv = update.message?.chat.type === "private" || update.callback_query?.message?.chat.type === "private";
    const from = update.message?.from || update.callback_query?.from;
    if (priv && from && isBannedUser(from.id, from.username)) {
      if (update.callback_query) void tgSoft("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "⛔️ Доступ закрыт", show_alert: true });
      const key = `ban-notice:${from.id}`;
      if (!tooMany(key, 1, 10 * 60_000)) {
        await tgSoft("sendMessage", { chat_id: from.id, text: "⛔️ Доступ к боту и приложению для вас закрыт." });
      }
      return;
    }
  }

  const groupMsg = update.message;
  if (groupMsg && (groupMsg.chat.type === "group" || groupMsg.chat.type === "supergroup")) {
    if (groupMsg.migrate_to_chat_id) onChatMigrated(String(groupMsg.chat.id), String(groupMsg.migrate_to_chat_id));
    if (groupMsg.migrate_from_chat_id) onChatMigrated(String(groupMsg.migrate_from_chat_id), String(groupMsg.chat.id));
    // the userbot joining/leaving for a check leaves no trace in the chat
    const cleanup = bindings.parsCleanup;
    if (
      cleanup &&
      sameChat(cleanup.chatId, groupMsg.chat.id) &&
      (groupMsg.new_chat_members?.some((u) => String(u.id) === cleanup.userbotId) || String(groupMsg.left_chat_member?.id || "") === cleanup.userbotId)
    ) {
      void tgSoft("deleteMessage", { chat_id: groupMsg.chat.id, message_id: groupMsg.message_id });
      return;
    }
    // /im: the member's card with their stats, in chats where the admins turned it on
    if (commandName(groupMsg.text) === "im") {
      const relay = findRelay(groupMsg.chat.id);
      if (relay?.imEnabled && groupMsg.from && !groupMsg.from.is_bot) await replyMemberCard(groupMsg);
      return;
    }
    // /pars from the bot owner: check this chat's members (continues in private)
    if (commandName(groupMsg.text) === "pars") {
      if (isOwner(groupMsg.from?.id) && !tooMany(`pars:${groupMsg.chat.id}`, 3, 60_000)) await parsAskInGroup(groupMsg);
      return;
    }
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
  // Arbiters, the owner and people in the middle of a complaint always get
  // through. Everyone else: a per-user limit first; then only the first 15
  // updates a minute of each user count against the shared budget, and anything
  // above that comes out of a small separate pool for noisy users. A handful of
  // flooding accounts therefore can't use up the budget that ordinary people need.
  const fromArbiters =
    isOfficialArbiterChat(update.message?.chat.id) || isOfficialArbiterChat(update.callback_query?.message?.chat.id);
  const privileged = fromArbiters || isOwner(floodId) || Boolean(liveSession);
  if (!fromArbiters && floodId && !evidenceBurst && tooMany(`flood:${floodId}`, 80, 60_000)) {
    return;
  }
  if (!privileged) {
    const light = !floodId || !tooMany(`fair:${floodId}`, 15, 60_000);
    if (light ? tooMany("upd:global", 600, 60_000) : tooMany("upd:noisy", 150, 60_000)) return;
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
      await editCard(cb, ownersText(locale), ownersKeyboard(locale));
      return;
    }
    if (cb.data === "home") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      checkWait.delete(String(cb.message.chat.id));
      const locale = langOf(cb.from?.id);
      // A plain text message (a check result, a notice) can't become the menu card
      // with its animation: replace it with a fresh card instead of editing it.
      const m = cb.message as { photo?: unknown; caption?: string; animation?: unknown };
      if (!m.photo && !m.animation && !m.caption && cb.message.chat.type === "private") {
        void tgSoft("deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
        await replyStart(cb.message.chat.id, cb.from?.id);
        return;
      }
      await editCard(cb, await startCaption(locale), applyKeyboard(locale));
      return;
    }
    if (cb.data.startsWith("imf:")) {
      await flipMemberCard(cb);
      return;
    }
    if (cb.data === "myprofile") {
      await openMemberProfile(cb);
      return;
    }
    if (cb.data === "imhome") {
      // the card is an animation: the menu comes back as a new message
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      void tgSoft("deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
      await replyStart(cb.message.chat.id, cb.from?.id);
      return;
    }
    if (cb.data.startsWith("pars:")) {
      await handleParsCallback(cb);
      return;
    }
    if (cb.data === "bcap:x") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      botCaptchaWait.delete(String(cb.message.chat.id));
      botCaptchaMsg.delete(String(cb.message.chat.id));
      void tgSoft("deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
      return;
    }
    if (cb.data === "bcap:new") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      if (botCaptchaWait.has(String(cb.message.chat.id))) await sendBotCaptcha(cb.message.chat.id, botCapText(cb.message.chat.id, "new"));
      return;
    }
    if (cb.data === "bsponsors") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      const locale = langOf(cb.from?.id);
      await editCard(cb, await botSponsorsText(locale), backToMenuKeyboard(locale));
      return;
    }
    if (cb.data === "bcheck") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      if (!checkEnabled() || cb.message.chat.type !== "private") return;
      const locale = langOf(cb.from?.id);
      checkWait.add(String(cb.message.chat.id));
      // the same check in the app (opens straight on the check page)
      const appUrl = publicMiniAppUrl();
      const keyboard = appUrl
        ? {
            inline_keyboard: [
              [{ text: tb(locale, "checkOpenApp"), web_app: { url: `${appUrl.replace(/\/$/, "")}/?page=check` } }],
              ...backToMenuKeyboard(locale).inline_keyboard,
            ],
          }
        : backToMenuKeyboard(locale);
      await editCard(cb, `${tb(locale, "checkPrompt")}${appUrl ? `\n\n${tb(locale, "checkAppHint")}` : ""}`, keyboard);
      return;
    }
    if (cb.data === "lang") {
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await editCard(cb, LANG_PROMPT, langKeyboard(true));
      return;
    }
    if (cb.data === "lang:ru" || cb.data === "lang:en") {
      const locale: Locale = cb.data.endsWith("en") ? "en" : "ru";
      if (cb.from?.id) setLang(cb.from.id, locale);
      void tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: tb(locale, "langSaved") });
      const fromCard = Boolean(cb.message.photo || cb.message.caption);
      if (fromCard) {
        // Language picked from inside the menu card — morph it back to the menu.
        await editCard(cb, await startCaption(locale), applyKeyboard(locale));
      } else {
        // Picked from the first-run text prompt — drop it and show the photo card.
        void tgSoft("deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
        await replyStart(cb.message.chat.id, cb.from?.id);
      }
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
    if ((cb.data === "pub" || cb.data.startsWith("pub:") || cb.data.startsWith("puball") || cb.data.startsWith("pubch") || cb.data === "rej" || cb.data.startsWith("rej:") || /^rej[rnb]:/.test(cb.data) || /^p(edit|view|orig|foto|fdel|fadd|forig):/.test(cb.data)) && !isOfficialArbiterChat(cb.message.chat.id)) {
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
    if (/^p(foto|fdel|fadd|forig):/.test(cb.data)) {
      await handlePostPhotoCallback(cb);
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
      // first a choice: give a reason, reject without one, or go back
      const key = parseAppKey(text, cb.data);
      const record = key ? pendingPosts[key] : undefined;
      if (record?.status === "published" || (key && publishing.has(key))) {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже опубликована", show_alert: true });
        return;
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await replaceReplyMarkup(cb.message, rejectChoiceKeyboard(key));
      return;
    }
    if (/^rej[rnb]:/.test(cb.data)) {
      const [action, key = ""] = cb.data.split(":");
      const record = key ? pendingPosts[key] : undefined;
      if (record?.status === "published" || publishing.has(key)) {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже опубликована", show_alert: true });
        return;
      }
      if (action === "rejb") {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
        await replaceReplyMarkup(cb.message, reviewKeyboard(key));
        return;
      }
      if (action === "rejr") {
        await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Напишите причину ответом на сообщение бота" });
        await askRejectReason(cb.message, key, text);
        return;
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Отклонено" });
      await rejectComplaint(key, "", { chatId: cb.message.chat.id, messageId: cb.message.message_id, text, isMedia });
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

  if (cmd === "start" && msg.chat.type === "private" && /^\/start(?:@\w+)?\s+pars_/i.test(msg.text || "") && isOwner(msg.from?.id)) {
    const token = (msg.text || "").split(/\s+/)[1]!.slice("pars_".length);
    await parsOffer(msg.chat.id, token);
    return;
  }
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
  if (cmd === "emoji") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    const arg = (msg.text || "").replace(/^\/\S+\s*/, "").trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      bindings.customEmoji = arg === "on";
      saveBindings();
    }
    if (arg === "reload") {
      await loadPackEmoji(true);
      const got = Object.keys(bindings.packEmoji?.map || {});
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: got.length
          ? `Из пака ${bindings.packEmoji?.set} взято ${got.length} значков: ${got.join(" ")}`
          : "Не удалось прочитать пак эмодзи. Подробности в логах сервера.",
      });
      return;
    }
    const state = customEmojiEnabled() ? "включены" : "выключены";
    await tgSoft("sendMessage", {
      chat_id: msg.chat.id,
      text:
        arg === "on" || arg === "off"
          ? `Премиум-эмодзи ${state}. Работают в личных сообщениях бота (меню и шаги жалобы), пока у владельца активен Telegram Premium.`
          : `Премиум-эмодзи сейчас ${state}. Включить: /emoji on · выключить: /emoji off · перечитать пак: /emoji reload`,
    });
    return;
  }
  if (cmd === "backup") {
    if (msg.chat.type !== "private" || !isOwner(msg.from?.id)) return;
    const r = await sendOffsiteBackup(true);
    if (r !== "sent") {
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: r === "too big" ? "Копия больше 45 МБ — Telegram её не примет." : "Не удалось отправить копию, попробуйте позже.",
      });
    }
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
  if (isOfficialArbiterChat(msg.chat.id) && !cmd && (await handleRejectReasonReply(msg))) return;
  if (isOfficialArbiterChat(msg.chat.id) && !cmd && (await handlePostPhotoReply(msg))) return;
  if (isOfficialArbiterChat(msg.chat.id) && removeFromCheckSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyRemoveFromCheck(msg.chat.id, msg.text);
    return;
  }
  if (isOfficialArbiterChat(msg.chat.id) && banSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
    await applyBan(msg.chat.id, msg.text);
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
  // Adding a source channel: the owner, in a private chat (/userbot → add).
  if (msg.chat.type === "private" && isOwner(msg.from?.id) && checkChannelSetup.has(String(msg.chat.id)) && msg.text && !cmd) {
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
  // Answer to the captcha shown before a bot check.
  if (botCaptchaWait.has(String(msg.chat.id)) && msg.text && !cmd) {
    const cid = String(msg.chat.id);
    const r = solveCaptcha(cid, msg.text);
    if (r === "ok") {
      const q = botCaptchaWait.get(cid) || "";
      botCaptchaWait.delete(cid);
      dropBotCaptchaMsg(cid);
      if (q === SUBMIT_CAPTCHA) {
        const session = sessions.get(userId);
        if (session) await submitSession(msg.chat.id, userId, session);
        else await tgSoft("sendMessage", { chat_id: msg.chat.id, text: btUser(userId, "restart") });
        return;
      }
      captchaRequired(cid); // consume one credit for this check
      await runBotCheck(msg.chat.id, q, true, msg.from);
    } else if (r === "wrong") {
      await sendCeMessage(msg.chat.id, botCapText(cid, "wrong"));
    } else {
      await sendBotCaptcha(msg.chat.id, botCapText(cid, r === "again" ? "again" : "expired"));
    }
    return;
  }
  // A user who tapped "Проверить контрагента": their next text is the query.
  if (checkWait.has(String(msg.chat.id)) && msg.text && !cmd) {
    checkWait.delete(String(msg.chat.id));
    await runBotCheck(msg.chat.id, msg.text, false, msg.from);
    return;
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
  // In polling mode the bot pulls updates itself; a webhook would block that.
  if (updatesMode() === "polling") {
    startUpdatePolling();
    return { ok: true as const, url: clean };
  }
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

// ---- Off-site backup: once a day the data files go to the owner in Telegram ----
// The local copies in data/backups die with the server; this one survives the
// hosting going away. Userbot sessions (account keys) and the big media folders
// are never included. Restore with scripts/restore-backup.mjs.
function offsiteFiles(): string[] {
  return [
    BINDINGS_PATH,
    RELAY_PATH,
    PENDING_PATH,
    ID_CACHE_PATH,
    LOCALES_PATH,
    CHECK_INDEX_PATH,
    USERS_PATH,
    BROADCAST_PATH,
    DM_JOBS_PATH,
    join(DATA_DIR, "telegram-ids.json"),
    UNAME_HISTORY_PATH,
    TIERS_PATH,
  ];
}

let offsiteFailures = 0;
export async function sendOffsiteBackup(force = false): Promise<"sent" | "not due" | "too big" | "failed"> {
  if (!botToken()) return "failed";
  if (!force && Date.now() - (bindings.offsiteBackupAt || 0) < 23 * 60 * 60 * 1000) return "not due";
  const files: Record<string, string> = {};
  for (const path of offsiteFiles()) {
    try {
      if (existsSync(path)) files[basename(path)] = readFileSync(path, "utf8");
    } catch {
      /* skip unreadable */
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  const gz = gzipSync(Buffer.from(JSON.stringify({ kind: "epb-backup", version: 1, createdAt: new Date().toISOString(), files })));
  if (gz.length > 45 * 1024 * 1024) return "too big";
  const form = new FormData();
  form.set("chat_id", OWNER_ID);
  form.set("disable_notification", "true");
  form.set(
    "caption",
    `🗄 Резервная копия данных EPB за ${day} (файлов: ${Object.keys(files).length}).\n` +
      "Если сервер пропадёт: остановите бота, положите этот файл на новый сервер и выполните\n" +
      "node scripts/restore-backup.mjs <файл>",
  );
  form.set("document", new File([new Uint8Array(gz)], `epb-backup-${day}.json.gz`, { type: "application/gzip" }));
  try {
    await tgForm("sendDocument", form);
    offsiteFailures = 0;
    bindings.offsiteBackupAt = Date.now();
    saveBindings();
    return "sent";
  } catch (err) {
    offsiteFailures += 1;
    if (offsiteFailures === 1) console.error("[epb] off-site backup:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

if (botToken() && process.env.NODE_ENV !== "test" && (process.env.PUBLIC_URL || process.env.NODE_ENV === "production")) {
  setTimeout(() => void sendOffsiteBackup(), 90_000);
  setInterval(() => void sendOffsiteBackup(), 60 * 60 * 1000).unref?.();
}

// Check the webhook right after start, not only when the first update arrives:
// with a wrong secret no update would ever arrive.
if (botToken() && (process.env.PUBLIC_URL || process.env.NODE_ENV === "production")) {
  setTimeout(() => void ensureBotProfile().catch(() => {}), 3000);
  // Start pulling updates even if the profile setup above fails (network hiccup
  // at boot): the poll loop retries on its own.
  if (updatesMode() === "polling" && process.env.NODE_ENV !== "test") setTimeout(startUpdatePolling, 4000);
}
if (botToken() && broadcastJobs.length) setTimeout(resumeBroadcasts, 5000);
if (botToken() && dmJobs.length) setTimeout(resumeDmJobs, 6000);
