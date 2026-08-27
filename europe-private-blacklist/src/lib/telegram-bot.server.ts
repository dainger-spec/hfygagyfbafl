import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_NAME, CHANNEL_URL, KNOWN_TELEGRAM_IDS, parseTelegramInput } from "@/lib/telegram";
import type { Application, ComplaintHistoryItem, Currency, EvidenceItem, PersonRef } from "@/lib/types";
import { scammerAccounts } from "@/lib/types";

const TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "8812183706:AAEHr2RTyW-pdMLDYF9E_91Fs3XJxnH_br4";
const API = `https://api.telegram.org/bot${TOKEN}`;
export const BOT_USERNAME = "EuBlackList_bot";
export const WEBHOOK_SECRET = `epb-${createHash("sha256").update(TOKEN).digest("hex").slice(0, 24)}`;

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const BINDINGS_PATH = join(DATA_DIR, "telegram-bindings.json");
const REQUESTED_ARBITER = process.env.TELEGRAM_ARBITER_CHAT_ID || "-5422557027";
const PINNED_ARBITER_CHAT = "-1003904954808";
const PINNED_CHANNEL = "-1003958415589";

type Bindings = {
  arbiterChatId?: string;
  channelId?: string;
  miniAppUrl?: string;
  cards?: Partial<Record<"welcome" | "submitted" | "published", string>>;
  cardStamp?: string;
};

let bindings: Bindings = loadBindings();
let profileReady = false;
let commandsStamp = "";
const COMMANDS_STAMP = "eu-blacklist-bot-v1";

function loadBindings(): Bindings {
  try {
    return JSON.parse(readFileSync(BINDINGS_PATH, "utf8")) as Bindings;
  } catch {
    return {};
  }
}

function saveBindings() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(BINDINGS_PATH, JSON.stringify(bindings, null, 2));
  } catch {
    // Vercel filesystem is read-only — in-memory bindings still work for this instance.
  }
}

const ID_CACHE_PATH = join(DATA_DIR, "telegram-ids.json");
const PENDING_PATH = join(DATA_DIR, "telegram-pending.json");

type MediaRef = { type: "photo" | "video" | "document"; file_id: string };
type PendingPost = {
  username: string;
  id: string;
  accounts?: { username: string; id: string }[];
  story: string;
  amount: string;
  currency: string;
  files: MediaRef[];
  victimId?: string;
  victimUsername?: string;
  createdAt?: number;
  status?: "pending" | "published" | "rejected";
};

let idCache: Record<string, string> = {};
let pendingPosts: Record<string, PendingPost> = {};

try {
  idCache = { ...KNOWN_TELEGRAM_IDS, ...(JSON.parse(readFileSync(ID_CACHE_PATH, "utf8")) as Record<string, string>) };
} catch {
  idCache = { ...KNOWN_TELEGRAM_IDS };
}
try {
  pendingPosts = JSON.parse(readFileSync(PENDING_PATH, "utf8")) as Record<string, PendingPost>;
} catch {
  pendingPosts = {};
}

function saveIdCache() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ID_CACHE_PATH, JSON.stringify(idCache, null, 2));
  } catch {
    /* ignore */
  }
}

function savePending() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PENDING_PATH, JSON.stringify(pendingPosts, null, 2));
  } catch {
    /* ignore */
  }
}

function rememberUser(user?: { id?: number; username?: string } | null) {
  const username = user?.username?.replace(/^@/, "").toLowerCase();
  if (!user?.id || !username) return;
  const id = String(user.id);
  if (idCache[username] === id) return;
  idCache[username] = id;
  saveIdCache();
}

function rememberHandle(username: string, id: string) {
  const key = username.replace(/^@/, "").toLowerCase();
  if (!key || !id || !/^\d{5,15}$/.test(id)) return;
  if (idCache[key] === id) return;
  idCache[key] = id;
  saveIdCache();
}

const SESSION_PATH = join(DATA_DIR, "telegram-mtproto.session");
const EVIDENCE_DIR = join(DATA_DIR, "evidence");
const TG_API_ID = Number(process.env.TELEGRAM_API_ID || 6);
const TG_API_HASH = process.env.TELEGRAM_API_HASH || "eb06d4abfb49dc3eeb1aeb98ae0f581e";

let mtClient: any = null;
let mtBoot: Promise<any> | null = null;

async function mtprotoClient() {
  if (mtClient?.connected) return mtClient;
  if (mtBoot) return mtBoot;
  mtBoot = (async () => {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    let saved = "";
    try {
      saved = "";
      if (existsSync(SESSION_PATH)) {
        /* old bot session is invalid after token change */
      }
    } catch {
      saved = "";
    }
    const client = new TelegramClient(new StringSession(saved), TG_API_ID, TG_API_HASH, {
      connectionRetries: 3,
      timeout: 20,
    });
    try {
      (client as { setLogLevel?: (level: string) => void }).setLogLevel?.("error");
    } catch {
      /* ignore */
    }
    await client.start({ botAuthToken: TOKEN });
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const dumped = client.session.save() as unknown;
      writeFileSync(SESSION_PATH, typeof dumped === "string" ? dumped : saved);
    } catch {
      /* ignore */
    }
    mtClient = client;
    return mtClient;
  })().catch((err: unknown) => {
    mtBoot = null;
    throw err;
  });
  return mtBoot;
}

async function resolveUsernameMtproto(username: string): Promise<{ username: string; id: string } | null> {
  try {
    const client = await mtprotoClient();
    if (!client) return null;
    const { Api } = await import("telegram/tl/index.js");
    const result = (await client.invoke(new Api.contacts.ResolveUsername({ username }))) as {
      peer?: { userId?: unknown; className?: string };
      users?: { id?: unknown; username?: string }[];
    };
    const user = result.users?.[0];
    const id = String(user?.id ?? result.peer?.userId ?? "");
    if (!/^\d{5,15}$/.test(id)) return null;
    return { username: user?.username || username, id };
  } catch {
    return null;
  }
}

export function saveUploadedEvidence(id: string, bytes: Buffer) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, id), bytes);
  return id;
}

function readUploadedEvidence(id: string): Buffer | null {
  const path = join(EVIDENCE_DIR, id);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

type TgResult<T> = { ok: true; result: T } | { ok: false; description: string; error_code?: number };

async function tg<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TgResult<T>;
  if (!json.ok) throw new Error(json.description || method);
  return json.result;
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
    .replace(/>/g, "&" + "gt;");
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
if (!bindings.channelId || !isOfficialChannel(bindings.channelId)) {
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
  return tgSoft<{ id: number; title?: string; type: string }>("getChat", { chat_id: id });
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
  const url = bindings.miniAppUrl;
  if (!url?.startsWith("https://") || isGatedHost(url)) return undefined;
  return url;
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

async function publicSiteUrl(): string | undefined {
  const fromEnv = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (fromEnv.startsWith("https://") && !isGatedHost(fromEnv)) return fromEnv;
  return publicMiniAppUrl();
}

async function ensureProductionWebhook() {
  const site = await publicSiteUrl();
  if (!site) return;
  const hook = `${site}/api/telegram/webhook`;
  const info = await tgSoft<{ url?: string }>("getWebhookInfo");
  if (info?.url === hook) {
    await applyMenuButton();
    return;
  }
  await tgSoft("setWebhook", {
    url: hook,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: false,
  });
  await registerMiniAppUrl(site);
}

async function ensurePolling() {
  if (process.env.PUBLIC_URL) {
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
      ],
    });
  }
  if (profileReady) return;
  profileReady = true;
  await tgSoft("setMyShortDescription", {
    short_description: "Закрытый европейский блеклист. Mini App → жалоба → арбитры.",
  });
  await tgSoft("setMyDescription", {
    description: [
      "Europe Private Blacklist — закрытый европейский блеклист мошенников.",
      "",
      "1. /start и «Открыть приложение»",
      "2. Mini App подтягивает ваш Telegram",
      "3. На главной — Подать жалобу",
      "4. Арбитры: Опубликовать или Отклонить",
    ].join("\n"),
  });
}

export async function getBotStatus() {
  await ensureBotProfile();
  await ensurePolling();
  void mtprotoClient().catch(() => null);
  const me = await tgSoft<{ username: string; first_name: string }>("getMe");

  let arbiterOk = false;
  let arbiterId = bindings.arbiterChatId || REQUESTED_ARBITER;
  for (const id of arbiterCandidates()) {
    const chat = await chatReachable(id);
    if (!chat) continue;
    arbiterOk = true;
    arbiterId = String(chat.id);
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
    arbiterId,
    channelOk,
    miniAppUrl: publicMiniAppUrl() || "",
  };
}

export async function resolveHandleServer(input: string): Promise<{
  username: string;
  id: string;
  source: "telegram" | "parsed" | "unresolved";
} | null> {
  const parsed = parseTelegramInput(input);
  if (!parsed.username && !parsed.id) return null;
  if (parsed.id && !parsed.username) {
    const chat = await tgSoft<{ id: number; username?: string; type: string }>("getChat", {
      chat_id: parsed.id,
    });
    if (chat?.username) rememberHandle(chat.username, parsed.id);
    return { username: chat?.username || "", id: parsed.id, source: "parsed" };
  }
  const username = parsed.username;
  if (parsed.id) {
    rememberHandle(username, parsed.id);
    return { username, id: parsed.id, source: "parsed" };
  }
  const cached = idCache[username.toLowerCase()];
  if (cached) {
    return { username, id: cached, source: "telegram" };
  }
  const mt = await resolveUsernameMtproto(username);
  if (mt?.id) {
    rememberHandle(mt.username, mt.id);
    return { username: mt.username, id: mt.id, source: "telegram" };
  }
  const chat = await tgSoft<{ id: number; username?: string; type: string }>("getChat", {
    chat_id: `@${username}`,
  });
  if (chat?.id && chat.id > 0 && chat.type !== "channel" && chat.type !== "supergroup" && chat.type !== "group") {
    const id = String(chat.id);
    rememberHandle(chat.username || username, id);
    return { username: chat.username || username, id, source: "telegram" };
  }
  return { username, id: "", source: "unresolved" };
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

function applicationHtml(app: Application): string {
  const victim = `@${app.victim.username.replace(/^@/, "")} · <code>${escapeHtml(app.victim.telegramId)}</code>`;
  const accounts = scammerAccounts(app);
  const scammer = accounts.map((a) => formatAccountLine(a.username, a.telegramId, true)).join("\n");
  const first = accounts[0];
  return [
    `<b>Заявка ${escapeHtml(app.id)}</b>`,
    "",
    `<b>Пострадавший</b>\n${victim}`,
    `<b>Мошенник</b>\n${scammer}`,
    `<b>Ущерб</b>\n${escapeHtml(app.damageAmount)} ${escapeHtml(app.damageCurrency)}`,
    "",
    `<b>Суть обмана</b>\n${escapeHtml(app.story.trim())}`,
    "",
    `#epb u=${escapeHtml(first?.username.replace(/^@/, "") || "")} id=${escapeHtml(first?.telegramId || "")} k=${escapeHtml(app.id)}`,
  ].join("\n");
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
  return accounts.map((a, i) => {
    const handle = a.username.replace(/^@/, "");
    const head = [handle ? `@${escapeHtml(handle)}` : "", a.id ? `Id: ${escapeHtml(a.id)}` : ""]
      .filter(Boolean)
      .join(" ");
    const last = i === accounts.length - 1;
    if (last && scam) return `${head} - ${scam}`;
    if (accounts.length > 1) return `${head} ;`;
    return head;
  });
}

function channelHtml(
  accounts: { username: string; id: string }[],
  story: string,
  amount = "",
  currency = "",
): string {
  const people = formatChannelAccounts(accounts, amount, currency);
  const subscribe = `<b>Subscribe:</b> <b><a href="${CHANNEL_URL}">Europe Private Blacklist</a></b>`;
  return [...people, "", escapeHtml(story.trim()), "", subscribe]
    .filter((line, i, arr) => line !== "" || (arr[i - 1] !== "" && i !== 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function applicationCaption(app: Application): string {
  const accounts = scammerAccounts(app);
  const first = accounts[0];
  const scamLine = accounts
    .map((a) => formatAccountLine(a.username, a.telegramId, true))
    .join("\n");
  const victimUser = app.victim.username.replace(/^@/, "");
  const head = [
    `<b>Жалоба ${escapeHtml(app.id)}</b>`,
    `Пострадавший: ${victimUser ? `@${escapeHtml(victimUser)} · ` : ""}<code>${escapeHtml(app.victim.telegramId)}</code>`,
    `Мошенник:\n${scamLine}`,
    `Ущерб: ${escapeHtml(app.damageAmount)} ${escapeHtml(app.damageCurrency)}`,
    "",
  ].join("\n");
  const tail = `\n\n#epb u=${escapeHtml(first?.username.replace(/^@/, "") || "")} id=${escapeHtml(first?.telegramId || "")} k=${escapeHtml(app.id)}`;
  let story = app.story.trim();
  const budget = 1024 - head.length - tail.length;
  if (story.length > budget) story = `${story.slice(0, Math.max(0, budget - 1))}…`;
  return `${head}${escapeHtml(story)}${tail}`;
}

function reviewKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Опубликовать", callback_data: "pub" },
        { text: "Отклонить", callback_data: "rej" },
      ],
    ],
  };
}

async function tgForm<T>(method: string, form: FormData): Promise<T> {
  const res = await fetch(`${API}/${method}`, { method: "POST", body: form });
  const json = (await res.json()) as TgResult<T>;
  if (!json.ok) throw new Error(json.description || method);
  return json.result;
}

async function sendMediaFile(
  chatId: string,
  file: EvidenceItem,
  opts: { caption?: string; replyMarkup?: unknown; replyTo?: number } = {},
): Promise<{ message_id: number; chat: { id: number }; fileId?: string; kind: "photo" | "video" }> {
  const blob = evidenceBlob(file);
  if (!blob) throw new Error("empty file");
  const form = new FormData();
  form.set("chat_id", chatId);
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
  for (const a of accounts) rememberHandle(a.username, a.id);
  const first = accounts[0] || { username: app.scammer.username, id: app.scammer.telegramId };
  pendingPosts[app.id] = {
    username: first.username,
    id: first.id,
    accounts,
    story: app.story,
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
  if (!accounts.length) return "мошенника";
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
      ? `Жалоба ${appId} на ${scam} принята.\nСтатус: подано. Арбитры проверят материалы.`
      : kind === "published"
        ? `Жалоба ${appId} на ${scam} одобрена и опубликована в Europe Private Blacklist.`
        : `Жалоба ${appId} на ${scam} отклонена арбитрами. Публикации не будет.`;
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

async function attachReviewButtons(chatId: string, messageId: number, caption: string, keyboard: unknown) {
  const edited = await tgSoft("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
  if (edited) return messageId;
  const sent = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: messageId,
    reply_markup: keyboard,
  });
  return sent.message_id;
}

function mediaRefsFromCopies(copies: CopiedMedia[]): MediaRef[] {
  return copies
    .filter((c): c is CopiedMedia & { fileId: string } => Boolean(c.fileId))
    .map((c) => ({
      type: c.kind === "video" ? "video" : c.kind === "document" ? "document" : "photo",
      file_id: c.fileId,
    }));
}

async function sendAlbumByFileIds(
  chatId: string,
  files: MediaRef[],
  caption: string,
  keyboard: unknown,
): Promise<{ chat_id: string; message_id: number; files: MediaRef[] }> {
  if (!files.length) {
    const sent = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
    return { chat_id: String(sent.chat.id), message_id: sent.message_id, files: [] };
  }
  if (files.length === 1) {
    const file = files[0]!;
    const method = file.type === "video" ? "sendVideo" : file.type === "document" ? "sendDocument" : "sendPhoto";
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    };
    if (file.type === "video") payload.video = file.file_id;
    else if (file.type === "document") payload.document = file.file_id;
    else payload.photo = file.file_id;
    const sent = await tg<{ message_id: number; chat: { id: number } }>(method, payload);
    return { chat_id: String(sent.chat.id), message_id: sent.message_id, files };
  }

  let firstId = 0;
  for (let i = 0; i < files.length; i += 10) {
    const chunk = files.slice(i, i + 10);
    if (chunk.length === 1) {
      const file = chunk[0]!;
      const method = file.type === "video" ? "sendVideo" : file.type === "document" ? "sendDocument" : "sendPhoto";
      const payload: Record<string, unknown> = { chat_id: chatId };
      if (file.type === "video") payload.video = file.file_id;
      else if (file.type === "document") payload.document = file.file_id;
      else payload.photo = file.file_id;
      if (i === 0) {
        payload.caption = caption;
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
        ...(i === 0 && idx === 0 ? { caption, parse_mode: "HTML" } : {}),
      })),
    });
    if (i === 0) firstId = result[0]?.message_id || 0;
  }
  const actionId = await attachReviewButtons(chatId, firstId, caption, keyboard);
  return { chat_id: chatId, message_id: actionId, files };
}

async function sendAlbumFromBlobs(
  chatId: string,
  blobs: EvidenceItem[],
  caption: string,
  keyboard: unknown,
): Promise<{ chat_id: string; message_id: number; files: MediaRef[] }> {
  if (blobs.length <= 1) {
    const sent = await sendMediaFile(chatId, blobs[0]!, { caption, replyMarkup: keyboard });
    const files: MediaRef[] = sent.fileId ? [{ type: sent.kind, file_id: sent.fileId }] : [];
    return { chat_id: String(sent.chat.id), message_id: sent.message_id, files };
  }

  const files: MediaRef[] = [];
  let firstId = 0;
  for (let i = 0; i < blobs.length; i += 10) {
    const chunk = blobs.slice(i, i + 10);
    if (chunk.length === 1) {
      const sent = await sendMediaFile(chatId, chunk[0]!, i === 0 ? { caption } : {});
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
        ...(i === 0 && idx === 0 ? { caption, parse_mode: "HTML" } : {}),
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
  const actionId = await attachReviewButtons(chatId, firstId, caption, keyboard);
  return { chat_id: chatId, message_id: actionId, files };
}

async function deliverApplication(
  app: Application,
  copies: CopiedMedia[] = [],
): Promise<{ chat_id: string; message_id: number }> {
  const caption = applicationCaption(app);
  const keyboard = reviewKeyboard();
  const blobs = app.evidence.filter((f) => Boolean(evidenceBlob(f)));
  const copyFiles = mediaRefsFromCopies(copies);
  let lastError = "chat not found";

  for (const chat_id of arbiterCandidates()) {
    try {
      if (copyFiles.length || copies.length) {
        const sent = copyFiles.length
          ? await sendAlbumByFileIds(chat_id, copyFiles, caption, keyboard)
          : null;
        if (sent) {
          storePending(app, sent.files);
          return { chat_id: sent.chat_id, message_id: sent.message_id };
        }
      }

      if (blobs.length) {
        const sent = await sendAlbumFromBlobs(chat_id, blobs, caption, keyboard);
        storePending(app, sent.files);
        return { chat_id: sent.chat_id, message_id: sent.message_id };
      }

      const sent = await tg<{ message_id: number; chat: { id: number } }>("sendMessage", {
        chat_id,
        text: applicationHtml(app),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      storePending(app, []);
      return { chat_id: String(sent.chat.id), message_id: sent.message_id };
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
  try {
    const sent = await deliverApplication(app, copies);
    if (isOfficialArbiterChat(sent.chat_id)) {
      bindings.arbiterChatId = sent.chat_id;
      saveBindings();
    }
    await notifyApplicant(pendingPosts[app.id], app.id, "pending");
    return { ok: true };
  } catch (err) {
    const description = err instanceof Error ? err.message : "send failed";
    if (/chat not found/i.test(description)) {
      return {
        ok: false,
        error: `Добавьте @${BOT_USERNAME} в чат арбитров админом и напишите там /id`,
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

async function sendChannelPost(html: string, files: MediaRef[]) {
  const ids = channelCandidates();
  if (!ids.length) throw new Error("channel not found");
  const caption = html.length > 1024 ? `${html.slice(0, 1023)}…` : html;
  let lastError = "channel not found";
  for (const chat_id of ids) {
    try {
      if (!files.length) {
        await tg("sendMessage", {
          chat_id,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        });
        return;
      }
      for (let i = 0; i < files.length; i += 10) {
        const chunk = files.slice(i, i + 10);
        const firstCaption = i === 0 ? caption : undefined;
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
          await tg(method, payload);
        } else {
          await tg("sendMediaGroup", {
            chat_id,
            media: chunk.map((file, idx) => ({
              type: file.type,
              media: file.file_id,
              ...(firstCaption && idx === 0 ? { caption: firstCaption, parse_mode: "HTML" } : {}),
            })),
          });
        }
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

async function publishFromMessage(
  text: string,
  callbackId: string,
  extraFiles: MediaRef[] = [],
): Promise<boolean> {
  const parsed = parseEpbMarker(text);
  if (!parsed) {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Не удалось разобрать заявку",
      show_alert: true,
    });
    return false;
  }
  const stored = parsed.key ? pendingPosts[parsed.key] : undefined;
  const html = channelHtml(
    pendingAccounts(stored, parsed.username, parsed.id),
    stored?.story || parsed.story,
    stored?.amount,
    stored?.currency,
  );
  const files = stored?.files?.length ? stored.files : extraFiles;
  if (!channelCandidates().length) {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: `Добавьте @${BOT_USERNAME} админом в канал Europe Private Blacklist`,
      show_alert: true,
    });
    return false;
  }
  try {
    await sendChannelPost(html, files);
  } catch {
    await tgSoft("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: `Не удалось опубликовать. Бот должен быть админом канала.`,
      show_alert: true,
    });
    return false;
  }
  if (parsed.key && pendingPosts[parsed.key]) {
    pendingPosts[parsed.key]!.status = "published";
    savePending();
    await notifyApplicant(pendingPosts[parsed.key], parsed.key, "published");
  }
  await tgSoft("answerCallbackQuery", { callback_query_id: callbackId, text: "Опубликовано" });
  return true;
}

type TgUser = { id: number; username?: string; first_name?: string };

type TgMessage = {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  from?: TgUser;
  photo?: { file_id: string }[];
  video?: { file_id: string };
  document?: { mime_type?: string; file_id?: string };
  forward_from?: TgUser;
  forward_origin?: { sender_user?: TgUser };
  entities?: { type: string; user?: TgUser }[];
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: {
    chat: { id: number; type: string; title?: string };
    new_chat_member: { status: string };
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

type ApplyStep = "scammer" | "victim" | "story" | "amount" | "evidence";

type ApplySession = {
  step: ApplyStep;
  accounts: { username: string; id: string }[];
  victimUsername: string;
  victimId: string;
  victimName: string;
  story: string;
  amount: string;
  currency: Currency;
  evidence: CopiedMedia[];
};

const sessions = new Map<string, ApplySession>();

function commandName(text?: string): string | null {
  if (!text?.startsWith("/")) return null;
  const token = text.split(/\s+/)[0] ?? "";
  return token.slice(1).split("@")[0]?.toLowerCase() || null;
}

function applyKeyboard() {
  const url = publicMiniAppUrl();
  const rows: Record<string, unknown>[][] = [];
  if (url) {
    rows.push([{ text: "Открыть приложение", web_app: { url } }]);
  }
  rows.push([{ text: "Подать жалобу в чате", callback_data: "apply" }]);
  return { inline_keyboard: rows };
}

function startText() {
  return [
    "<b>Europe Private Blacklist</b>",
    "",
    "Откройте приложение, чтобы подать жалобу на мошенника.",
    "",
    "Арбитры проверят материалы: одобрили — карточка в канале, отклонили — без публикации.",
  ].join("\n");
}

type CardKind = "welcome" | "submitted" | "published";

function cardPath(kind: CardKind): string | null {
  const name = `${kind}.jpg`;
  const candidates = [
    join(process.cwd(), "public/bot", name),
    join("/workspace/public/bot", name),
  ];
  return candidates.find((p) => existsSync(p)) || null;
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
  }
  const path = cardPath(kind);
  if (!path) {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
    return;
  }
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption);
  form.set("parse_mode", "HTML");
  if (extra.reply_markup) form.set("reply_markup", JSON.stringify(extra.reply_markup));
  const bytes = readFileSync(path);
  form.set("photo", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), `${kind}.jpg`);
  try {
    const sent = await tgForm<{ photo?: { file_id: string }[] }>("sendPhoto", form);
    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) {
      bindings.cards = { ...bindings.cards, [kind]: fileId };
      saveBindings();
    }
  } catch {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }
}

async function replyStart(chatId: number) {
  await sendCard(chatId, "welcome", startText(), { reply_markup: applyKeyboard() });
}

function newSession(from: TgUser): ApplySession {
  return {
    step: "scammer",
    accounts: [],
    victimUsername: from.username || "",
    victimId: String(from.id),
    victimName: from.first_name || "",
    story: "",
    amount: "",
    currency: "USD",
    evidence: [],
  };
}

function parseAmount(text: string): { amount: string; currency: Currency } | null {
  const m = text.trim().match(/(\d+(?:[.,]\d+)?)/);
  if (!m?.[1]) return null;
  const amount = m[1].replace(",", ".");
  const upper = text.toUpperCase();
  let currency: Currency = "USD";
  if (/\bEUR\b|€|ЕВРО/.test(upper)) currency = "EUR";
  else if (/\bUSDT\b/.test(upper)) currency = "USDT";
  else if (/\bRUB\b|₽|РУБ/.test(upper)) currency = "RUB";
  else if (/\bUSD\b|\$|БАКС|ДОЛЛАР/.test(upper)) currency = "USD";
  return { amount, currency };
}

function hasMedia(msg: TgMessage) {
  return Boolean(msg.photo?.length || msg.video || msg.document);
}

function formatSessionAccounts(session: ApplySession) {
  if (!session.accounts.length) return "пока пусто";
  return session.accounts
    .map((a, i) => `${i + 1}. ${a.username ? `@${a.username.replace(/^@/, "")} · ` : ""}${a.id}`)
    .join("\n");
}

async function askScammer(chatId: number, session?: ApplySession) {
  const listed = session ? formatSessionAccounts(session) : "";
  const rows: { text: string; callback_data: string }[][] = [];
  if (session?.accounts.length) {
    rows.push([
      { text: "Ещё аккаунт", callback_data: "apply:more" },
      { text: "Далее", callback_data: "apply:next" },
    ]);
  }
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: session?.accounts.length
      ? `Аккаунты мошенника:\n${listed}\n\nПерешлите сообщение следующего аккаунта или напишите @username. Когда все добавлены — «Далее».`
      : "Шаг 1/5. Аккаунты мошенника.\nПерешлите его сообщение, @username или t.me.\nЕсли прятался под несколькими аккаунтами — пришлите по очереди, затем «Далее».",
    reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
  });
}

async function askVictim(chatId: number, session: ApplySession) {
  const current = session.victimUsername
    ? `@${session.victimUsername} · id ${session.victimId}`
    : `id ${session.victimId} (username нет)`;
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: `Шаг 2/5. Ваш контакт, чтобы арбитры могли связаться.\nСейчас: ${current}\nНапишите другой @username или нажмите «Оставить».`,
    reply_markup: {
      inline_keyboard: [[{ text: "Оставить", callback_data: "apply:keep" }]],
    },
  });
}

async function askStory(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: "Шаг 3/5. Суть обмана одним сообщением.",
  });
}

async function askAmount(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: "Шаг 4/5. Сумма ущерба. Например: 250 EUR или 100 USD.",
  });
}

async function askEvidence(chatId: number) {
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: "Шаг 5/5. Скрины и видео. Пришлите файлы, можно несколько. Когда закончите — «Готово».",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Готово", callback_data: "apply:done" },
          { text: "Без файлов", callback_data: "apply:skip" },
        ],
      ],
    },
  });
}

async function askConfirm(chatId: number, session: ApplySession) {
  const victim = session.victimUsername ? `@${session.victimUsername}` : session.victimName || session.victimId;
  const files = session.evidence.length ? `${session.evidence.length} файл(ов)` : "без файлов";
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: [
      "Проверьте заявку:",
      "",
      "Мошенник:",
      formatSessionAccounts(session),
      `Пострадавший: ${victim} · ${session.victimId}`,
      `Ущерб: ${session.amount} ${session.currency}`,
      `Доказательства: ${files}`,
      "",
      session.story,
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Отправить на рассмотрение", callback_data: "apply:send" },
          { text: "Отмена", callback_data: "apply:cancel" },
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
    text: "Заявка на блеклист. Отмена — /cancel.",
  });
  await askScammer(chatId, session);
}

async function cancelApply(chatId: number, userId: string, notice = "Заявка отменена.") {
  sessions.delete(userId);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: notice,
    reply_markup: applyKeyboard(),
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
    await tgSoft("sendMessage", { chat_id: chatId, text: "Добавьте хотя бы один аккаунт мошенника." });
    session.step = "scammer";
    sessions.set(userId, session);
    await askScammer(chatId, session);
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
    story: session.story,
    damageAmount: session.amount,
    damageCurrency: session.currency,
    evidence: [],
  };
  const result = await sendApplicationToArbiters(app, session.evidence);
  if (!result.ok) {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: result.error || "Не удалось отправить арбитрам.",
    });
    return;
  }
  sessions.delete(userId);
  await tgSoft("sendMessage", {
    chat_id: chatId,
    text: `Заявка ${app.id} ушла арбитрам. Если одобрят — пост в канале, если нет — публикация не выйдет.`,
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
            text: "Сначала добавьте хотя бы один аккаунт.",
          });
          return;
        }
        session.step = "victim";
        sessions.set(userId, session);
        await askVictim(chatId, session);
        return;
      }
      const resolved = await resolveHandleServer(raw);
      if (!resolved) {
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: "Не разобрал. Перешлите сообщение мошенника или напишите @username.",
        });
        return;
      }
      username = resolved.username;
      id = resolved.id;
      if (!id) {
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: `@${resolved.username} принял, но ID не найден. Перешлите любое его сообщение или допишите числовой ID.`,
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
    const raw = (msg.text || "").trim();
    if (!raw) {
      await askVictim(chatId, session);
      return;
    }
    const parsed = parseTelegramInput(raw);
    session.victimUsername = parsed.username || raw.replace(/^@/, "");
    if (parsed.id) session.victimId = parsed.id;
    session.step = "story";
    await askStory(chatId);
    return;
  }

  if (session.step === "story") {
    const story = (msg.text || msg.caption || "").trim();
    if (story.length < 8) {
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: "Нужно описание схемы — хотя бы пару предложений.",
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
        text: "Напишите сумму числом, например 250 EUR.",
      });
      return;
    }
    session.amount = parsed.amount;
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
      if (session.evidence.length >= 20) {
        await askConfirm(chatId, session);
        return;
      }
      await tgSoft("sendMessage", {
        chat_id: chatId,
        text: `Файл ${session.evidence.length}/20 принят. Ещё или «Готово».`,
        reply_markup: {
          inline_keyboard: [[{ text: "Готово", callback_data: "apply:done" }]],
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
      text: "Пришлите скрин или видео, либо нажмите «Готово».",
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
          text: "Заявку нужно подать в личке с ботом",
          show_alert: true,
        });
        await tgSoft("sendMessage", {
          chat_id: chatId,
          text: `Откройте @${BOT_USERNAME} в личных сообщениях и нажмите /apply`,
        });
        return;
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });
      await startApply(chatId, cb.from);
      return;
    }
    await tgSoft("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Начните заново: /apply",
    });
    return;
  }

  await tgSoft("answerCallbackQuery", { callback_query_id: cb.id });

  if (cb.data === "apply:keep") {
    session.step = "story";
    sessions.set(userId, session);
    await askStory(chatId);
    return;
  }
  if (cb.data === "apply:next") {
    if (!session.accounts.length) {
      await tgSoft("sendMessage", { chat_id: chatId, text: "Сначала добавьте аккаунт мошенника." });
      return;
    }
    session.step = "victim";
    sessions.set(userId, session);
    await askVictim(chatId, session);
    return;
  }
  if (cb.data === "apply:more") {
    await tgSoft("sendMessage", {
      chat_id: chatId,
      text: "Пришлите следующий аккаунт: перешлите сообщение или @username.",
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

async function rejectForeignChat(chat: { id: number; type: string; title?: string }) {
  await tgSoft("sendMessage", {
    chat_id: chat.id,
    text: "Этот бот работает только в официальном чате Europe Private Blacklist. Чужие чаты не обслуживаются.",
  });
  await tgSoft("leaveChat", { chat_id: chat.id });
}

async function bindChat(chat: { id: number; type: string; title?: string }) {
  const id = String(chat.id);
  if (chat.type === "channel") {
    if (bindings.channelId && !isOfficialChannel(id)) {
      await rejectForeignChat(chat);
      return;
    }
    if (!bindings.channelId) {
      bindings.channelId = id;
      saveBindings();
    }
    const arbiter = arbiterCandidates()[0] || REQUESTED_ARBITER;
    await tgSoft("sendMessage", {
      chat_id: arbiter,
      text: `Канал подключён: ${chat.title ?? id}\nID: <code>${id}</code>`,
      parse_mode: "HTML",
    });
    return;
  }
  if (chat.type === "group" || chat.type === "supergroup") {
    if (!isOfficialArbiterChat(id)) {
      await rejectForeignChat(chat);
      return;
    }
    bindings.arbiterChatId = id;
    saveBindings();
    await tgSoft("sendMessage", {
      chat_id: id,
      text: [
        `${CHANNEL_NAME}: чат арбитров подтверждён.`,
        `ID: <code>${id}</code>`,
        "",
        "Сюда будут приходить заявки с кнопками Опубликовать / Отклонить.",
      ].join("\n"),
      parse_mode: "HTML",
    });
  }
}

export async function handleUpdate(update: TgUpdate) {
  await ensureBotProfile();
  await applyMenuButton();
  rememberUser(update.message?.from);
  rememberUser(update.message?.forward_from);
  rememberUser(update.message?.forward_origin?.sender_user);
  rememberUser(update.callback_query?.from);
  const member = update.my_chat_member;
  if (member) {
    const status = member.new_chat_member.status;
    if (status === "member" || status === "administrator" || status === "creator") {
      await bindChat(member.chat);
    }
    return;
  }

  const cb = update.callback_query;
  if (cb?.message && cb.data) {
    if ((cb.data === "pub" || cb.data === "rej") && !isOfficialArbiterChat(cb.message.chat.id)) {
      await tgSoft("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Чат не авторизован",
        show_alert: true,
      });
      return;
    }
    const text = cb.message.caption || cb.message.text || "";
    const isMedia = Boolean(cb.message.caption || cb.message.photo || cb.message.video);
    if (text.includes("#published") || text.includes("#rejected")) {
      await tgSoft("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Заявка уже обработана",
      });
      return;
    }
    if (cb.data === "pub") {
      const extraFiles: MediaRef[] = [];
      const lastPhoto = cb.message.photo?.at(-1)?.file_id;
      if (lastPhoto) extraFiles.push({ type: "photo", file_id: lastPhoto });
      if (cb.message.video?.file_id) extraFiles.push({ type: "video", file_id: cb.message.video.file_id });
      const published = await publishFromMessage(text, cb.id, extraFiles);
      if (!published) return;
      const next = `${text}\n\nСтатус: опубликовано`.replace("#epb ", "#published #epb ");
      if (isMedia) {
        await tgSoft("editMessageCaption", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          caption: next,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await tgSoft("editMessageText", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: next,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        });
      }
      return;
    }
    if (cb.data === "rej") {
      const parsed = parseEpbMarker(text);
      if (parsed?.key && pendingPosts[parsed.key]) {
        pendingPosts[parsed.key]!.status = "rejected";
        savePending();
        await notifyApplicant(pendingPosts[parsed.key], parsed.key, "rejected");
      }
      await tgSoft("answerCallbackQuery", { callback_query_id: cb.id, text: "Отклонено" });
      const next = `${text}\n\nСтатус: отклонено`.replace("#epb ", "#rejected #epb ");
      if (isMedia) {
        await tgSoft("editMessageCaption", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          caption: next,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await tgSoft("editMessageText", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: next,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        });
      }
      return;
    }
    const userId = String(cb.from?.id || "");
    await handleApplyCallback(cb, sessions.get(userId));
    return;
  }

  const msg = update.message;
  if (!msg) return;

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    if (!isOfficialArbiterChat(msg.chat.id)) {
      await rejectForeignChat(msg.chat);
      return;
    }
  }
  if (msg.chat.type === "channel" && bindings.channelId && !sameChat(bindings.channelId, msg.chat.id)) {
    await rejectForeignChat(msg.chat);
    return;
  }

  const cmd = commandName(msg.text);
  const userId = String(msg.from?.id || msg.chat.id);

  if (cmd === "start" || cmd === "app") {
    await replyStart(msg.chat.id);
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
        text: `Заявку подайте в личке: @${BOT_USERNAME}`,
      });
      return;
    }
    if (!msg.from) return;
    await startApply(msg.chat.id, msg.from);
    return;
  }
  if (cmd === "id" || cmd === "bind") {
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      if (!isOfficialArbiterChat(msg.chat.id)) {
        await rejectForeignChat(msg.chat);
        return;
      }
      bindings.arbiterChatId = String(msg.chat.id);
      saveBindings();
      await tgSoft("sendMessage", {
        chat_id: msg.chat.id,
        text: [
          `Чат арбитров подтверждён.`,
          `ID: <code>${msg.chat.id}</code>`,
          "",
          "Заявки будут приходить только сюда.",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
    if (msg.chat.type === "channel") {
      if (bindings.channelId && !isOfficialChannel(msg.chat.id)) {
        await rejectForeignChat(msg.chat);
        return;
      }
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

  if (msg.chat.type !== "private") return;
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
  await tgSoft("setWebhook", {
    url: `${clean}/api/telegram/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: false,
  });
  return { ok: true as const, url: clean };
}

export async function configureFromOrigin(origin: string) {
  const url = origin.replace(/\/$/, "");
  if (!url.startsWith("https://")) return { configured: false as const, reason: "need_https" };
  if (/localhost|127\.0\.0\.1/i.test(url)) return { configured: false as const, reason: "local" };
  const registered = await registerMiniAppUrl(url);
  if (!registered.ok) return { configured: false as const, reason: "grok_gate" };
  return { configured: true as const, url: registered.url };
}

export async function deleteWebhook() {
  await tgSoft("deleteWebhook", { drop_pending_updates: false });
}
