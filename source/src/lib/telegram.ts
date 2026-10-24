import type { Application } from "@/lib/types";
import { scammerAccounts } from "@/lib/types";

export const CHANNEL_URL = "https://t.me/+KkrYz9IKvoBmYTQy";
export const CHANNEL_NAME = "Europe Private Blacklist";

export const KNOWN_TELEGRAM_IDS: Record<string, string> = {
  lopatabuild: "5213159067",
  alex_epb: "847291003",
};

export type ParsedHandle = {
  username: string;
  id: string;
  // "telegram" = the id was confirmed by Telegram itself.
  source?: "telegram" | "parsed" | "unresolved";
  // The server skipped the lookup because of limits: not "not found", just "later".
  busy?: boolean;
};

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").split(/[/?#]/)[0] ?? "";
}

export function parseTelegramInput(input: string): { username: string; id: string } {
  const trimmed = input.trim();
  if (!trimmed) return { username: "", id: "" };

  const tgUser = trimmed.match(/tg:\/\/user\?id=(\d{5,15})/i);
  if (tgUser?.[1]) return { username: "", id: tgUser[1] };

  const openMsg = trimmed.match(/(?:user_id|peer)=(\d{5,15})/i);
  if (openMsg?.[1] && !/t\.me\//i.test(trimmed)) return { username: "", id: openMsg[1] };

  const webTg = trimmed.match(/web\.telegram\.org\/[a-z]+\/#(\d{5,15})/i);
  if (webTg?.[1]) return { username: "", id: webTg[1] };

  if (/^\d{5,15}$/.test(trimmed)) return { username: "", id: trimmed };

  const fromUrl = normalizeUsername(trimmed);
  if (/^\d{5,15}$/.test(fromUrl)) return { username: "", id: fromUrl };

  // Forum/arbitration handles can be short nicknames (e.g. "dvw"), not real
  // Telegram usernames, so allow 3+ chars here.
  const urlName = trimmed.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{2,31})/i);
  const atName = trimmed.match(/@([A-Za-z][A-Za-z0-9_]{2,31})/);
  const bare = trimmed.match(/^@?([A-Za-z][A-Za-z0-9_]{2,31})$/);
  const username = (urlName?.[1] || atName?.[1] || bare?.[1] || "").replace(/^@/, "");

  const labeled = trimmed.match(/\bid[:\s]*(\d{5,15})\b/i);
  let id = labeled?.[1] ?? "";
  if (!id && username) {
    const leftover = trimmed.replace(username, " ");
    const extra = leftover.match(/(?:^|[\s,;|/])(\d{5,15})(?:$|[\s,;|/])/);
    if (extra?.[1]) id = extra[1];
  } else if (!id && !username) {
    const any = trimmed.match(/\b(\d{5,15})\b/);
    if (any?.[1]) id = any[1];
  }

  return { username, id };
}

export function parseDamageAmount(text: string): { amount: string; currency: "USD" | "EUR" | null } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/Ё/g, "Е");
  let currency: "USD" | "EUR" | null = null;
  if (/\bEUR\b|€|ЕВРО/.test(upper)) currency = "EUR";
  else if (/\bUSD\b|\$|БАКС|ДОЛЛАР/.test(upper)) currency = "USD";

  const numeric = raw
    .replace(/[\u00A0\u202F\u2009]/g, " ")
    .replace(/[€$₽]/g, " ")
    .replace(/\b(usd|eur|usdt|rub|евро|бакс\w*|доллар\w*|руб\w*)\b/gi, " ")
    .replace(/[^\d.,\s]/g, " ")
    .trim();
  if (!numeric) return null;

  const s = numeric.replace(/\s+/g, "");
  let normalized = "";
  if (/^\d{1,3}(,\d{3})+$/.test(s)) normalized = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) normalized = s.replace(/\./g, "");
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) normalized = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) normalized = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) normalized = s.replace(",", ".");
  else if (/^\d+\.\d{1,2}$/.test(s)) normalized = s;
  else if (/^\d+$/.test(s)) normalized = s;
  else return null;

  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  const amount = normalized.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  return { amount, currency };
}

export function hashToTelegramId(username: string): string {
  const s = username.trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = 1_000_000_000 + (Math.abs(h) % 4_294_967_295);
  return String(n);
}

export async function resolveTelegramId(input: string): Promise<ParsedHandle | null> {
  const parsed = parseTelegramInput(input);
  if (!parsed.username && !parsed.id) return null;
  if (parsed.id) return { username: parsed.username, id: parsed.id };
  const known = KNOWN_TELEGRAM_IDS[parsed.username.toLowerCase()];
  if (known) return { username: parsed.username, id: known };
  return { username: parsed.username, id: "" };
}

export function formatChannelPost(app: Application): string {
  const accounts = scammerAccounts(app);
  const scam =
    app.damageCurrency === "USD"
      ? `scam ${app.damageAmount}$`
      : `scam ${app.damageAmount} ${app.damageCurrency}`;
  const multi = accounts.length > 1;
  const people = accounts.map((a, i) => {
    const username = a.username.replace(/^@/, "");
    const name = username ? `@${username}` : "";
    const id = a.telegramId ? `Id: ${a.telegramId}` : "";
    const last = i === accounts.length - 1;
    if (multi) {
      const head = [name, id].filter(Boolean).join(" ");
      if (!last) return `${head} ;`;
      return scam ? `${head} - ${scam}` : head;
    }
    if (id && scam) return [name, `${id} - ${scam}`].filter(Boolean).join("\n");
    return [name, id].filter(Boolean).join("\n");
  });
  return `${people.filter(Boolean).join("\n")}\n\n${(app.summary || app.story).trim()}\n\nSubscribe: ${CHANNEL_NAME}`;
}

export function readTelegramWebUser(): {
  firstName: string;
  username: string;
  telegramId: string;
} | null {
  if (typeof window === "undefined") return null;
  const sdk = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (sdk?.id) {
    return {
      telegramId: String(sdk.id),
      username: sdk.username ?? "",
      firstName: sdk.first_name ?? "",
    };
  }
  const cached = window.__EPB_TG_USER;
  if (cached?.id) {
    return {
      telegramId: String(cached.id),
      username: cached.username ?? "",
      firstName: cached.first_name ?? "",
    };
  }
  const hash =
    window.location.hash ||
    (() => {
      try {
        return sessionStorage.getItem("__tg_hash") || "";
      } catch {
        return "";
      }
    })();
  if (!hash.includes("tgWebAppData")) return null;
  try {
    const data = new URLSearchParams(hash.replace(/^#/, "")).get("tgWebAppData");
    if (!data) return null;
    const raw = new URLSearchParams(data).get("user");
    if (!raw) return null;
    const user = JSON.parse(raw) as { id?: number; username?: string; first_name?: string };
    if (!user?.id) return null;
    return {
      telegramId: String(user.id),
      username: user.username ?? "",
      firstName: user.first_name ?? "",
    };
  } catch {
    return null;
  }
}

export async function lookupTelegramHandle(input: string): Promise<ParsedHandle | null> {
  // Never leave the form spinning: a stuck request ends as "try again" after 25 s.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("/api/telegram/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, initData: telegramInitData() }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      const json = (await res.json()) as ParsedHandle;
      if (json?.username || json?.id) return json;
    }
  } catch {
    if (ctrl.signal.aborted) return { ...(await resolveTelegramId(input) || { username: "", id: "" }), busy: true };
  } finally {
    clearTimeout(timer);
  }
  return resolveTelegramId(input);
}

export function telegramInitData(): string {
  if (typeof window === "undefined") return "";
  try {
    const live = window.Telegram?.WebApp?.initData;
    if (live) return live;
  } catch {
    /* ignore */
  }
  try {
    const hash =
      window.location.hash || sessionStorage.getItem("__tg_hash") || "";
    const data = new URLSearchParams(hash.replace(/^#/, "")).get("tgWebAppData");
    return data || "";
  } catch {
    return "";
  }
}

export function isTelegramWebView() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator?.userAgent || "";
  if (/Telegram/i.test(ua)) return true;
  if (window.Telegram?.WebApp?.initData) return true;
  if ((window.location.hash || "").includes("tgWebApp")) return true;
  try {
    return Boolean(sessionStorage.getItem("__tg_hash"));
  } catch {
    return false;
  }
}

export function telegramPlatform(): string {
  try {
    return String(window.Telegram?.WebApp?.platform || "").toLowerCase();
  } catch {
    return "";
  }
}

export function isTelegramDesktop() {
  const p = telegramPlatform();
  if (/(tdesktop|macos|weba|webk|unigram|web)/.test(p)) return true;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows|Macintosh|Linux/i.test(ua) && !/Android|iPhone|iPad|Mobile/i.test(ua);
}

export function isTelegramMobile() {
  const p = telegramPlatform();
  if (/(android|ios|android_x)/.test(p)) return true;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function tgSafe(run: () => void) {
  try {
    run();
  } catch {
    /* WebAppMethodUnsupported on older Telegram clients */
  }
}

export function bootTelegramWebApp() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tgSafe(() => tg.ready?.());
  tgSafe(() => tg.expand?.());
  tgSafe(() => tg.setHeaderColor?.("#080808"));
  tgSafe(() => tg.setBackgroundColor?.("#080808"));
  tgSafe(() => tg.setBottomBarColor?.("#080808"));
  tgSafe(() => tg.MainButton?.hide?.());
  tgSafe(() => tg.SecondaryButton?.hide?.());
  const recent = Boolean(tg.isVersionAtLeast?.("8.0"));
  if (recent && isTelegramMobile()) {
    tgSafe(() => tg.requestFullscreen?.());
    tgSafe(() => tg.disableVerticalSwipes?.());
  }
}

function telegramSafeTop(): number {
  const tg = window.Telegram?.WebApp;
  const safe = Number(tg?.safeAreaInset?.top || 0);
  const content = Number(tg?.contentSafeAreaInset?.top || 0);
  const inTg = Boolean(tg?.initData || /Telegram/i.test(window.navigator?.userAgent || ""));
  if (!inTg) return 0;
  if (isTelegramDesktop()) return Math.min(Math.max(safe + content, 0), 28);
  return Math.max(safe + content, 56);
}

export function lockTelegramViewport() {
  const apply = () => {
    const root = document.documentElement;
    root.style.setProperty("--app-h", "100dvh");
    root.style.setProperty("--app-top", "0px");
    root.style.setProperty("--tg-safe-top", `${telegramSafeTop()}px`);
  };
  apply();
  const tg = window.Telegram?.WebApp;
  tgSafe(() => tg?.onEvent?.("safeAreaChanged", apply));
  tgSafe(() => tg?.onEvent?.("contentSafeAreaChanged", apply));
  return () => {
    tgSafe(() => tg?.offEvent?.("safeAreaChanged", apply));
    tgSafe(() => tg?.offEvent?.("contentSafeAreaChanged", apply));
  };
}

export function waitForTelegramUser(ms = 2500): Promise<ReturnType<typeof readTelegramWebUser>> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      bootTelegramWebApp();
      const user = readTelegramWebUser();
      if (user) {
        resolve(user);
        return;
      }
      if (Date.now() - start >= ms) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 80);
    };
    tick();
  });
}

export function bindTelegramMainButton(label: string, onClick: () => void) {
  const btn = window.Telegram?.WebApp?.MainButton;
  if (!btn) return () => {};
  btn.hide?.();
  void label;
  void onClick;
  return () => {
    btn.hide?.();
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        initDataUnsafe?: {
          user?: {
            id: number;
            username?: string;
            first_name?: string;
            last_name?: string;
            language_code?: string;
          };
        };
        platform?: string;
        isFullscreen?: boolean;
        ready?: () => void;
        expand?: () => void;
        requestFullscreen?: () => void;
        isVersionAtLeast?: (version: string) => boolean;
        viewportHeight?: number;
        viewportStableHeight?: number;
        close?: () => void;
        openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
        openTelegramLink?: (url: string) => void;
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        setBottomBarColor?: (color: string) => void;
        disableVerticalSwipes?: () => void;
        HapticFeedback?: {
          impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
          notificationOccurred?: (type: "error" | "success" | "warning") => void;
          selectionChanged?: () => void;
        };
        safeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
        contentSafeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
        onEvent?: (event: string, cb: () => void) => void;
        offEvent?: (event: string, cb: () => void) => void;
        MainButton?: {
          setText?: (text: string) => void;
          show?: () => void;
          hide?: () => void;
          onClick?: (cb: () => void) => void;
          offClick?: (cb: () => void) => void;
        };
        SecondaryButton?: {
          hide?: () => void;
        };
      };
    };
    __EPB_TG_USER?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  }
}

// Opens a link from inside Telegram: t.me / tg:// links go through the native
// handler, everything else opens in the in-app browser, with a plain-tab fallback.
export function openExternal(url: string) {
  // Only web and Telegram links; never javascript:, data: or other schemes.
  if (!url || !/^(https?:\/\/|tg:\/\/)/i.test(url.trim())) return;
  try {
    const tg = window.Telegram?.WebApp;
    const isTg = /^tg:\/\//i.test(url) || /(?:t\.me|telegram\.me)\//i.test(url);
    if (isTg && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      return;
    }
    if (tg?.openLink) {
      tg.openLink(url);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    /* ignore */
  }
}

// Phone vibration: Telegram's haptics (iPhone and Android), else the browser's vibrate().
// Telegram's notification pattern (a distinct double buzz), with a plain
// vibration pattern as the fallback outside Telegram.
export function hapticNotify(type: "success" | "warning" | "error") {
  try {
    const hf = window.Telegram?.WebApp?.HapticFeedback;
    if (hf?.notificationOccurred && window.Telegram?.WebApp?.isVersionAtLeast?.("6.1")) {
      hf.notificationOccurred(type);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    navigator.vibrate?.(type === "error" ? [30, 60, 30] : [18, 50, 18]);
  } catch {
    /* no vibration */
  }
}

export function haptic(style: "light" | "medium" | "heavy" | "rigid" | "soft") {
  try {
    const hf = window.Telegram?.WebApp?.HapticFeedback;
    if (hf?.impactOccurred && window.Telegram?.WebApp?.isVersionAtLeast?.("6.1")) {
      hf.impactOccurred(style);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const ms = { light: 10, soft: 14, medium: 20, rigid: 24, heavy: 32 }[style];
    navigator.vibrate?.(ms);
  } catch {
    /* no vibration */
  }
}
