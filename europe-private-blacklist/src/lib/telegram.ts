import type { Application } from "@/lib/types";
import { scammerAccounts } from "@/lib/types";

export const CHANNEL_URL = "https://t.me/+VkDLqrlnIGxjN2Uy";
export const CHANNEL_NAME = "Europe Private Blacklist";

export const KNOWN_TELEGRAM_IDS: Record<string, string> = {
  lopatabuild: "5213159067",
  alex_epb: "847291003",
};

export type ParsedHandle = {
  username: string;
  id: string;
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

  const urlName = trimmed.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})/i);
  const atName = trimmed.match(/@([A-Za-z][A-Za-z0-9_]{3,31})/);
  const bare = trimmed.match(/^@?([A-Za-z][A-Za-z0-9_]{3,31})$/);
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
  const people = accounts.map((a, i) => {
    const username = a.username.replace(/^@/, "");
    const head = [username ? `@${username}` : "", a.telegramId ? `Id: ${a.telegramId}` : ""]
      .filter(Boolean)
      .join(" ");
    const last = i === accounts.length - 1;
    if (last) return `${head} - ${scam}`;
    return `${head} ;`;
  });
  return `${people.filter(Boolean).join("\n")}\n\n${app.story.trim()}\n\nSubscribe: ${CHANNEL_NAME}`;
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

export function bootTelegramWebApp() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready?.();
  tg.expand?.();
  tg.setHeaderColor?.("#080808");
  tg.setBackgroundColor?.("#080808");
  tg.setBottomBarColor?.("#080808");
  tg.MainButton?.hide?.();
  tg.SecondaryButton?.hide?.();
  tg.disableVerticalSwipes?.();
}

export function lockTelegramViewport() {
  const apply = () => {
    const vv = window.visualViewport;
    const height = Math.max(240, Math.round(vv?.height ?? window.innerHeight));
    const top = Math.round(vv?.offsetTop ?? 0);
    const root = document.documentElement;
    root.style.setProperty("--app-h", `${height}px`);
    root.style.setProperty("--app-top", `${top}px`);
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  apply();
  const vv = window.visualViewport;
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("scroll", apply, { passive: true });
  window.Telegram?.WebApp?.onEvent?.("viewportChanged", apply);
  return () => {
    vv?.removeEventListener("resize", apply);
    vv?.removeEventListener("scroll", apply);
    window.removeEventListener("scroll", apply);
    window.Telegram?.WebApp?.offEvent?.("viewportChanged", apply);
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
          };
        };
        ready?: () => void;
        expand?: () => void;
        close?: () => void;
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        setBottomBarColor?: (color: string) => void;
        disableVerticalSwipes?: () => void;
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
