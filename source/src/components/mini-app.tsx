import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Lock, X, LoaderCircle, RefreshCw, Scale, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { CARD_LOOKS, MemberCard, type CardBackInfo } from "@/components/member-card";
import { TIERS, nextTier, tierFor, type Metal } from "@/lib/tiers";
import { ApplyForm } from "@/components/apply-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  bootTelegramWebApp,
  CHANNEL_URL,
  lockTelegramViewport,
  haptic,
  hapticNotify,
  openExternal,
  readTelegramWebUser,
  telegramInitData,
  telegramPlatform,
  waitForTelegramUser,
} from "@/lib/telegram";
import { checkCounterparty, getCheckSources, getAccess, getCaptcha, solveCaptcha, getBanners, getBaseDetails, getBaseStats, getBlacklistEntry, getFeatures, getLatestParsed, getMyCard, getMyComplaints, getPostDetail, getSponsors, getSponsorStats, saveUserLocale } from "@/lib/telegram-bot.functions";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";
import type { ComplaintHistoryItem } from "@/lib/types";
import type { MemberCardBack } from "@/lib/telegram-bot.server";
import { cn } from "@/lib/utils";
import { hasSavedLocale, t, type Locale, type Msg } from "@/lib/i18n";

export type MiniPage = "home" | "apply" | "history" | "done" | "owners" | "check" | "sponsors" | "base" | "tiers";

export function MiniApp({
  page,
  onPage,
  onClose,
  onReview,
  embedded = false,
}: {
  page: MiniPage;
  onPage: (page: MiniPage) => void;
  onClose?: () => void;
  onReview?: () => void;
  embedded?: boolean;
}) {
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [langPicked, setLangPicked] = useState<boolean | null>(null);
  const identity = useBlacklistStore((s) => s.identity);
  const setIdentity = useBlacklistStore((s) => s.setIdentity);
  const locale = useBlacklistStore((s) => s.locale);

  const openComplaint = useCallback(() => onPage("apply"), [onPage]);
  const openHistory = useCallback(() => onPage("history"), [onPage]);
  const openOwners = useCallback(() => onPage("owners"), [onPage]);
  const openCheck = useCallback(() => onPage("check"), [onPage]);
  const openSponsors = useCallback(() => onPage("sponsors"), [onPage]);
  const [checkOn, setCheckOn] = useState(false);
  const [banned, setBanned] = useState(false);
  useEffect(() => {
    void getFeatures()
      .then((f) => setCheckOn(Boolean(f?.check)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    rehydrateBlacklistStore();
    bootTelegramWebApp();
    if (hasSavedLocale()) {
      const saved = window.localStorage.getItem("epb-locale");
      if (saved === "ru" || saved === "en") useBlacklistStore.getState().setLocale(saved);
      setLangPicked(true);
    } else {
      setLangPicked(false);
    }
    const unlock = lockTelegramViewport();
    let cancelled = false;
    void (async () => {
      const user = (await waitForTelegramUser(2500)) || readTelegramWebUser();
      if (cancelled) return;
      if (user) {
        try {
          setIdentity(user);
        } catch {
          /* ignore */
        }
      } else {
        // Telegram's script can arrive late on a slow connection: keep waiting
        // in the background so the buttons unlock as soon as it does.
        void waitForTelegramUser(30_000).then((late) => {
          if (late && !cancelled) {
            try {
              setIdentity(late);
            } catch {
              /* ignore */
            }
          }
        });
      }
      // The app opens at once; the ban check runs in the background (a slow
      // server must not keep everyone on the loading screen). A banned user gets
      // a "closed" screen as soon as the answer comes; the server refuses banned
      // users' requests either way.
      setReady(true);
      try {
        const init = telegramInitData();
        if (init) {
          void getAccess({ data: { initData: init } })
            .then((acc) => {
              if (!cancelled && acc?.banned) setBanned(true);
            })
            .catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
      unlock();
    };
  }, [setIdentity]);

  const showLang = ready && !banned && langPicked === false;
  const showApp = ready && !banned && langPicked === true;


  return (
    <div
      className={cn("epb-app-bg relative isolate flex flex-col overflow-hidden overscroll-none bg-bg text-fg", !embedded && "z-50")}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: "var(--app-top, 0px)",
        height: "var(--app-h, 100dvh)",
        maxHeight: "var(--app-h, 100dvh)",
        paddingTop: "var(--tg-safe-top, 0px)",
      }}
    >
      {/* animated engraving behind every screen */}
      <div className="epb-bg" aria-hidden>
        <i className="epb-bg-a" />
        <i className="epb-bg-b" />
      </div>
      {showApp && !["home", "sponsors", "check", "apply", "base", "tiers"].includes(page) ? (
        <button
          type="button"
          className="absolute left-2 z-10 flex size-11 items-center justify-center rounded-xl text-fg hover:bg-surface"
          style={{ top: "calc(var(--tg-safe-top, 0px) + 4px)" }}
          onClick={() => onPage("home")}
          aria-label={t(locale, "back")}
        >
          <ChevronLeft className="size-5" />
        </button>
      ) : null}

      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", showApp && !["home", "sponsors", "check", "apply", "base", "tiers"].includes(page) && "pt-10")}>
        {!showApp && !showLang ? <AccountLoading locale={locale} /> : null}
        {ready && banned ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <EuStarsLogo size={112} title="Europe Private Blacklist" emblem />
            <p className="mt-6 font-display text-xl font-bold">{t(locale, "bannedTitle")}</p>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted">{t(locale, "bannedText")}</p>
          </div>
        ) : null}
        {showLang ? <LanguageGate onPicked={() => setLangPicked(true)} /> : null}
        {showApp && page === "home" ? (
          <Home identity={identity} onComplaint={openComplaint} onHistory={openHistory} onOwners={openOwners} onCheck={openCheck} onSponsors={openSponsors} onBase={() => onPage("base")} onTiers={() => onPage("tiers")} checkOn={checkOn} />
        ) : null}
        {showApp && page === "apply" ? (
          <ApplyForm
            onBack={() => onPage("home")}
            onSubmitted={(msg) => {
              setNotice(msg ?? "");
              onPage("done");
            }}
          />
        ) : null}
        {showApp && page === "history" ? <History telegramId={identity.telegramId} /> : null}
        {showApp && page === "check" && checkOn ? <CheckCounterparty onBack={() => onPage("home")} /> : null}
        {showApp && page === "owners" ? <OwnersGuide /> : null}
        {showApp && page === "sponsors" ? <SponsorsPage onBack={() => onPage("home")} /> : null}
        {showApp && page === "base" ? <BasePage onBack={() => onPage("home")} /> : null}
        {showApp && page === "tiers" ? (
          <TiersPage
            onBack={() => onPage("home")}
            onComplaint={openComplaint}
            holder={identity.username || identity.firstName || "EPB Member"}
            uid={identity.telegramId}
          />
        ) : null}
        {showApp && page === "done" ? (
          <Done
            onPage={onPage}
            onClose={onClose}
            onReview={onReview}
            notice={notice}
          />
        ) : null}
      </div>
    </div>
  );
}

function persistLangToBot(locale: Locale) {
  const initData = telegramInitData();
  if (!initData) return;
  void saveUserLocale({ data: { initData, locale } }).catch(() => {});
}

function LangSwitch() {
  const locale = useBlacklistStore((s) => s.locale);
  const setLocale = useBlacklistStore((s) => s.setLocale);
  return (
    <div className="flex items-center justify-center gap-1 rounded-full bg-surface p-1 shadow-[0_0_0_1px_rgba(243,239,228,0.10)]">
      {(["ru", "en"] as Locale[]).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => {
            setLocale(code);
            persistLangToBot(code);
          }}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-bold",
            locale === code ? "bg-gold text-gold-fg" : "text-muted hover:text-fg",
          )}
        >
          {code === "ru" ? "Русский" : "English"}
        </button>
      ))}
    </div>
  );
}

function LanguageGate({ onPicked }: { onPicked: () => void }) {
  const setLocale = useBlacklistStore((s) => s.setLocale);
  function pick(code: Locale) {
    setLocale(code);
    persistLangToBot(code);
    onPicked();
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
      <EuStarsLogo size={128} title="Europe Private Blacklist" spin emblem />
      <h1 className="epb-title-heavy mt-7 font-display text-3xl font-extrabold tracking-tight uppercase">
          <span className="block text-fg">Europe Private</span>
          <span className="epb-gold-text block">Blacklist</span>
        </h1>
      <p className="mt-5 text-sm text-muted">Выберите язык / Choose language</p>
      <div className="mt-6 flex w-full max-w-md flex-col gap-3">
        <Button size="lg" className="w-full rounded-xl" onClick={() => pick("ru")}>
          Русский
        </Button>
        <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={() => pick("en")}>
          English
        </Button>
      </div>
    </div>
  );
}

// Opening splash: the medallion fills the screen, then the overlay zooms and
// fades to reveal the app. Shown once per app open, over the loading app.
function AccountLoading({ locale }: { locale: Locale }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
      <EuStarsLogo size={120} title="Europe Private Blacklist" spin emblem />
      <p className="mt-6 font-display text-lg font-bold">{t(locale, "loadingTitle")}</p>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted">{t(locale, "loadingText")}</p>
    </div>
  );
}

type BannerItem = { id: string; type: "image" | "video"; link: string; src: string; width?: number; height?: number };

// Banners and the base size are remembered (memory + localStorage) so the home
// screen draws them at once on every return and on the next app start; fresh
// values are fetched in the background, starting as soon as the app loads.
const BANNERS_KEY = "epb-banners";
const BASE_KEY = "epb-base";
function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
let bannersMem: BannerItem[] | null = null;
let baseMem: BaseStats | null = null;
let bannersReq: Promise<BannerItem[]> | null = null;
let baseReq: Promise<BaseStats | null> | null = null;
function cachedBanners(): BannerItem[] | null {
  return (bannersMem ??= readCache<BannerItem[]>(BANNERS_KEY));
}
function cachedBase(): BaseStats | null {
  return (baseMem ??= readCache<BaseStats>(BASE_KEY));
}
function fetchBanners(): Promise<BannerItem[]> {
  bannersReq ??= getBanners()
    .then((list) => {
      const value = Array.isArray(list) ? (list as BannerItem[]) : [];
      bannersMem = value;
      writeCache(BANNERS_KEY, value);
      return value;
    })
    .catch(() => cachedBanners() || [])
    .finally(() => setTimeout(() => (bannersReq = null), 30_000));
  return bannersReq;
}
function fetchBase(): Promise<BaseStats | null> {
  baseReq ??= getBaseStats()
    .then((r) => {
      const value = r && typeof r.accounts === "number" ? (r as BaseStats) : null;
      baseMem = value;
      writeCache(BASE_KEY, value);
      return value;
    })
    .catch(() => cachedBase())
    .finally(() => setTimeout(() => (baseReq = null), 30_000));
  return baseReq;
}
// How many of the user's complaints became blacklists (picks the member card).
// Cached per Telegram account, so a second account on the same phone never
// shows the first one's card.
// Also what the back of the card says (the same as on the bot's /im card).
const CARD_KEY = "epb-card-published";
type CardMem = { id: string; n: number; back?: MemberCardBack };
let cardMem: CardMem | null = null;
let cardReq: Promise<CardMem | null> | null = null;
function cachedCard(uid: string): CardMem | null {
  cardMem ??= readCache<CardMem>(CARD_KEY);
  return cardMem && cardMem.id === uid && typeof cardMem.n === "number" ? cardMem : null;
}
function cachedPublished(uid: string): number | null {
  return cachedCard(uid)?.n ?? null;
}
function fetchCard(uid: string): Promise<CardMem | null> {
  const initData = telegramInitData();
  if (!initData || !uid) return Promise.resolve(cachedCard(uid));
  cardReq ??= getMyCard({ data: { initData } })
    .then((r) => {
      if (!r?.ok) return cachedCard(uid);
      cardMem = { id: uid, n: r.published, back: r.back };
      writeCache(CARD_KEY, cardMem);
      return cardMem;
    })
    .catch(() => cachedCard(uid))
    .finally(() => setTimeout(() => (cardReq = null), 30_000));
  return cardReq;
}
// The details on the back of the card, worded like the bot's /im card.
function cardBackInfo(locale: Locale, b: MemberCardBack, tierName: string): CardBackInfo {
  const en = locale === "en";
  const reg = !b.reg
    ? "—"
    : b.reg.later
      ? en
        ? `${b.reg.year} OR LATER`
        : `${b.reg.year} ИЛИ ПОЗЖЕ`
      : `${(en ? ["EARLY", "MID", "LATE"] : ["НАЧАЛО", "СЕРЕДИНА", "КОНЕЦ"])[b.reg.part]} ${b.reg.year}`;
  const n = b.listed;
  const ruSources = n % 10 === 1 && n % 100 !== 11 ? "ИСТОЧНИК" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "ИСТОЧНИКА" : "ИСТОЧНИКОВ";
  const listed = !n ? (en ? "NO" : "НЕТ") : en ? `YES · ${n} SOURCE${n === 1 ? "" : "S"}` : `ДА · ${n} ${ruSources}`;
  const holder = b.name || (b.username ? `@${b.username}` : "EPB Member");
  return {
    signature: holder.slice(0, 40),
    fields: [
      [en ? "NAME" : "НИК", b.name || "—"],
      ["USERNAME", b.username ? `@${b.username}` : "—"],
      ["ID", b.id],
      [en ? "REGISTERED" : "РЕГИСТРАЦИЯ", reg],
      [en ? "IN THE BLACKLIST BASE" : "В БАЗЕ БЛЕКЛИСТА", listed],
      [en ? "CARD" : "КАРТА", en ? `${tierName} · ACCEPTED ${b.accepted} OF ${b.filed}` : `${tierName} · ПРИНЯТО ${b.accepted} ИЗ ${b.filed}`],
    ],
  };
}

// `settled`: the server answered (or failed), so the card can show even
// without a number (then it is the starting one).
function usePublished(uid: string): { value: number | null; settled: boolean; back: MemberCardBack | null } {
  const [value, setValue] = useState<number | null>(() => cachedPublished(uid));
  const [back, setBack] = useState<MemberCardBack | null>(() => cachedCard(uid)?.back ?? null);
  const [settled, setSettled] = useState(() => cachedPublished(uid) != null);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    setValue(cachedPublished(uid));
    setBack(cachedCard(uid)?.back ?? null);
    void fetchCard(uid).then((v) => {
      if (!alive) return;
      if (v) {
        setValue(v.n);
        setBack(v.back ?? null);
      }
      setSettled(true);
    });
    // never keep the card hidden for long on a slow connection
    const timer = setTimeout(() => alive && setSettled(true), 2500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [uid]);
  return { value, settled, back };
}

if (typeof window !== "undefined") {
  // start both requests while the app is still booting
  queueMicrotask(() => {
    void fetchBanners();
    void fetchBase();
  });
}

// Promo banners at the very top of the app. A horizontal, swipeable strip;
// videos and GIFs play muted and looped; a tap opens the banner's link.
function Banners({ onLoaded }: { onLoaded?: (count: number) => void }) {
  const [items, setItems] = useState<BannerItem[]>(() => cachedBanners() || []);
  const [active, setActive] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchBanners().then((value) => {
      if (!alive) return;
      setItems(value);
      onLoaded?.(value.length);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length) return null;

  const open = (link: string) => {
    if (!link) return;
    haptic("light");
    openExternal(link);
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setActive(Math.round(el.scrollLeft / (el.clientWidth || 1)));
  };

  return (
    <div className="mx-auto w-full max-w-md pt-3">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory items-start gap-3 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((b) => {
          // Reserve the right box from the stored media size, so there is no
          // gray-rectangle jump before the media loads. Fall back to natural
          // sizing for old banners saved without dimensions.
          const ratio = b.width && b.height ? `${b.width} / ${b.height}` : undefined;
          const mediaClass = ratio ? "block size-full object-cover" : "block h-auto max-h-[80vh] w-full object-contain";
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => open(b.link)}
              aria-label="banner"
              style={ratio ? { aspectRatio: ratio, maxHeight: "80vh" } : undefined}
              className={cn(
                "relative block w-full shrink-0 snap-center overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_rgba(243,239,228,0.08)]",
                b.link ? "cursor-pointer" : "cursor-default",
              )}
            >
              {b.type === "video" ? (
                <video src={b.src} autoPlay muted loop playsInline preload="metadata" className={mediaClass} />
              ) : (
                <img src={b.src} alt="" className={mediaClass} loading="lazy" />
              )}
            </button>
          );
        })}
      </div>
      {items.length > 1 ? (
        <div className="mt-2 flex justify-center gap-1.5">
          {items.map((b, i) => (
            <span
              key={b.id}
              className={cn("h-1.5 rounded-full transition-all", i === active ? "w-4 bg-gold" : "w-1.5 bg-muted/40")}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type BaseStats = { accounts: number; sources: number; updatedAt: number };

// "Blacklist base: N accounts from M sources", with when the copies were last
// updated. Refreshed every minute while the home screen is open.
function BaseCard({ onOpen }: { onOpen?: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [stats, setStats] = useState<BaseStats | null>(() => cachedBase());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchBase().then((value) => {
        if (alive) setStats(value);
      });
    load();
    const id = setInterval(() => {
      setNow(Date.now());
      load();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!stats) return null;
  const n = stats.sources;
  const src = t(locale, n % 10 === 1 && n % 100 !== 11 ? "baseSrcOne" : "baseSrcMany");
  const mins = Math.max(0, Math.floor((now - stats.updatedAt) / 60_000));
  const updated =
    mins < 1
      ? t(locale, "baseUpdatedNow")
      : mins < 60
        ? t(locale, "baseUpdatedMin", { n: mins })
        : t(locale, "baseUpdatedHour", { n: Math.floor(mins / 60) });

  return (
    <div className="mx-auto w-full max-w-md pt-3">
      <button
        type="button"
        aria-label={t(locale, "basePageTap")}
        onClick={() => {
          haptic("light");
          onOpen?.();
        }}
        className="epb-base-card relative block w-full overflow-hidden rounded-2xl px-4 py-2.5 text-left transition-transform active:scale-[0.99]"
      >
        <img
          src="/brand/emblem-v2.webp"
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute -right-4 top-1/2 h-[180%] w-auto -translate-y-1/2 select-none opacity-[0.3]"
        />
        <div className="relative flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold tracking-[0.14em] text-muted uppercase">{t(locale, "baseTitle")}</div>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-gold">
            <span className="size-1.5 rounded-full bg-gold shadow-[0_0_6px_rgba(242,190,85,0.9)]" />
            {updated}
          </div>
        </div>
        <div className="relative mt-0.5 flex items-baseline gap-2">
          <span className="font-display text-gold text-2xl leading-tight font-extrabold tracking-tight">
            {stats.accounts.toLocaleString(locale === "en" ? "en-US" : "ru-RU")}
          </span>
          <span className="truncate text-xs text-muted">{t(locale, "baseSub", { n, src })}</span>
        </div>
      </button>
    </div>
  );
}

function Home({
  identity,
  onComplaint,
  onHistory,
  onOwners,
  onCheck,
  onSponsors,
  onBase,
  onTiers,
  checkOn,
}: {
  identity: { username: string; firstName?: string; telegramId: string };
  onComplaint: () => void;
  onHistory: () => void;
  onOwners: () => void;
  onCheck: () => void;
  onSponsors: () => void;
  onBase?: () => void;
  onTiers?: () => void;
  checkOn: boolean;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const handle = identity.username
    ? `@${identity.username}`
    : identity.firstName || (identity.telegramId ? `ID ${identity.telegramId}` : "");
  const canUse = Boolean(identity.telegramId);
  // known from the last visit, so the base card doesn't wait for the banners request
  const [noBanners, setNoBanners] = useState(() => cachedBanners()?.length === 0);
  const [base, setBase] = useState<BaseStats | null>(() => cachedBase());
  const { value: published, settled: cardSettled, back: backData } = usePublished(identity.telegramId);
  const tier = tierFor(published ?? 0);
  const [flipped, setFlipped] = useState(false);
  const back = backData ? cardBackInfo(locale, backData, tier.name) : null;
  // until the level is known the card stays invisible (no flash of the wrong metal)
  const cardShown = published != null || cardSettled;
  const holder = identity.username || identity.firstName || "EPB Member";
  useEffect(() => {
    let alive = true;
    void fetchBase().then((value) => {
      if (alive && value) setBase(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain px-4 [touch-action:pan-y]">
      <Banners onLoaded={(count) => setNoBanners(count === 0)} />
      <div className="mx-auto w-full max-w-md">
        <SponsorsTicker onOpen={onSponsors} />
      </div>
      {/* No banners: the blacklist base card shows under the ticker. */}
      {noBanners ? <BaseCard onOpen={onBase} /> : null}
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <LangSwitch />
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onTiers?.();
          }}
          className={cn(
            "mt-5 inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold text-muted transition-[color,opacity] duration-300 hover:text-fg",
            !cardShown && "opacity-0",
          )}
        >
          <span>
            {t(locale, "tierYou")}
            <span className={cn("font-bold", TIER_TEXT[tier.metal])}>{tier.name}</span>
            {t(locale, "tierYouTail")}
          </span>
          <ChevronRight className="size-4" />
        </button>
        <div className="mt-3 w-full">
          {cardShown ? (
            <div className="epb-fade-in">
              <MemberCard
                metal={tier.metal}
                holder={holder}
                count={base?.accounts ?? null}
                ribbon={t(locale, "cardRibbon")}
                locale={locale}
                // a tap on the reverse turns it back
                onOpen={flipped ? () => setFlipped(false) : onTiers}
                back={back}
                flipped={flipped}
                width="min(290px, 76vw)"
              />
              {back ? (
                <button
                  type="button"
                  onClick={() => setFlipped((v) => !v)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold text-muted transition-colors hover:text-fg"
                >
                  <RefreshCw className="size-3.5" />
                  {t(locale, flipped ? "cardFront" : "cardFlip")}
                </button>
              ) : null}
            </div>
          ) : (
            // same size as the card, so nothing jumps when it appears
            <div className="mx-auto" style={{ width: "min(290px, 76vw)", aspectRatio: "1200 / 756" }} />
          )}
        </div>
        {handle ? null : <p className="mt-6 text-xs text-subtle">{t(locale, "openFromBot")}</p>}
        <div className="mt-8 flex w-full max-w-md flex-col gap-3">
          {/* solid gold, no gradient */}
          <Button size="lg" className="w-full rounded-xl bg-none" onClick={onComplaint} disabled={!canUse}>
            {t(locale, "fileComplaint")}
          </Button>
          {checkOn ? (
            <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={onCheck} disabled={!canUse}>
              {t(locale, "checkBtn")}
            </Button>
          ) : null}
        </div>
        <a
          href={CHANNEL_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-5 text-sm font-medium text-gold underline underline-offset-4"
        >
          {t(locale, "subscribe")}
        </a>
      </div>
      <button
        type="button"
        onClick={onOwners}
        className="mx-auto mb-5 mt-4 text-sm font-medium text-muted underline underline-offset-4"
      >
        {t(locale, "ownersLink")}
      </button>
    </div>
  );
}

type LatestItem = { id: string; account: string; source: string; date: number; amount?: string; channelId?: string; messageId?: number; link?: string };
const LATEST_CACHE_KEY = "epb-latest";

function useLatestParsed(enabled: boolean): LatestItem[] {
  const [items, setItems] = useState<LatestItem[]>(() => {
    try {
      const raw = sessionStorage.getItem(LATEST_CACHE_KEY);
      return raw ? (JSON.parse(raw) as LatestItem[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getLatestParsed({ data: { initData: telegramInitData() } })
      .then((r) => {
        if (!alive || !r.ok) return;
        const list = r.items as LatestItem[];
        setItems(list);
        try {
          sessionStorage.setItem(LATEST_CACHE_KEY, JSON.stringify(list));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? items : [];
}

function agoText(locale: Locale, ms: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (mins < 1) return t(locale, "agoNow");
  if (mins < 60) return t(locale, "agoMin", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(locale, "agoHour", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t(locale, "agoDay", { n: days });
  return new Date(ms).toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// One row of "latest blacklists" on the check page; a tap opens the post.
function LatestRow({ item: e, index, onClick }: { item: LatestItem; index: number; onClick: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  return (
    <button
      type="button"
      onClick={() => {
        haptic("light");
        onClick();
      }}
      className="epb-latest-row flex w-full items-center gap-3 rounded-2xl bg-surface/70 p-3 text-left shadow-[0_0_0_1px_rgba(243,239,228,0.06)] hover:bg-surface"
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/10 text-sm font-extrabold text-danger uppercase">
        {e.account.replace(/^@|^ID\s*/i, "")[0] || "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{e.account}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {e.source} · {agoText(locale, e.date)}
        </span>
      </span>
      <ChevronLeft className="size-4 shrink-0 rotate-180 text-subtle" />
    </button>
  );
}

const SPONSORS_CACHE_KEY = "epb-sponsors";

// Logos of the partner blacklists/forums, shown in the top ticker and on the
// sponsors page. Transparent PNGs in /public/partners.
// `r` is width/height, so every logo gets its final size before it loads and
// the scrolling track never changes width mid-animation (which made it jump).
// r = width/height of the logo file; s = optional height scale (the wide WWH
// wordmark reads bigger than the round logos, so it's drawn a bit shorter).
// A logo can also be plain lettering (text): drawn in the app's font, no file.
const PARTNER_LOGOS: { src: string; alt: string; r: number; s?: number; text?: "1tc" }[] = [
  { src: "/partners/wwh.png", alt: "WWH Club", r: 740 / 128, s: 0.62 },
  { src: "/partners/animal-planet.png", alt: "Animal Planet Blacklist", r: 1 },
  { src: "/partners/kidalam.png", alt: "KidaLam NeT", r: 1 },
  { src: "/partners/z-black.png", alt: "Z-BLACK", r: 122 / 128 },
  { src: "text:1tc", alt: "1TC", r: 1.7, s: 0.82, text: "1tc" },
  { src: "/partners/pi.png", alt: "π", r: 107 / 128 },
  { src: "/partners/ws-blacklist.png", alt: "WS Blacklist", r: 1 },
  { src: "/partners/cookie.png", alt: "Cookie Blacklist", r: 1 },
  { src: "/partners/illidan.png", alt: "Illidan Blacklist Community", r: 129 / 128 },
  { src: "/partners/imperial.png", alt: "Imperial Black List", r: 89 / 128 },
  { src: "/partners/shopping-avenue.png", alt: "Shopping Avenue скам-лист", r: 239 / 128, s: 0.95 },
  { src: "/partners/chernyi-spisok.png", alt: "Чёрный список — арбитраж трафика", r: 210 / 128, s: 0.9 },
  { src: "/partners/btc-detective.png", alt: "Crypto detective blacklist", r: 119 / 128 },
  { src: "/partners/skam-desk.png", alt: "SKAM DESK", r: 115 / 128 },
  { src: "/partners/kolbasa.png", alt: "Колбаса", r: 209 / 128, s: 0.85 },
];

function PartnerLogos({ size, gap = false }: { size: number; gap?: boolean }) {
  return (
    <>
      {PARTNER_LOGOS.map((l) => {
        const h = Math.round(size * (l.s ?? 1));
        const w = Math.round(h * l.r);
        if (l.text === "1tc") {
          return (
            <span key={l.src} className="inline-flex shrink-0 items-center" style={{ height: size }}>
              <span role="img" aria-label={l.alt} className="epb-logo-1tc" style={{ width: w, height: h, fontSize: Math.round(h * 0.92) }}>
                <span className="epb-logo-1tc-one">1</span>TC
              </span>
              {gap ? <span className="w-5 shrink-0" /> : <span className="mx-3 text-gold/40">·</span>}
            </span>
          );
        }
        return (
          <span key={l.src} className="inline-flex shrink-0 items-center" style={{ height: size }}>
            <img
              src={l.src}
              alt={l.alt}
              draggable={false}
              width={w}
              height={h}
              loading="eager"
              decoding="async"
              style={{ width: w, height: h }}
              className="max-w-none shrink-0 select-none"
            />
            {gap ? <span className="w-5 shrink-0" /> : <span className="mx-3 text-gold/40">·</span>}
          </span>
        );
      })}
    </>
  );
}

// What the search is doing, one step at a time under the loader (matches what the
// server does for this kind of input: @username, numeric ID or forum nickname).
function SearchSteps({ input }: { input: string }) {
  const locale = useBlacklistStore((s) => s.locale);
  const q = input.trim();
  const isId = /^\d{5,}$/.test(q.replace(/^id\s*/i, ""));
  const isHandle = !isId && (/^@|t\.me\//i.test(q) || /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(q));
  const keys: Msg[] = isId
    ? ["stepById", "stepIdNames", "stepPrevNames", "stepEpb", "stepChannels", "stepExternal", "stepCard"]
    : isHandle
      ? ["stepResolve", "stepGetId", "stepById", "stepPrevNames", "stepEpb", "stepChannels", "stepExternal", "stepCard"]
      : ["stepNick", "stepForums", "stepChannels", "stepExternal"];
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    const id = window.setInterval(() => setI((v) => Math.min(v + 1, keys.length - 1)), 1100);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <div className="h-5 overflow-hidden" aria-live="polite">
      <p key={i} className="epb-step-in text-sm font-semibold text-muted">
        {t(locale, keys[i]!)}
      </p>
    </div>
  );
}

// Gold animated frog (animated WebP with alpha) used as the loader.
const FROG_ANIM = "/brand/sending-frog.webp";

// Scrolling strip of partner blacklist/forum logos (sponsors and check pages).
function PartnerMarquee() {
  return (
    <div
      className="relative overflow-hidden rounded-xl bg-surface/60 py-1.5 shadow-[0_0_0_1px_rgba(240,196,48,0.14)]"
      style={{ "--epb-marquee-dur": "11s" } as CSSProperties}
    >
      <div className="epb-marquee-track">
        <PartnerLogos size={30} gap />
        <PartnerLogos size={30} gap />
      </div>
      <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg to-transparent" />
    </div>
  );
}

// Gold-gradient text that leaves emoji in their own colours (a background-clip
// gradient would otherwise paint emoji glyphs gold too).
function GoldText({ text }: { text: string }) {
  const parts = text.split(
    /(\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u,
  );
  return (
    <span>
      {parts.map((p, i) =>
        !p ? null : /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(p) ? (
          <span key={i}>{p}</span>
        ) : (
          <span key={i} className="epb-gold-text">
            {p}
          </span>
        ),
      )}
    </span>
  );
}

// Yellow running line at the bottom of the home screen: the broadcast sponsors.
// Seeded from a sessionStorage cache so it shows instantly on open (the server
// fetch resolves the chat titles/avatars, which takes a couple of seconds).
function SponsorsTicker({ onOpen }: { onOpen?: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [items, setItems] = useState<SponsorItem[]>(() => {
    try {
      const raw = sessionStorage.getItem(SPONSORS_CACHE_KEY);
      return raw ? (JSON.parse(raw) as SponsorItem[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    void getSponsors()
      .then((s) => {
        const list = Array.isArray(s) ? s : [];
        setItems(list);
        try {
          sessionStorage.setItem(SPONSORS_CACHE_KEY, JSON.stringify(list));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);
  if (!items.length) return null;

  const Seq = () => (
    <>
      <span className="inline-flex items-center">
        <span className="epb-gold-text opacity-80">{t(locale, "sponsorsTitle")}</span>
        <span className="mx-3 text-gold/40">·</span>
      </span>
      {items.map((s) => (
        <span key={s.id} className="inline-flex items-center">
          <GoldText text={s.title} />
          <span className="mx-3 text-gold/40">/</span>
        </span>
      ))}
    </>
  );

  return (
    <button
      type="button"
      onClick={() => {
        if (onOpen) {
          haptic("light");
          onOpen();
        }
      }}
      aria-label="project sponsors"
      className="group relative mt-4 flex w-full items-center overflow-hidden rounded-xl bg-surface/60 py-2 shadow-[0_0_0_1px_rgba(240,196,48,0.14)]"
      style={{ "--epb-marquee-dur": `${Math.max(9, items.length * 2.5)}s` } as CSSProperties}
    >
      <div key={items.length} className="epb-marquee-track text-sm font-semibold tracking-tight text-gold">
        <Seq />
        <Seq />
      </div>
      <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg to-transparent" />
    </button>
  );
}

type SponsorItem = { id: string; title: string; link: string; avatar: string };

// "Connected chats: N · audience ~X" line. Cached briefly in sessionStorage so
// it shows instantly on re-open.
function SponsorStats({ className }: { className?: string }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [stats, setStats] = useState<{ chats: number; audience: number } | null>(() => {
    try {
      const raw = sessionStorage.getItem("epb-stats");
      return raw ? (JSON.parse(raw) as { chats: number; audience: number }) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    void getSponsorStats()
      .then((s) => {
        setStats(s);
        try {
          sessionStorage.setItem("epb-stats", JSON.stringify(s));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);
  if (!stats || stats.chats <= 0) return null;
  const fmt = stats.audience.toLocaleString(locale === "en" ? "en-US" : "ru-RU");
  return (
    <p className={cn("text-center text-xs text-subtle", className)}>
      {t(locale, "statsLine", { chats: String(stats.chats), audience: fmt })}
    </p>
  );
}

function SponsorAvatar({ src, title }: { src?: string; title: string }) {
  if (src) return <img src={src} alt="" className="size-9 shrink-0 rounded-full object-cover" loading="lazy" />;
  const letter = (title || "?").replace(/^@/, "").charAt(0).toUpperCase() || "?";
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-muted">
      {letter}
    </span>
  );
}

type BaseDetailsData = {
  accounts: number;
  usernames: number;
  ids: number;
  posts: number;
  sources: { name: string; posts: number; accounts: number | null; usernames?: number | null; ids?: number | null; complete: boolean; progress: number; updatedAt: number }[];
  epb: number;
  manual: number;
  updatedAt: number;
};

// "Blacklist base": the totals and what each source adds (opened from the base card).
// text colour of each tier's name
const TIER_TEXT: Record<string, string> = {
  gold: "text-gold",
  platinum: "text-[#aeb9c9]",
  black: "text-fg",
};

function ruBlacklists(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "блеклист";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "блеклиста";
  return "блеклистов";
}

// What each member card takes, with the user's own progress.
// What each card means and how to get it (shown when a card is opened).
const TIER_INFO: Record<Metal, Record<Locale, string>> = {
  gold: {
    ru: "Стартовая карта участника — выдаётся сразу, как только вы открыли приложение. С золотой карты всё начинается.",
    en: "The starter card — yours as soon as you open the app. Everything starts with the gold card.",
  },
  platinum: {
    ru: "Три опубликованных блеклиста — вы уже помогли нескольким людям не попасть на скамера.",
    en: "Three published blacklists — you have already kept several people away from scammers.",
  },
  black: {
    ru: "Высшая карта, как Centurion у American Express: десять опубликованных блеклистов. Для самых активных участников сообщества.",
    en: "The highest card, like the American Express Centurion: ten published blacklists. For the most active members of the community.",
  },
};

function TiersPage({
  onBack,
  onComplaint,
  holder,
  uid,
}: {
  onBack: () => void;
  onComplaint: () => void;
  holder: string;
  uid: string;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const [opened, setOpened] = useState<Metal | null>(null);
  const [base] = useState<BaseStats | null>(() => cachedBase());
  const { value: published } = usePublished(uid);
  const n = published ?? 0;
  const current = tierFor(n);
  const next = nextTier(n);
  const prevMin = current.min;
  const progress = next ? Math.min(1, (n - prevMin) / (next.min - prevMin)) : 1;
  const need = (min: number) =>
    min === 0
      ? t(locale, "tierAtStart")
      : locale === "en"
        ? `From ${min} blacklist${min === 1 ? "" : "s"}`
        : `От ${min} ${min === 1 ? "блеклиста" : "блеклистов"}`;
  const left = next ? next.min - n : 0;
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onBack();
          }}
          className="-ml-2 flex h-9 shrink-0 items-center gap-1 rounded-xl pr-2 font-display text-xl font-bold text-fg hover:bg-surface"
        >
          <ChevronLeft className="size-5" />
          {t(locale, "tiersTitle")}
        </button>
        <p className="text-sm leading-relaxed text-muted">{t(locale, "tiersIntro")}</p>
        <div className="rounded-2xl bg-surface/70 px-4 py-3.5 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted">{t(locale, "tiersYours")}</span>
            <span className={cn("font-display text-lg font-extrabold", TIER_TEXT[current.metal])}>{current.name}</span>
          </div>
          <div className="mt-1 text-sm text-fg">
            {published == null
              ? "…"
              : locale === "en"
                ? `${n} published blacklist${n === 1 ? "" : "s"}`
                : `${n} ${ruBlacklists(n)} опубликовано`}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gold transition-[width] duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="mt-2 text-xs text-muted">
            {next
              ? locale === "en"
                ? `${left} more to ${next.name}`
                : `До ${next.name} — ещё ${left} ${ruBlacklists(left)}`
              : t(locale, "tiersTop")}
          </div>
        </div>
        <div className="space-y-2">
          {TIERS.map((tier) => {
            const reached = n >= tier.min;
            const isCurrent = tier.metal === current.metal;
            return (
              <button
                type="button"
                key={tier.metal}
                onClick={() => {
                  haptic("light");
                  setOpened(tier.metal);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-2xl bg-surface/60 p-2.5 pr-3.5 transition-transform active:scale-[0.99]",
                  isCurrent && "shadow-[0_0_0_1px_rgba(242,190,85,0.55)]",
                )}
              >
                <img
                  src={CARD_LOOKS[tier.metal].thumb}
                  alt=""
                  draggable={false}
                  className={cn("h-[52px] w-[82px] shrink-0 rounded-[6px] object-cover shadow-[0_4px_10px_rgba(0,0,0,0.5)]", !reached && "opacity-45 grayscale-[35%]")}
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className={cn("font-display text-base font-bold", TIER_TEXT[tier.metal])}>{tier.name}</div>
                  <div className="text-xs text-muted">{need(tier.min)}</div>
                </div>
                {isCurrent ? (
                  <span className="shrink-0 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold">{t(locale, "tiersCurrent")}</span>
                ) : !reached ? (
                  <Lock className="size-4 shrink-0 text-subtle" />
                ) : null}
                <ChevronRight className="size-4 shrink-0 text-subtle" />
              </button>
            );
          })}
        </div>
      </div>
      {opened ? (
        <TierSheet
          tier={TIERS.find((x) => x.metal === opened)!}
          published={n}
          isCurrent={opened === current.metal}
          holder={holder}
          count={base?.accounts ?? null}
          need={need}
          onClose={() => setOpened(null)}
          onComplaint={() => {
            setOpened(null);
            onComplaint();
          }}
        />
      ) : null}
    </div>
  );
}

// One card opened over a blurred page: tilt it, read what it takes, close.
function TierSheet({
  tier,
  published,
  isCurrent,
  holder,
  count,
  need,
  onClose,
  onComplaint,
}: {
  tier: (typeof TIERS)[number];
  published: number;
  isCurrent: boolean;
  holder: string;
  count: number | null;
  need: (min: number) => string;
  onClose: () => void;
  onComplaint: () => void;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const reached = published >= tier.min;
  const left = tier.min - published;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="epb-card-sheet" role="dialog" aria-modal="true" aria-label={tier.name}>
      <div className="flex shrink-0 justify-end px-3" style={{ paddingTop: "calc(var(--tg-safe-top, 0px) + 10px)" }}>
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onClose();
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-sm font-semibold text-fg backdrop-blur hover:bg-white/15"
        >
          <X className="size-4" />
          {t(locale, "tierClose")}
        </button>
      </div>
      {/* a tap outside the card and the text closes it */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto px-5 pb-8" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="epb-card-sheet-card mt-6 w-full">
          <MemberCard
            metal={tier.metal}
            holder={holder}
            count={count}
            ribbon={t(locale, "cardRibbon")}
            locale={locale}
            width="min(360px, 90vw)"
          />
        </div>
        <div className="epb-card-sheet-info mt-8 w-full max-w-md text-center">
          <div className={cn("font-display text-3xl font-extrabold", TIER_TEXT[tier.metal])}>{tier.name}</div>
          <div className="mt-1 text-sm font-semibold text-muted">{need(tier.min)}</div>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-fg/90">{TIER_INFO[tier.metal][locale]}</p>
          <div className="mx-auto mt-5 max-w-sm rounded-2xl bg-white/[0.06] px-4 py-3 text-left text-sm leading-relaxed text-muted">
            <div className="mb-1 font-semibold text-fg">{t(locale, "tierHowTitle")}</div>
            {t(locale, "tierHow")}
          </div>
          <div className="mt-5 text-sm font-semibold">
            {isCurrent ? (
              <span className="text-gold">{t(locale, "tierIsYours")}</span>
            ) : reached ? (
              <span className="text-fg/80">{t(locale, "tierReached")}</span>
            ) : (
              <span className="text-muted">
                {locale === "en"
                  ? `${left} more blacklist${left === 1 ? "" : "s"} to go`
                  : `Осталось ${left} ${ruBlacklists(left)}`}
              </span>
            )}
          </div>
          {!reached ? (
            <Button size="lg" className="mt-5 w-full max-w-sm rounded-xl bg-none" onClick={onComplaint}>
              {t(locale, "fileComplaint")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// After a check that found nothing: what was looked through, source by source
// (posts read, usernames and IDs compared), each marked "not found".
let reportDetails: { at: number; data: BaseDetailsData | null } | null = null;
function ruForm(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function CleanReport() {
  const locale = useBlacklistStore((s) => s.locale);
  const [data, setData] = useState<BaseDetailsData | null>(() => reportDetails?.data ?? null);
  useEffect(() => {
    if (reportDetails && Date.now() - reportDetails.at < 60_000) return;
    void getBaseDetails()
      .then((d) => {
        reportDetails = { at: Date.now(), data: (d as BaseDetailsData | null) ?? null };
        setData(reportDetails.data);
      })
      .catch(() => {});
  }, []);
  if (!data) return null;
  const en = locale === "en";
  const fmt = (n: number) => n.toLocaleString(en ? "en-US" : "ru-RU");
  type Row = { name: string; main: string; usernames: number | null; ids: number | null };
  // forum cases are not in the channel totals: added here
  const arbs = data.sources.filter((src) => /^Арбитражи /.test(src.name));
  const totalUsernames = data.usernames + arbs.reduce((n, src) => n + (src.usernames || 0), 0);
  const totalRecords = data.posts + arbs.reduce((n, src) => n + src.posts, 0) + data.epb + data.manual;
  const rows: Row[] = data.sources.filter((src) => src.posts > 0).map((src) => {
    const arb = /^Арбитражи /.test(src.name);
    return {
      name: arb && en ? src.name.replace(/^Арбитражи /, "Arbitrations ") : src.name,
      main: arb ? `${fmt(src.posts)} ${en ? "cases" : "арбитражей"}` : `${fmt(src.posts)} ${en ? "posts" : "постов"}`,
      usernames: src.usernames ?? null,
      ids: src.ids ?? null,
    };
  });
  if (data.epb && !rows.some((r) => r.name === "Europe Private Blacklist")) {
    rows.unshift({ name: "Europe Private Blacklist", main: `${fmt(data.epb)} ${en ? "complaints" : "жалоб"}`, usernames: null, ids: null });
  }
  if (data.manual) rows.push({ name: en ? "Third-party blacklists" : "Сторонние блеклисты", main: `${fmt(data.manual)} ${en ? "entries" : "записей"}`, usernames: null, ids: null });
  if (!rows.length) return null;
  return (
    <div className="epb-frog-in mt-4 w-full rounded-2xl bg-surface/70 p-4 text-left shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <p className="text-xs font-bold tracking-[0.14em] text-muted uppercase">{en ? "Check report" : "Отчёт проверки"}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          [rows.length, en ? "sources" : ruForm(rows.length, "источник", "источника", "источников")],
          [totalUsernames, en ? "usernames" : ruForm(totalUsernames, "юзернейм", "юзернейма", "юзернеймов")],
          [data.ids, "ID"],
        ].map(([v, label]) => (
          <div key={String(label)} className="rounded-xl bg-bg/40 px-2.5 py-2">
            <div className="font-display text-base leading-tight font-extrabold text-fg">{fmt(Number(v))}</div>
            <div className="text-[11px] text-muted">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-subtle">
        {en ? `${fmt(totalRecords)} records read, ${fmt(data.accounts)} accounts compared` : `Просмотрено записей: ${fmt(totalRecords)} · сверено аккаунтов: ${fmt(data.accounts)}`}
      </p>
      <div className="mt-3 divide-y divide-fg/5">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{r.name}</p>
              <p className="text-[11px] text-muted">
                {r.main}
                {r.usernames ? ` · @ ${fmt(r.usernames)}` : ""}
                {r.ids ? ` · ID ${fmt(r.ids)}` : ""}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ok">
              <ShieldCheck className="size-3.5" />
              {en ? "not found" : "не найден"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BasePage({ onBack }: { onBack: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [data, setData] = useState<BaseDetailsData | null | undefined>(undefined);
  useEffect(() => {
    void getBaseDetails()
      .then((d) => setData((d as BaseDetailsData | null) ?? null))
      .catch(() => setData(null));
  }, []);
  const fmt = (n: number) => n.toLocaleString(locale === "en" ? "en-US" : "ru-RU");
  const stat = (value: number, label: string) => (
    <div className="rounded-2xl bg-surface/70 px-3 py-2.5 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div className="font-display text-lg leading-tight font-extrabold text-fg">{fmt(value)}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onBack();
          }}
          className="-ml-2 flex h-9 shrink-0 items-center gap-1 rounded-xl pr-2 font-display text-xl font-bold text-fg hover:bg-surface"
        >
          <ChevronLeft className="size-5" />
          {t(locale, "back")}
        </button>
        {data === undefined ? (
          <div className="space-y-2">
            <div className="h-28 animate-pulse rounded-2xl bg-surface/60" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[56px] animate-pulse rounded-2xl bg-surface/60" />
            ))}
          </div>
        ) : !data ? (
          <p className="py-8 text-center text-sm text-muted">{t(locale, "checkFail")}</p>
        ) : (
          <>
            <div className="epb-base-card relative overflow-hidden rounded-2xl px-4 py-4">
              <img
                src="/brand/emblem-v2.webp"
                alt=""
                aria-hidden
                draggable={false}
                className="pointer-events-none absolute -right-6 top-1/2 h-[150%] w-auto -translate-y-1/2 select-none opacity-[0.16]"
              />
              <div className="relative">
                <div className="text-[11px] font-bold tracking-[0.14em] text-muted uppercase">{t(locale, "baseTitle")}</div>
                <div className="mt-1 font-display text-4xl leading-none font-extrabold tracking-tight text-gold">{fmt(data.accounts)}</div>
                <div className="mt-1 text-sm text-muted">{t(locale, "basePageAccounts")}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {stat(data.usernames, t(locale, "basePageUsernames"))}
              {stat(data.ids, t(locale, "basePageIds"))}
              {stat(data.posts, t(locale, "basePagePosts"))}
            </div>
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-bold text-muted">
                  <ShieldAlert className="size-4" />
                  {t(locale, "basePageSources")}
                </div>
                <span className="rounded-full bg-gold/10 px-2 py-0.5 text-xs font-bold text-gold">{data.sources.length + 2}</span>
              </div>
              <p className="text-xs leading-relaxed text-subtle">{t(locale, "basePageSourcesHint")}</p>
              {data.sources.map((src) => (
                <div key={src.name} className="rounded-2xl bg-surface/70 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.06)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold">{src.name}</span>
                    <span className={cn("shrink-0 text-xs font-semibold", src.complete ? "text-gold" : "text-muted")}>
                      {src.complete ? `✓ ${t(locale, "basePageFull")}` : t(locale, "basePageLoading", { p: src.progress })}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                    <span>
                      {fmt(src.posts)} {t(locale, "basePagePosts")}
                    </span>
                    {src.accounts !== null ? <span>{t(locale, "basePageAcc", { n: fmt(src.accounts) })}</span> : null}
                    {src.updatedAt ? <span>{agoText(locale, src.updatedAt)}</span> : null}
                  </div>
                  {!src.complete ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-fg/10">
                      <div className="h-full rounded-full bg-gold" style={{ width: `${Math.max(3, src.progress)}%` }} />
                    </div>
                  ) : null}
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-surface/70 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.06)]">
                  <div className="text-sm font-semibold">{t(locale, "basePageEpb")}</div>
                  <div className="mt-1 text-xs text-muted">{t(locale, "basePageEntries", { n: fmt(data.epb) })}</div>
                </div>
                <div className="rounded-2xl bg-surface/70 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.06)]">
                  <div className="text-sm font-semibold">{t(locale, "basePageManual")}</div>
                  <div className="mt-1 text-xs text-muted">{t(locale, "basePageEntries", { n: fmt(data.manual) })}</div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SponsorsPage({ onBack }: { onBack: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [items, setItems] = useState<SponsorItem[] | null>(null);
  useEffect(() => {
    void getSponsors()
      .then((s) => setItems(Array.isArray(s) ? s : []))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              haptic("light");
              onBack();
            }}
            className="-ml-2 flex h-9 shrink-0 items-center gap-1 rounded-xl pr-2 font-display text-xl font-bold text-fg hover:bg-surface"
          >
            <ChevronLeft className="size-5" />
            {t(locale, "back")}
          </button>
        </div>
        <PartnerMarquee />
        <p className="text-sm leading-relaxed text-muted">{t(locale, "sponsorsHeader")}</p>
        {items === null ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-[52px] animate-pulse rounded-2xl bg-surface/60" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t(locale, "sponsorsEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {items.map((s) =>
              s.link ? (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    haptic("light");
                    openExternal(s.link);
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl bg-surface/70 p-2.5 text-left shadow-[0_0_0_1px_rgba(243,239,228,0.08)] hover:bg-surface"
                >
                  <SponsorAvatar src={s.avatar} title={s.title} />
                  <span className="min-w-0 flex-1 truncate font-semibold text-gold">{s.title}</span>
                  <ExternalLink className="size-4 shrink-0 text-gold" />
                </button>
              ) : (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-2xl bg-surface/70 p-2.5 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]"
                >
                  <SponsorAvatar src={s.avatar} title={s.title} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{s.title}</span>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OwnersGuide() {
  const locale = useBlacklistStore((s) => s.locale);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-5 text-sm leading-relaxed">
        <h2 className="font-display text-xl font-bold">{t(locale, "ownersTitle")}</h2>
        <p className="text-muted">{t(locale, "ownersIntro")}</p>
        <div className="space-y-2">
          <h3 className="font-display text-base font-bold">{t(locale, "ownersHow")}</h3>
          <p>{t(locale, "ownersStep1")}</p>
          <p className="font-semibold">{t(locale, "ownersStep2")}</p>
          <p>{t(locale, "ownersGroup")}</p>
          <p>{t(locale, "ownersChannel")}</p>
          <p>{t(locale, "ownersStep3")}</p>
        </div>
        <p className="text-muted">
          {t(locale, "ownersHelp")}{" "}
          <a href="https://t.me/EuropePromo" target="_blank" rel="noreferrer" className="font-medium text-gold">
            @EuropePromo
          </a>
        </p>
      </div>
    </div>
  );
}

function History({ telegramId }: { telegramId: string }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [items, setItems] = useState<ComplaintHistoryItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!telegramId) {
        setItems([]);
        return;
      }
      try {
        const list = await getMyComplaints({ data: { telegramId, initData: telegramInitData() } });
        if (!cancelled) setItems(list);
      } catch {
        if (!cancelled) setItems([]);
      }
    }
    void load();
    const tmr = window.setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(tmr);
    };
  }, [telegramId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-3">
        {items === null ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <LoaderCircle className="size-4 animate-spin text-gold" />
            {t(locale, "historyLoading")}
          </p>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">{t(locale, "historyEmpty")}</p>
        ) : (
          items.map((item) => <HistoryCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}

type BlEntry = {
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
};

type CheckData = {
  query: { username: string; id: string };
  epb: { id: string; accounts: string; amount: string; currency: string; date: number }[];
  channels: { channelId?: string; messageId?: number; channelTitle: string; link: string; date: number; snippet: string }[];
  manual: { id: string; account: string; source: string; note?: string; date: number }[];
  forum?: { key: string; source: string; url: string; status: string; amount: string; defendant: string; date: number; via: "nick" | "contact" | "wallet"; text?: string }[];
  sourceHits?: Record<string, number>;
  account?: {
    id: string;
    idSource: "input" | "telegram" | "posts";
    usernames: string[];
    name: string;
    premium: boolean;
    scam: boolean;
    fake: boolean;
    bot: boolean;
    verified: boolean;
    reg: { year: number; part: 0 | 1 | 2; later?: boolean; months?: number } | null;
    previous: { username: string; since: number; source: "post" | "bot"; where?: string }[];
    lastSeen?: { kind: "online" | "recently" | "week" | "month" | "time" | "hidden"; at?: number };
    hasPhoto?: boolean;
    restricted?: string;
    about?: string;
    channel?: { title: string; username?: string };
    firstListed?: number;
    listedIn?: number;
  };
};

function ageText(locale: Locale, months?: number): string {
  if (months == null) return "";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (locale === "en") return [y ? `${y} yr` : "", m ? `${m} mo` : ""].filter(Boolean).join(" ") || "under a month";
  const yWord = y % 10 === 1 && y % 100 !== 11 ? "год" : [2, 3, 4].includes(y % 10) && ![12, 13, 14].includes(y % 100) ? "года" : "лет";
  return [y ? `${y} ${yWord}` : "", m ? `${m} мес` : ""].filter(Boolean).join(" ") || "меньше месяца";
}

function lastSeenText(locale: Locale, ls: NonNullable<NonNullable<CheckData["account"]>["lastSeen"]>): string {
  const en = locale === "en";
  if (ls.kind === "online") return en ? "online now" : "сейчас в сети";
  if (ls.kind === "recently") return en ? "recently" : "недавно";
  if (ls.kind === "week") return en ? "within a week" : "на этой неделе";
  if (ls.kind === "month") return en ? "within a month" : "в этом месяце";
  if (ls.kind === "time" && ls.at) {
    const d = new Date(ls.at * 1000);
    return d.toLocaleDateString(en ? "en-GB" : "ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  return en ? "hidden or long ago" : "скрыто или давно";
}

function regText(locale: Locale, reg: NonNullable<CheckData["account"]>["reg"]): string {
  if (!reg) return "";
  const en = locale === "en";
  if (reg.later) return en ? `late ${reg.year} or later` : `конец ${reg.year} или позже`;
  return `${(en ? ["early", "mid", "late"] : ["начало", "середина", "конец"])[reg.part]} ${reg.year}`;
}

// What is known about the account itself: id, name, Telegram's own marks, an
// estimated registration date and earlier usernames.
function AccountCardView({ a }: { a: NonNullable<CheckData["account"]> }) {
  const locale = useBlacklistStore((s) => s.locale);
  const monthYear = (sec: number) => {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
  };
  const tags = [
    a.premium ? "⭐ Premium" : "",
    a.bot ? `🤖 ${t(locale, "accBot")}` : "",
    a.verified ? `✔️ ${t(locale, "accVerified")}` : "",
    a.hasPhoto === false ? t(locale, "accNoPhoto") : "",
  ].filter(Boolean);
  const age = ageText(locale, a.reg?.months);
  return (
    <div className="mb-4 space-y-2 rounded-2xl bg-surface/70 p-4 text-sm shadow-[0_0_0_1px_rgba(240,196,48,0.14)]">
      <p className="font-display text-base font-bold">👤 {t(locale, "accCardTitle")}</p>
      {a.scam || a.fake ? (
        <p className="flex items-center gap-2 rounded-xl bg-danger/10 px-3 py-2 font-semibold text-danger">
          <ShieldAlert className="size-4 shrink-0" />
          {t(locale, a.scam ? "accScam" : "accFake")}
        </p>
      ) : null}
      {a.id ? (
        <p>
          <span className="text-muted">ID:</span> <span className="font-mono font-semibold">{a.id}</span>
          {a.idSource === "posts" ? <span className="text-muted"> · {t(locale, "accFromPosts")}</span> : null}
        </p>
      ) : null}
      {a.name ? (
        <p>
          <span className="text-muted">{t(locale, "accName")}:</span> {a.name}
        </p>
      ) : null}
      {a.usernames.length ? (
        <p>
          <span className="text-muted">{t(locale, "accNow")}:</span> {a.usernames.map((u) => `@${u}`).join(", ")}
        </p>
      ) : a.idSource === "posts" ? (
        <p className="text-muted">{t(locale, "accGone")}</p>
      ) : null}
      {a.restricted ? (
        <p className="text-danger">
          ⚠️ {t(locale, "accRestricted")}: {a.restricted.slice(0, 120)}
        </p>
      ) : null}
      {tags.length ? <p className="text-muted">{tags.join(" · ")}</p> : null}
      {a.lastSeen ? (
        <p>
          <span className="text-muted">{t(locale, "accLastSeen")}:</span> {lastSeenText(locale, a.lastSeen)}
        </p>
      ) : null}
      {a.about ? (
        <p className="break-words">
          <span className="text-muted">{t(locale, "accAbout")}:</span> {a.about.replace(/\s+/g, " ").slice(0, 200)}
        </p>
      ) : null}
      {a.channel ? (
        <p>
          <span className="text-muted">{t(locale, "accChannel")}:</span> {a.channel.username ? `@${a.channel.username}` : a.channel.title}
        </p>
      ) : null}
      {a.reg ? (
        <p>
          <span className="text-muted">{t(locale, "accReg")}:</span> ≈ {regText(locale, a.reg)}
          {age ? ` (≈ ${age})` : ""} <span className="text-xs text-muted">— {t(locale, "accRegEstimate")}</span>
        </p>
      ) : null}
      {a.firstListed ? (
        <p>
          <span className="text-muted">{t(locale, "accFirstListed")}:</span> {monthYear(a.firstListed)}
          {a.listedIn ? <span className="text-muted"> · {t(locale, "accSources")}: {a.listedIn}</span> : null}
        </p>
      ) : null}
      {a.previous.length ? (
        <div className="space-y-1 pt-1">
          <p className="text-muted">{t(locale, "accPrev")}:</p>
          {a.previous.slice(0, 6).map((p) => (
            <p key={p.username} className="pl-2">
              <span className="font-semibold">@{p.username}</span>
              <span className="text-xs text-muted">
                {" "}
                — {p.source === "post" ? t(locale, "accPrevPost", { where: p.where || t(locale, "accBlacklist") }) : t(locale, "accPrevBot")}
                {p.since ? `, ${monthYear(p.since)}` : ""}
              </span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type ScanSource = { key: string; title: string };

// Hits per source when the server didn't send them (older cached results).
function fallbackHits(r: CheckData): Record<string, number> {
  const out: Record<string, number> = { epb: r.epb.length, manual: r.manual?.length ?? 0 };
  for (const c of r.channels) {
    const key = `ch:${forumName(c.channelTitle)}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// The search "scan": each source slides in as "Проверка <name>…" with a moving
// highlight while the server works; when the answer arrives the rows resolve one
// by one to "чисто" / "найдено: N", then onDone opens the full result.
function SourceScan({
  sources,
  hits,
  onDone,
}: {
  sources: ScanSource[];
  hits: Record<string, number> | null;
  onDone: () => void;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const [shown, setShown] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [resolved, setResolved] = useState(0);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const n = sources.length;
  const appearMs = Math.min(230, 1800 / Math.max(1, n));
  const resolveMs = Math.min(230, 1600 / Math.max(1, n));

  useEffect(() => {
    if (shown >= n) return;
    const tm = window.setTimeout(() => setShown((v) => v + 1), appearMs);
    return () => window.clearTimeout(tm);
  }, [shown, n, appearMs]);

  useEffect(() => {
    if (hits) return;
    const iv = window.setInterval(() => setCursor((c) => c + 1), 420);
    return () => window.clearInterval(iv);
  }, [hits]);

  useEffect(() => {
    if (!hits || shown < n) return;
    if (resolved >= n) {
      if (!doneRef.current) {
        doneRef.current = true;
        window.setTimeout(() => onDoneRef.current(), 650);
      }
      return;
    }
    const tm = window.setTimeout(() => {
      const found = (hits[sources[resolved]!.key] ?? 0) > 0;
      haptic(found ? "heavy" : "light");
      setResolved((v) => v + 1);
    }, resolved === 0 ? 150 : resolveMs);
    return () => window.clearTimeout(tm);
  }, [hits, shown, resolved, n, sources, resolveMs]);

  const active = shown ? cursor % shown : -1;
  return (
    <ul className="w-full max-w-sm space-y-1.5 text-left">
      {sources.slice(0, shown).map((s, i) => {
        const done = Boolean(hits) && i < resolved;
        const count = hits?.[s.key] ?? 0;
        const isActive = !hits && i === active;
        return (
          <li
            key={s.key}
            className={cn(
              "epb-scan-row flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors duration-300",
              done ? (count ? "bg-danger/10" : "bg-ok/5") : isActive ? "bg-gold/10" : "bg-surface/50",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              {done ? (
                count ? (
                  <ShieldAlert className="epb-scan-pop size-4 text-danger" />
                ) : (
                  <ShieldCheck className="epb-scan-pop size-4 text-ok" />
                )
              ) : (
                <LoaderCircle className={cn("size-4 animate-spin", isActive ? "text-gold" : "text-muted/50")} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {done ? null : <span className="text-muted">{t(locale, "scanChecking")} </span>}
              <span className={cn("font-semibold", isActive && "epb-gold-text")}>{s.title}</span>
            </span>
            {done ? (
              <span className={cn("epb-scan-pop shrink-0 text-xs font-bold", count ? "text-danger" : "text-ok")}>
                {count ? t(locale, "scanFound", { n: count }) : t(locale, "scanClean")}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}


const EUROPE_PROMO_URL = "https://t.me/EuropePromo";

// Short, clean label for a source forum/channel in the "Найден на форумах" list
// (e.g. "WWH Info" → "WWH"). Easy to extend with more aliases.
const FORUM_ALIASES: { re: RegExp; name: string }[] = [{ re: /wwh/i, name: "WWH" }];
function forumName(title: string): string {
  const t = (title || "").trim();
  for (const a of FORUM_ALIASES) if (a.re.test(t)) return a.name;
  return t || "форум";
}
// WWH is a forum: its hits are shown without a message link.
function isWWH(title: string): boolean {
  return /wwh/i.test(title || "");
}

const fmtBlDate = (locale: Locale, ms: number) =>
  ms ? new Date(ms).toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";

function CheckCounterparty({ onBack }: { onBack: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<CheckData | null>(null);
  // The newest blacklist posts from the connected channels (cached instantly,
  // refreshed in the background). A tap searches that account.
  const latest = useLatestParsed(true);
  const [detail, setDetail] = useState<BlEntry | null>(null);
  const [post, setPost] = useState<CheckData["channels"][number] | null>(null);
  const [showBase, setShowBase] = useState(false);

  // Warm the cache so the frog loader shows instantly on the first search.
  useEffect(() => {
    const img = new Image();
    img.src = FROG_ANIM;
  }, []);

  // After a few seconds of searching, a grey note says it can take up to 30 s.
  const [slowSearch, setSlowSearch] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlowSearch(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowSearch(true), 4000);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const [captcha, setCaptcha] = useState<string | null>(null);
  const [capAnswer, setCapAnswer] = useState("");
  const [capMsg, setCapMsg] = useState("");
  const [capBusy, setCapBusy] = useState(false);

  async function loadCaptcha(msg = "") {
    setCapAnswer("");
    setCapMsg(msg);
    try {
      const r = await getCaptcha({ data: { initData: telegramInitData() } });
      if (r.ok) {
        if (!captcha) hapticNotify("warning");
        setCaptcha(r.image);
      }
      else {
        setCaptcha(null);
        setError(t(locale, "capTooMany"));
      }
    } catch {
      setError(t(locale, "checkFail"));
    }
  }

  async function submitCaptcha() {
    if (!capAnswer.trim() || capBusy) return;
    setCapBusy(true);
    try {
      const r = await solveCaptcha({ data: { initData: telegramInitData(), answer: capAnswer } });
      if (r.result === "ok") {
        haptic("soft");
        setCaptcha(null);
        setCapMsg("");
        await run();
      } else if (r.result === "wrong") {
        haptic("heavy");
        setCapAnswer("");
        setCapMsg(t(locale, "capWrong"));
      } else {
        if (r.result === "again") haptic("heavy");
        await loadCaptcha(t(locale, r.result === "again" ? "capWrongNew" : "capExpired"));
      }
    } catch {
      setCapMsg(t(locale, "checkFail"));
    } finally {
      setCapBusy(false);
    }
  }

  // Sources the check goes through (for the scan animation); fetched once.
  const [scanSources, setScanSources] = useState<ScanSource[]>([]);
  const [scanHits, setScanHits] = useState<Record<string, number> | null>(null);
  const [scanId, setScanId] = useState(0);
  const scanDone = useRef<(() => void) | null>(null);
  const sourcesRef = useRef<Promise<ScanSource[]> | null>(null);
  function loadSources(): Promise<ScanSource[]> {
    if (!sourcesRef.current) {
      sourcesRef.current = getCheckSources({ data: { initData: telegramInitData() } })
        .then((r) => (r.ok ? r.sources : []))
        .catch(() => [] as ScanSource[])
        .then((list) => {
          if (!list.length) sourcesRef.current = null; // try again next time
          setScanSources(list);
          return list;
        });
    }
    return sourcesRef.current;
  }
  useEffect(() => {
    void loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One search at a time (Enter in the field would otherwise start a second one).
  const running = useRef(false);
  async function run() {
    if (running.current) return;
    const input = value.trim();
    if (!input) {
      setError(t(locale, "checkEmptyInput"));
      return;
    }
    running.current = true;
    haptic("light");
    setError("");
    setScanHits(null);
    setScanId((v) => v + 1);
    setLoading(true);
    setData(null);
    try {
      // Hold the loader for at least 1.5 s so the scan never just flashes.
      const [res, sources] = await Promise.all([
        checkCounterparty({ data: { input, initData: telegramInitData(), platform: telegramPlatform() } }),
        loadSources(),
        new Promise((r) => window.setTimeout(r, 1500)),
      ]);
      if (res.ok) {
        const r = res.result as CheckData;
        if (sources.length) {
          // Let the rows resolve one by one before the full result opens.
          await new Promise<void>((resolve) => {
            scanDone.current = resolve;
            setScanHits(r.sourceHits ?? fallbackHits(r));
          });
          scanDone.current = null;
        }
        setData(r);
        haptic(r.epb.length || r.channels.length || (r.manual?.length ?? 0) ? "heavy" : "soft");
      } else if (res.error === "captcha") {
        await loadCaptcha();
      } else {
        setError(t(locale, res.error === "too many" ? "capTooMany" : "checkFail"));
      }
    } catch {
      setError(t(locale, "checkFail"));
    } finally {
      running.current = false;
      setLoading(false);
    }
  }

  const open = (e: BlEntry) => {
    haptic("light");
    setDetail(e);
  };
  const epbEntry = (e: CheckData["epb"][number]): BlEntry => ({
    kind: "epb", id: e.id, account: e.accounts || e.id, amount: e.amount, currency: e.currency, date: e.date,
  });
  const manualEntry = (m: CheckData["manual"][number]): BlEntry => ({
    kind: "manual", id: m.id, account: m.account, date: m.date, source: m.source, note: m.note,
  });

  if (detail) return <BlacklistDetail entry={detail} onBack={() => setDetail(null)} />;
  if (post) return <PostView hit={post} onBack={() => setPost(null)} />;
  // the search stays as it was when the user comes back from the base page
  if (showBase) return <BasePage onBack={() => setShowBase(false)} />;

  const found = data && (data.epb.length > 0 || data.channels.length > 0 || (data.manual?.length ?? 0) > 0 || (data.forum?.length ?? 0) > 0);
  const fmtDate = (ms: number) => fmtBlDate(locale, ms);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                haptic("light");
                onBack();
              }}
              aria-label={t(locale, "back")}
              className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-xl text-fg hover:bg-surface"
            >
              <ChevronLeft className="size-5" />
            </button>
            <h2 className="font-display text-xl font-bold">{t(locale, "checkTitle")}</h2>
          </div>
          <p className="text-sm text-muted">{t(locale, "checkHint")}</p>
        </div>
        <button
          type="button"
          className="block w-full text-left"
          aria-label={t(locale, "baseTitle")}
          onClick={() => {
            haptic("light");
            setShowBase(true);
          }}
        >
          <PartnerMarquee />
        </button>
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value.slice(0, 200));
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder={t(locale, "checkPlaceholder")}
            autoComplete="off"
            autoCapitalize="none"
          />
          <Button className="shrink-0 rounded-xl px-4" onClick={() => void run()} disabled={loading}>
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
          </Button>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {captcha ? (
          <div className="epb-cap-card space-y-3 rounded-2xl bg-surface/70 p-4 shadow-[0_0_0_1px_rgba(240,196,48,0.14)]">
            <p className="font-display text-base font-bold">{t(locale, "capTitle")}</p>
            <p className="text-sm text-muted">{t(locale, "capHint")}</p>
            <img key={captcha} src={captcha} alt="" draggable={false} className="epb-cap-img w-full select-none rounded-xl" />
            <Input
              value={capAnswer}
              onChange={(e) => setCapAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCaptcha();
              }}
              placeholder={t(locale, "capPlaceholder")}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {capMsg ? <p className="text-sm text-danger">{capMsg}</p> : null}
            <div className="flex gap-2">
              <Button className="flex-1 rounded-xl" onClick={() => void submitCaptcha()} disabled={capBusy || !capAnswer.trim()}>
                {t(locale, "capSubmit")}
              </Button>
              <Button variant="secondary" className="rounded-xl" onClick={() => void loadCaptcha()} disabled={capBusy}>
                {t(locale, "capNew")}
              </Button>
            </div>
          </div>
        ) : null}
        {loading ? (
          <div className="epb-frog-in flex flex-col items-center gap-4 py-6 text-center">
            <img
              src={FROG_ANIM}
              alt=""
              width={scanSources.length ? 92 : 120}
              height={scanSources.length ? 94 : 123}
              draggable={false}
              className={cn(
                "select-none drop-shadow-[0_10px_30px_rgba(240,180,60,0.25)]",
                scanSources.length ? "h-[94px] w-[92px]" : "h-[123px] w-[120px]",
              )}
            />
            <SearchSteps input={value} />
            {scanSources.length ? (
              <SourceScan key={scanId} sources={scanSources} hits={scanHits} onDone={() => scanDone.current?.()} />
            ) : (
              <div className="epb-progress h-1.5 w-48 max-w-full rounded-full bg-surface" />
            )}
            {slowSearch ? (
              <p className="epb-frog-in max-w-xs text-xs leading-relaxed text-muted/80">{t(locale, "checkSlow")}</p>
            ) : null}
          </div>
        ) : null}

        {data && !loading ? (
          <div className="epb-frog-in">{data.account ? <AccountCardView a={data.account} /> : null}{found ? (
            <div className="space-y-4">
              {data.epb.length ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-danger">
                    <ShieldAlert className="size-4" />
                    {t(locale, "checkInEpb")}
                  </div>
                  {data.epb.map((e) => (
                    <BlacklistRow key={e.id} account={e.accounts || e.id} sub={`${t(locale, "checkEpbItem", { id: e.id, amount: e.amount, currency: e.currency })}${fmtDate(e.date) ? ` · ${fmtDate(e.date)}` : ""}`} onClick={() => open(epbEntry(e))} />
                  ))}
                </div>
              ) : null}
              {data.manual?.length ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-gold">
                    <ShieldAlert className="size-4" />
                    {t(locale, "checkInExternal")}
                  </div>
                  {data.manual.map((m) => (
                    <BlacklistRow key={m.id} account={m.account} sub={m.source} onClick={() => open(manualEntry(m))} />
                  ))}
                </div>
              ) : null}
              {data.channels.length ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-gold">
                    <ShieldAlert className="size-4" />
                    {/* Only WWH (forum) hits → "Найдено на форуме"; any blacklist channel hit → "Найдено в блеклистах". */}
                    {t(locale, data.channels.every((c) => isWWH(c.channelTitle)) ? "checkOnForum" : "checkInChats")}
                  </div>
                  {data.channels.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        haptic("light");
                        setPost(c);
                      }}
                      className="block w-full rounded-2xl bg-surface/70 p-3 text-left text-sm shadow-[0_0_0_1px_rgba(243,239,228,0.08)] hover:bg-surface"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold">{forumName(c.channelTitle)}</p>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-gold">
                          {t(locale, "postOpen")} <ChevronLeft className="size-3 rotate-180" />
                        </span>
                      </div>
                      {c.snippet ? <p className="mt-1 text-xs leading-relaxed text-muted">{c.snippet}</p> : null}
                      {fmtDate(c.date) ? <p className="mt-1 text-[11px] text-subtle">{fmtDate(c.date)}</p> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {data.forum?.length ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-muted">
                    <Scale className="size-4" />
                    {t(locale, "checkForumArb", { n: String(data.forum.length) })}
                  </div>
                  {data.forum.map((f) => (
                    <a
                      key={f.key}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block w-full rounded-2xl bg-surface/70 p-3 text-left text-sm shadow-[0_0_0_1px_rgba(243,239,228,0.08)] hover:bg-surface"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold">
                          {f.defendant}
                          {f.via !== "nick" ? <span className="font-normal text-muted"> · {t(locale, f.via === "wallet" ? "forumViaWallet" : "forumViaContact")}</span> : null}
                        </p>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-gold">
                          {t(locale, "postOpen")} <ExternalLink className="size-3" />
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {f.amount}
                        {f.status ? (
                          // an open case stands out a little; a resolved one is just data
                          <span className={cn(/решено|resolved/i.test(f.status) ? "" : "font-semibold text-gold")}> · {f.status}</span>
                        ) : null}
                        {fmtDate(f.date) ? ` · ${fmtDate(f.date)}` : ""} · {f.source}
                      </p>
                      {f.text ? <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-fg/80">{f.text}</p> : null}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
              <ShieldCheck className="size-10 text-ok" />
              <p className="font-display text-lg font-bold">{t(locale, "checkClean")}</p>
              <p className="max-w-xs text-sm leading-relaxed text-muted">{t(locale, "checkCleanHint")}</p>
              <CleanReport />
            </div>
          )}</div>
        ) : null}

        {!data && !loading && latest.length ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-bold text-muted">
                <ShieldAlert className="size-4" />
                {t(locale, "latestTitle")}
              </div>
              <span className="rounded-full bg-gold/10 px-2 py-0.5 text-xs font-bold text-gold">{latest.length}</span>
            </div>
            {latest.map((e, i) => (
              <LatestRow
                key={e.id}
                item={e}
                index={i}
                onClick={() => {
                  // open that blacklist post (full text and photos)
                  if (e.channelId && e.messageId) {
                    setPost({ channelId: e.channelId, messageId: e.messageId, channelTitle: e.source, link: e.link || "", date: e.date, snippet: "" });
                  }
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// A blacklist post opened inside the app: the whole text (from the server's copy
// of the channel) and its photos, loaded only now. Works for closed channels too.
type PostData = { text: string; date: number; source: string; photos: string[]; more: number; links?: { o: number; l: number; u: string }[]; photosPending?: boolean };

// Post text with working links: the post's own links (also those hidden behind
// words) where known, plus any plain https://, t.me/… and @username in the rest.
// (no lookbehind: older iPhones' Safari can't parse it)
const AUTO_LINK_RE = /(https?:\/\/[^\s<>"]+|\bt\.me\/[A-Za-z0-9_+/?=&%-]+|@[A-Za-z0-9_]{4,32})/g;
function autoLinks(text: string, from = 0, to = text.length): { o: number; l: number; u: string }[] {
  const out: { o: number; l: number; u: string }[] = [];
  const part = text.slice(from, to);
  for (const m of part.matchAll(AUTO_LINK_RE)) {
    const at = from + (m.index ?? 0);
    const raw = m[0].replace(/[.,;:!?)»"']+$/, "");
    if (!raw) continue;
    // "@" inside an e-mail or a word is not a username
    if (raw.startsWith("@") && at > 0 && /[A-Za-z0-9_.]/.test(text[at - 1]!)) continue;
    const u = raw.startsWith("@") ? `https://t.me/${raw.slice(1)}` : raw.startsWith("t.me/") ? `https://${raw}` : raw;
    out.push({ o: at, l: raw.length, u });
  }
  return out;
}
const SAFE_LINK_RE = /^(https?:\/\/|tg:\/\/)/i;
function LinkedText({ text, links }: { text: string; links?: { o: number; l: number; u: string }[] }) {
  const own = (links || []).filter((x) => x.o >= 0 && x.l > 0 && x.o + x.l <= text.length).sort((a, b) => a.o - b.o);
  // the gaps between the post's own links get plain-text detection
  const all: { o: number; l: number; u: string }[] = [];
  let pos = 0;
  for (const x of own) {
    if (x.o < pos) continue;
    all.push(...autoLinks(text, pos, x.o), x);
    pos = x.o + x.l;
  }
  all.push(...autoLinks(text, pos));
  const parts: ReactNode[] = [];
  let at = 0;
  all.forEach((x, i) => {
    if (x.o < at) return;
    if (x.o > at) parts.push(text.slice(at, x.o));
    // only web and Telegram links become links (never javascript:, data: …),
    // also for a long-press "open" that skips the click handler
    if (!SAFE_LINK_RE.test(x.u)) {
      parts.push(text.slice(x.o, x.o + x.l));
      at = x.o + x.l;
      return;
    }
    parts.push(
      <a
        key={i}
        href={x.u}
        onClick={(e) => {
          e.preventDefault();
          haptic("light");
          openExternal(x.u);
        }}
        className="font-medium text-gold underline decoration-gold/40 underline-offset-2 break-all"
      >
        {text.slice(x.o, x.o + x.l)}
      </a>,
    );
    at = x.o + x.l;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
function PostView({ hit, onBack }: { hit: CheckData["channels"][number]; onBack: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [data, setData] = useState<PostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!hit.channelId || !hit.messageId) {
      setLoading(false);
      return;
    }
    void getPostDetail({ data: { initData: telegramInitData(), channelId: hit.channelId, messageId: hit.messageId } })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setData(r as PostData);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [hit]);

  const text = data?.text || hit.snippet;
  const date = fmtBlDate(locale, data?.date || hit.date);
  const wwh = isWWH(hit.channelTitle);
  const canLink = !wwh && /^https:\/\/t\.me\//i.test(hit.link);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onBack();
          }}
          className="flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
        >
          <ChevronLeft className="size-4" /> {t(locale, "back")}
        </button>
        <div className="flex items-center gap-2 text-danger">
          <ShieldAlert className="size-5 shrink-0" />
          <h2 className="font-display text-xl font-bold break-words">{data?.source || forumName(hit.channelTitle)}</h2>
        </div>
        {date ? <p className="-mt-2 text-xs text-subtle">{date}</p> : null}

        {loading ? (
          <div className="space-y-2">
            <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface/60" />
          </div>
        ) : null}

        {data?.photos.length ? (
          <div className={cn("grid gap-2", data.photos.length > 1 && "grid-cols-2")}>
            {data.photos.map((src, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setZoom(src)}
                className={cn(
                  "overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_rgba(243,239,228,0.08)]",
                  data.photos.length > 1 && data.photos.length % 2 === 1 && i === 0 && "col-span-2",
                )}
              >
                <img src={src} alt="" className="block max-h-[60vh] w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}
        {data?.more ? <p className="text-xs text-muted">{t(locale, "postMoreMedia", { n: data.more })}</p> : null}
        {data?.photosPending ? <p className="text-xs text-muted">{t(locale, "postPhotosLater")}</p> : null}

        {!loading && text ? (
          <div className="rounded-2xl bg-surface/70 p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              <LinkedText text={text} links={data?.text ? data.links : undefined} />
            </p>
          </div>
        ) : null}
        {!loading && failed && !text ? <p className="text-sm text-muted">{t(locale, "postGone")}</p> : null}

        {canLink ? (
          <Button
            variant="secondary"
            className="w-full rounded-xl"
            onClick={() => {
              haptic("light");
              openExternal(hit.link);
            }}
          >
            {t(locale, "postInChannel")} <ExternalLink className="ml-1 size-4" />
          </Button>
        ) : null}
      </div>
      {zoom ? (
        <button type="button" onClick={() => setZoom(null)} className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-3">
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-xl object-contain" />
        </button>
      ) : null}
    </div>
  );
}

function BlacklistRow({ account, sub, onClick, danger }: { account: string; sub?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-2xl bg-surface/70 p-3 text-left text-sm shadow-[0_0_0_1px_rgba(243,239,228,0.08)] hover:bg-surface"
    >
      <span className="min-w-0">
        <span className={cn("block truncate font-semibold", danger && "text-danger")}>{account}</span>
        {sub ? <span className="mt-0.5 block truncate text-xs text-muted">{sub}</span> : null}
      </span>
      <ChevronLeft className="size-4 shrink-0 rotate-180 text-subtle" />
    </button>
  );
}

function BlacklistDetail({ entry, onBack }: { entry: BlEntry; onBack: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const isManual = entry.kind === "manual";
  const isFind = entry.kind === "find";
  const isSimple = isManual || isFind; // no story to fetch
  // The list items are light; the EPB situation text is fetched when opened.
  const [full, setFull] = useState<BlEntry | null>(isSimple ? entry : null);
  const [loadingFull, setLoadingFull] = useState(!isSimple);

  useEffect(() => {
    if (isSimple) return;
    let cancelled = false;
    void getBlacklistEntry({ data: { id: entry.id, initData: telegramInitData() } })
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.entry) setFull({ ...entry, ...(r.entry as Partial<BlEntry>) });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingFull(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry, isSimple]);

  const shown = full || entry;
  const date = fmtBlDate(locale, shown.date);
  const situation = shown.story || shown.summary;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <button
          type="button"
          onClick={() => {
            haptic("light");
            onBack();
          }}
          className="flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
        >
          <ChevronLeft className="size-4" /> {t(locale, "back")}
        </button>
        <div className="flex items-center gap-2 text-danger">
          <ShieldAlert className="size-5 shrink-0" />
          <h2 className="font-display text-xl font-bold break-words">{shown.account || "—"}</h2>
        </div>

        {isSimple ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-surface/70 p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
              <p className="text-xs font-semibold text-gold">{shown.source || t(locale, "checkInExternal")}</p>
              <p className="mt-2 text-sm leading-relaxed">{t(locale, isFind ? "checkFoundDesc" : "checkExternalDesc")}</p>
              {shown.note ? <p className="mt-2 text-sm leading-relaxed text-muted">{shown.note}</p> : null}
            </div>
            <Button
              className="w-full rounded-xl"
              onClick={() => {
                haptic("light");
                openExternal(EUROPE_PROMO_URL);
              }}
            >
              {t(locale, "checkDispute")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-2xl bg-surface/70 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
              <p className="text-xs text-muted">
                {t(locale, "checkDamageLabel")}:{" "}
                <span className="font-semibold text-fg">
                  {shown.amount} {shown.currency}
                </span>
                {date ? ` · ${date}` : ""}
              </p>
            </div>
            {situation ? (
              <div className="space-y-1.5">
                <p className="text-sm font-bold">{t(locale, "checkSituation")}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">
                  <LinkedText text={situation} />
                </p>
              </div>
            ) : loadingFull ? (
              <p className="flex items-center gap-2 py-4 text-sm text-muted">
                <LoaderCircle className="size-4 animate-spin text-gold" />
                {t(locale, "checkChecking")}
              </p>
            ) : null}
            <a
              href={CHANNEL_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-gold underline underline-offset-4"
            >
              {t(locale, "subscribe")} <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryCard({ item }: { item: ComplaintHistoryItem }) {
  const locale = useBlacklistStore((s) => s.locale);
  const handle = item.scammerUsername
    ? item.scammerUsername
        .split(" · ")
        .map((u) => {
          const name = u.replace(/^@/, "").trim();
          return name ? `@${name}` : "";
        })
        .filter(Boolean)
        .join(" · ")
    : t(locale, "noUsername");
  const when = item.createdAt
    ? new Date(item.createdAt).toLocaleString(locale === "en" ? "en-GB" : "ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const statusLabel =
    item.status === "pending"
      ? t(locale, "statusPending")
      : item.status === "published"
        ? t(locale, "statusPublished")
        : t(locale, "statusRejected");
  return (
    <article className="rounded-2xl bg-surface px-4 py-3 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold leading-snug break-words">{handle}</p>
          <p className="mt-0.5 text-xs text-subtle break-words">
            {item.scammerId ? `Id: ${item.scammerId}` : "Id: -"}
            {item.amount ? ` · ${item.amount} ${item.currency}` : ""}
          </p>
          {when ? <p className="mt-1 text-xs text-subtle">{when}</p> : null}
          {item.status === "rejected" && item.rejectReason ? (
            <p className="mt-1.5 text-xs leading-snug break-words text-muted">
              {t(locale, "rejectReasonLabel")} {item.rejectReason}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
            item.status === "pending" && "bg-gold/15 text-gold",
            item.status === "published" && "bg-ok/15 text-ok",
            item.status === "rejected" && "bg-danger/15 text-danger",
          )}
        >
          {statusLabel}
        </span>
      </div>
    </article>
  );
}

function Done({
  onPage,
  onClose,
  onReview,
  notice,
}: {
  onPage: (page: MiniPage) => void;
  onClose?: () => void;
  onReview?: () => void;
  notice?: string;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-5 py-10 text-center [touch-action:pan-y]">
      <EuStarsLogo size={132} title="Europe Private Blacklist" spin emblem />
      <h2 className="mt-6 font-display text-2xl font-bold">{t(locale, "doneTitle")}</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
        {notice || t(locale, "doneText")}
      </p>
      <div className="mt-8 flex w-full max-w-md flex-col gap-3">
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            haptic("light");
            openExternal(EUROPE_PROMO_URL);
          }}
        >
          <span className="inline-flex items-center gap-2">
            {t(locale, "addEvidence")} <ExternalLink className="size-4" />
          </span>
        </Button>
        <Button size="lg" variant="secondary" className="w-full" onClick={() => onPage("home")}>
          {t(locale, "home")}
        </Button>
        {onClose ? (
          <Button size="lg" variant="ghost" className="w-full" onClick={onClose}>
            {t(locale, "closeApp")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
