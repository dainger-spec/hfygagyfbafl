import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ExternalLink, LoaderCircle, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { ApplyForm } from "@/components/apply-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  bootTelegramWebApp,
  CHANNEL_URL,
  lockTelegramViewport,
  haptic,
  openExternal,
  readTelegramWebUser,
  telegramInitData,
  waitForTelegramUser,
} from "@/lib/telegram";
import { checkCounterparty, getBanners, getBlacklistEntry, getFeatures, getMyComplaints, getRecentBlacklist, getSponsors, saveUserLocale } from "@/lib/telegram-bot.functions";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";
import type { ComplaintHistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { hasSavedLocale, t, type Locale } from "@/lib/i18n";

export type MiniPage = "home" | "apply" | "history" | "done" | "owners" | "check" | "sponsors";

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
  const [introDone, setIntroDone] = useState(false);
  const onIntroDone = useCallback(() => setIntroDone(true), []);
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
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
      unlock();
    };
  }, [setIdentity]);

  const showLang = ready && langPicked === false;
  const showApp = ready && langPicked === true;


  return (
    <div
      className={cn("relative flex flex-col overflow-hidden overscroll-none bg-bg text-fg", !embedded && "z-50")}
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
      {showApp && page !== "home" ? (
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

      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", showApp && page !== "home" && "pt-10")}>
        {!showApp && !showLang ? <AccountLoading locale={locale} /> : null}
        {showLang ? <LanguageGate onPicked={() => setLangPicked(true)} /> : null}
        {showApp && page === "home" ? (
          <Home identity={identity} onComplaint={openComplaint} onHistory={openHistory} onOwners={openOwners} onCheck={openCheck} onSponsors={openSponsors} checkOn={checkOn} />
        ) : null}
        {showApp && page === "apply" ? (
          <ApplyForm
            onSubmitted={(msg) => {
              setNotice(msg ?? "");
              onPage("done");
            }}
          />
        ) : null}
        {showApp && page === "history" ? <History telegramId={identity.telegramId} /> : null}
        {showApp && page === "check" && checkOn ? <CheckCounterparty /> : null}
        {showApp && page === "owners" ? <OwnersGuide /> : null}
        {showApp && page === "sponsors" ? <SponsorsPage /> : null}
        {showApp && page === "done" ? (
          <Done
            onPage={onPage}
            onClose={onClose}
            onReview={onReview}
            notice={notice}
          />
        ) : null}
      </div>

      {!introDone ? <IntroSplash ready={ready} onDone={onIntroDone} /> : null}
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
      <h1 className="mt-7 font-display text-3xl font-extrabold tracking-tight">
        Europe Private
        <span className="block text-gold">Blacklist</span>
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
function IntroSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [size, setSize] = useState(280);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    try {
      setSize(Math.round(Math.min(window.innerWidth * 0.68, 320)));
    } catch {
      /* keep default */
    }
    // Never let the splash stick if the account never resolves.
    const hard = setTimeout(() => setLeaving(true), 2800);
    return () => clearTimeout(hard);
  }, []);

  // Hold a minimum time so it never just flashes, then start the exit.
  useEffect(() => {
    if (!ready) return;
    const wait = Math.max(0, 1100 - (Date.now() - startedAt.current));
    const t = setTimeout(() => setLeaving(true), wait);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!leaving) return;
    try {
      haptic("soft");
    } catch {
      /* ignore */
    }
    const t = setTimeout(onDone, 480);
    return () => clearTimeout(t);
  }, [leaving, onDone]);

  return (
    <div
      className={cn("epb-intro-overlay", leaving && "epb-intro-overlay--leaving")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg)",
        paddingTop: "var(--tg-safe-top, 0px)",
      }}
      aria-hidden
    >
      <div className="epb-intro-emblem relative flex items-center justify-center">
        <span className="epb-intro-glow" />
        <EuStarsLogo size={size} spin emblem />
      </div>
      <h1 className="epb-intro-title mt-9 text-center font-display text-4xl font-extrabold leading-tight tracking-tight">
        Europe Private
        <span className="block text-gold">Blacklist</span>
      </h1>
    </div>
  );
}

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

// Promo banners at the very top of the app. A horizontal, swipeable strip;
// videos and GIFs play muted and looped; a tap opens the banner's link.
function Banners() {
  const [items, setItems] = useState<BannerItem[]>([]);
  const [active, setActive] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getBanners()
      .then((list) => setItems(Array.isArray(list) ? (list as BannerItem[]) : []))
      .catch(() => {});
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

type TickerItem = { id: string; account: string; amount?: string; currency?: string; source?: string };

// Yellow running line on the home screen: up to 7 recent blacklists.
function BlacklistTicker({ onOpen }: { onOpen?: () => void }) {
  const [items, setItems] = useState<TickerItem[]>([]);
  useEffect(() => {
    void getRecentBlacklist({ data: { initData: telegramInitData() } })
      .then((r) => {
        if (r.ok) setItems((r.items as TickerItem[]).slice(0, 7));
      })
      .catch(() => {});
  }, []);
  if (!items.length) return null;

  const label = (e: TickerItem) => {
    const amt = `${e.amount || ""} ${e.currency || ""}`.trim();
    return `${e.account}${amt ? ` — ${amt}` : e.source ? ` — ${e.source}` : ""}`;
  };
  const Seq = () => (
    <>
      {items.map((e) => (
        <span key={e.id} className="inline-flex items-center">
          <span>{label(e)}</span>
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
      aria-label="recent blacklists"
      className="group relative mt-3 flex w-full items-center overflow-hidden rounded-xl bg-surface/60 py-2 shadow-[0_0_0_1px_rgba(240,196,48,0.14)]"
      style={{ "--epb-marquee-dur": `${Math.max(18, items.length * 5)}s` } as CSSProperties}
    >
      <div className="epb-marquee-track text-sm font-semibold tracking-tight text-gold">
        <Seq />
        <Seq />
      </div>
      {/* Soft fade at both edges. */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg to-transparent" />
    </button>
  );
}

function Home({
  identity,
  onComplaint,
  onHistory,
  onOwners,
  onCheck,
  onSponsors,
  checkOn,
}: {
  identity: { username: string; firstName?: string; telegramId: string };
  onComplaint: () => void;
  onHistory: () => void;
  onOwners: () => void;
  onCheck: () => void;
  onSponsors: () => void;
  checkOn: boolean;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const handle = identity.username
    ? `@${identity.username}`
    : identity.firstName || (identity.telegramId ? `ID ${identity.telegramId}` : "");
  const canUse = Boolean(identity.telegramId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 [touch-action:pan-y]">
      <Banners />
      <div className="mx-auto w-full max-w-md">
        <BlacklistTicker onOpen={checkOn ? onCheck : undefined} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <LangSwitch />
        <EuStarsLogo size={128} title="Europe Private Blacklist" spin emblem className="mt-5" />
        <h1 className="mt-7 font-display text-3xl font-extrabold tracking-tight">
          Europe Private
          <span className="block text-gold">Blacklist</span>
        </h1>
        {handle ? (
          <p className="mt-4 text-xs text-subtle">
            {t(locale, "signedIn")} <span className="font-medium text-fg">{handle}</span>
          </p>
        ) : (
          <p className="mt-4 text-xs text-subtle">{t(locale, "openFromBot")}</p>
        )}
        <div className="mt-8 flex w-full max-w-md flex-col gap-3">
          <Button size="lg" className="w-full rounded-xl" onClick={onComplaint} disabled={!canUse}>
            {t(locale, "fileComplaint")}
          </Button>
          {checkOn ? (
            <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={onCheck} disabled={!canUse}>
              {t(locale, "checkBtn")}
            </Button>
          ) : null}
          <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={onHistory} disabled={!canUse}>
            {t(locale, "history")}
          </Button>
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
      <div className="mx-auto w-full max-w-md">
        <SponsorsTicker onOpen={onSponsors} />
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

// Yellow running line at the bottom of the home screen: the broadcast sponsors.
function SponsorsTicker({ onOpen }: { onOpen?: () => void }) {
  const locale = useBlacklistStore((s) => s.locale);
  const [items, setItems] = useState<{ id: string; title: string; link: string }[]>([]);
  useEffect(() => {
    void getSponsors()
      .then((s) => setItems(Array.isArray(s) ? s : []))
      .catch(() => {});
  }, []);
  if (!items.length) return null;

  const Seq = () => (
    <>
      <span className="inline-flex items-center">
        <span className="text-gold/70">{t(locale, "sponsorsTitle")}</span>
        <span className="mx-3 text-gold/40">·</span>
      </span>
      {items.map((s) => (
        <span key={s.id} className="inline-flex items-center">
          <span>{s.title}</span>
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
      style={{ "--epb-marquee-dur": `${Math.max(18, items.length * 5)}s` } as CSSProperties}
    >
      <div className="epb-marquee-track text-sm font-semibold tracking-tight text-gold">
        <Seq />
        <Seq />
      </div>
      <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg to-transparent" />
    </button>
  );
}

function SponsorsPage() {
  const locale = useBlacklistStore((s) => s.locale);
  const [items, setItems] = useState<{ id: string; title: string; link: string }[] | null>(null);
  useEffect(() => {
    void getSponsors()
      .then((s) => setItems(Array.isArray(s) ? s : []))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <h2 className="font-display text-xl font-bold">{t(locale, "sponsorsTitle")}</h2>
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
                  className="flex w-full items-center justify-between gap-2 rounded-2xl bg-surface/70 p-3 text-left shadow-[0_0_0_1px_rgba(243,239,228,0.08)] hover:bg-surface"
                >
                  <span className="truncate font-semibold text-gold">{s.title}</span>
                  <ExternalLink className="size-4 shrink-0 text-gold" />
                </button>
              ) : (
                <div
                  key={s.id}
                  className="rounded-2xl bg-surface/70 p-3 font-semibold shadow-[0_0_0_1px_rgba(243,239,228,0.08)]"
                >
                  {s.title}
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
};

type CheckData = {
  query: { username: string; id: string };
  epb: { id: string; accounts: string; amount: string; currency: string; date: number }[];
  channels: { channelTitle: string; link: string; date: number; snippet: string }[];
  manual: { id: string; account: string; source: string; note?: string; date: number }[];
};

const RECENT_CACHE_KEY = "epb-recent-bl";

const EUROPE_PROMO_URL = "https://t.me/EuropePromo";

const fmtBlDate = (locale: Locale, ms: number) =>
  ms ? new Date(ms).toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";

function CheckCounterparty() {
  const locale = useBlacklistStore((s) => s.locale);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<CheckData | null>(null);
  // Show the cached list instantly, then refresh it in the background.
  const [recent, setRecent] = useState<BlEntry[]>(() => {
    try {
      const raw = sessionStorage.getItem(RECENT_CACHE_KEY);
      return raw ? (JSON.parse(raw) as BlEntry[]) : [];
    } catch {
      return [];
    }
  });
  const [recentLoading, setRecentLoading] = useState(recent.length === 0);
  const [detail, setDetail] = useState<BlEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRecentBlacklist({ data: { initData: telegramInitData() } })
      .then((r) => {
        if (cancelled || !r.ok) return;
        const items = r.items as BlEntry[];
        setRecent(items);
        try {
          sessionStorage.setItem(RECENT_CACHE_KEY, JSON.stringify(items));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRecentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    const input = value.trim();
    if (!input) {
      setError(t(locale, "checkEmptyInput"));
      return;
    }
    haptic("light");
    setError("");
    setLoading(true);
    setData(null);
    try {
      const res = await checkCounterparty({ data: { input, initData: telegramInitData() } });
      if (res.ok) {
        const r = res.result as CheckData;
        setData(r);
        haptic(r.epb.length || r.channels.length || (r.manual?.length ?? 0) ? "heavy" : "soft");
      } else {
        setError(t(locale, "checkFail"));
      }
    } catch {
      setError(t(locale, "checkFail"));
    } finally {
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

  const found = data && (data.epb.length > 0 || data.channels.length > 0 || (data.manual?.length ?? 0) > 0);
  const fmtDate = (ms: number) => fmtBlDate(locale, ms);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-xl font-bold">{t(locale, "checkTitle")}</h2>
          <p className="text-sm text-muted">{t(locale, "checkHint")}</p>
        </div>
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
        {loading ? (
          <p className="flex items-center gap-2 py-10 text-sm text-muted">
            <LoaderCircle className="size-4 animate-spin text-gold" />
            {t(locale, "checkChecking")}
          </p>
        ) : null}

        {data && !loading ? (
          found ? (
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
                    {t(locale, "checkInChannels")}
                  </div>
                  {data.channels.map((c, i) => (
                    <a
                      key={i}
                      href={c.link}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-2xl bg-surface/70 p-3 text-sm shadow-[0_0_0_1px_rgba(243,239,228,0.08)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold">{c.channelTitle}</p>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-gold">
                          {t(locale, "checkOpen")} <ExternalLink className="size-3" />
                        </span>
                      </div>
                      {c.snippet ? <p className="mt-1 text-xs leading-relaxed text-muted">{c.snippet}</p> : null}
                      {fmtDate(c.date) ? <p className="mt-1 text-[11px] text-subtle">{fmtDate(c.date)}</p> : null}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <ShieldCheck className="size-10 text-ok" />
              <p className="font-display text-lg font-bold">{t(locale, "checkClean")}</p>
              <p className="max-w-xs text-sm leading-relaxed text-muted">{t(locale, "checkCleanHint")}</p>
            </div>
          )
        ) : null}

        {!data && !loading && (recent.length || recentLoading) ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 text-sm font-bold text-muted">
              <ShieldAlert className="size-4" />
              {t(locale, "checkRecent")}
            </div>
            {recentLoading && !recent.length
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-[52px] animate-pulse rounded-2xl bg-surface/60" />
                ))
              : null}
            {recent.map((e) => (
              <BlacklistRow
                key={e.id}
                account={e.account || "—"}
                sub={
                  e.kind === "manual"
                    ? e.source || t(locale, "checkInExternal")
                    : `${e.amount || ""} ${e.currency || ""}`.trim() + (fmtDate(e.date) ? ` · ${fmtDate(e.date)}` : "")
                }
                danger={e.kind === "epb"}
                onClick={() => open(e)}
              />
            ))}
          </div>
        ) : null}
      </div>
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
  // The list items are light; the EPB situation text is fetched when opened.
  const [full, setFull] = useState<BlEntry | null>(isManual ? entry : null);
  const [loadingFull, setLoadingFull] = useState(!isManual);

  useEffect(() => {
    if (isManual) return;
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
  }, [entry, isManual]);

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

        {isManual ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-surface/70 p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
              <p className="text-xs font-semibold text-gold">{shown.source || t(locale, "checkInExternal")}</p>
              <p className="mt-2 text-sm leading-relaxed">{t(locale, "checkExternalDesc")}</p>
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
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{situation}</p>
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
      <div className="flex size-16 items-center justify-center rounded-full bg-gold text-gold-fg">
        <EuStarsLogo size={40} className="text-gold-fg" />
      </div>
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
        {onReview ? (
          <Button size="lg" variant="secondary" className="w-full" onClick={onReview}>
            {t(locale, "history")}
          </Button>
        ) : (
          <Button size="lg" variant="secondary" className="w-full" onClick={() => onPage("history")}>
            {t(locale, "history")}
          </Button>
        )}
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
