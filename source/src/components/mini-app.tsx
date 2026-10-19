import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, LoaderCircle } from "lucide-react";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { ApplyForm } from "@/components/apply-form";
import { Button } from "@/components/ui/button";
import {
  bootTelegramWebApp,
  CHANNEL_URL,
  lockTelegramViewport,
  haptic,
  readTelegramWebUser,
  telegramInitData,
  waitForTelegramUser,
} from "@/lib/telegram";
import { getMyComplaints, saveUserLocale } from "@/lib/telegram-bot.functions";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";
import type { ComplaintHistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { hasSavedLocale, t, type Locale } from "@/lib/i18n";

export type MiniPage = "home" | "apply" | "history" | "done" | "owners";

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

  // "Подать жалобу": the emblem flies out of the logo, then the form slides in.
  const [hero, setHero] = useState<HeroStart | null>(null);
  const [enterForm, setEnterForm] = useState(false);
  const openComplaint = useCallback(() => {
    if (hero) return;
    const start = measureHero();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!start || reduce || typeof Element.prototype.animate !== "function") {
      onPage("apply");
      return;
    }
    haptic("medium");
    setHero(start);
  }, [hero, onPage]);
  const openHistory = useCallback(() => onPage("history"), [onPage]);
  const openOwners = useCallback(() => onPage("owners"), [onPage]);

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
          <Home identity={identity} onComplaint={openComplaint} onHistory={openHistory} onOwners={openOwners} />
        ) : null}
        {showApp && page === "apply" ? (
          <div
            className={cn("flex min-h-0 flex-1 flex-col", enterForm && "epb-page-enter")}
            onAnimationEnd={() => setEnterForm(false)}
          >
            <ApplyForm
              onSubmitted={(msg) => {
                setNotice(msg ?? "");
                onPage("done");
              }}
            />
          </div>
        ) : null}
        {showApp && page === "history" ? <History telegramId={identity.telegramId} /> : null}
        {showApp && page === "owners" ? <OwnersGuide /> : null}
        {showApp && page === "done" ? (
          <Done
            onPage={onPage}
            onClose={onClose}
            onReview={onReview}
            notice={notice}
          />
        ) : null}
      </div>
      {hero ? (
        <HeroTransition
          start={hero}
          onMidpoint={() => {
            setEnterForm(true);
            onPage("apply");
          }}
          onDone={() => setHero(null)}
        />
      ) : null}
    </div>
  );
}

type HeroStart = { emblem: DOMRect; ring: DOMRect; angle: number; source: HTMLElement };

function measureHero(): HeroStart | null {
  const source = document.querySelector<HTMLElement>("[data-epb-hero]");
  const img = source?.querySelector("img");
  const svg = source?.querySelector("svg");
  if (!source || !img || !svg) return null;
  const emblem = img.getBoundingClientRect();
  // The spinning svg's box grows while rotated: use the un-rotated wrapper for the ring.
  const ring = source.firstElementChild!.getBoundingClientRect();
  if (!emblem.width || !ring.width) return null;
  // Current angle of the spinning stars, so the flying ring starts exactly where it is.
  let angle = 0;
  try {
    const m = new DOMMatrixReadOnly(getComputedStyle(svg).transform);
    angle = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  } catch {
    /* no transform */
  }
  return { emblem, ring, angle, source };
}

const HERO_EMBLEM_HD = "/brand/emblem-hd.webp";
// Native height of emblem-hd.webp: the emblem never grows past it on screen.
const HERO_EMBLEM_PX = 746;

// Full-screen overlay for "Подать жалобу":
//  1. the emblem glides from the logo to the centre and settles with a short breath, the
//     stars fade out where they are;
//  2. the medal's yellow, with the same rim as the artwork (yellow line, dark line), opens
//     from under the emblem past the screen edges while the face fades out in place;
//  3. the yellow screen lifts like a curtain, its lower edge drawn as the same rim, and
//     the form is underneath.
// The emblem is laid out at its final size and starts scaled down, so the browser draws it
// at full resolution and only ever shrinks it; it is never shown bigger than its pixels.
// The oval and the curtain are plain shapes (clip-path / box), sharp at any size.
const MEDAL_YELLOW = "#FED001";
// Rim of the artwork, as parts of the emblem height: outer yellow line, then dark line.
const MEDAL_RIM = 10 / 740;
const MEDAL_GAP = 11 / 740;

function HeroTransition({
  start,
  onMidpoint,
  onDone,
}: {
  start: HeroStart;
  onMidpoint: () => void;
  onDone: () => void;
}) {
  const shade = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const emblem = useRef<HTMLImageElement>(null);
  const rim = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const curtain = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onMidpoint, onDone });
  callbacks.current = { onMidpoint, onDone };

  // Final geometry, computed once.
  const [geo] = useState(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const e = start.emblem;
    const breath = 1.025;
    // Big, but never more screen pixels than the image has (also during the breath).
    const h = Math.max(e.height, Math.min(vh * 0.42, vw * 0.7 * (e.height / e.width), HERO_EMBLEM_PX / dpr / breath));
    const w = h * (e.width / e.height);
    const cx = vw / 2;
    const cy = vh * 0.45;
    return { vw, vh, h, w, cx, cy, breath, from: e.height / h };
  });

  useLayoutEffect(() => {
    const { vw, vh, h, w, cx, cy, breath, from } = geo;
    const e = start.emblem;
    const sx = e.left + e.width / 2 - cx;
    const sy = e.top + e.height / 2 - cy;
    const a = w / 2;
    const b = h / 2;
    const r = h * MEDAL_RIM;
    const g = h * MEDAL_GAP;
    // How much the oval must grow so its yellow field covers every corner of the screen.
    const kEnd =
      Math.max(...[[0, 0], [vw, 0], [0, vh], [vw, vh]].map(([x, y]) => Math.hypot((x! - cx) / (a - r - g), (y! - cy) / (b - r - g)))) * 1.03;
    const oval = (k: number, inset: number) =>
      `ellipse(${(k * (a - inset)).toFixed(1)}px ${(k * (b - inset)).toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px)`;

    const DURATION = 1550;
    const ARRIVE = 0.3; // emblem in the centre
    const OPEN = 0.41; // yellow starts to open
    const FULL = 0.64; // screen fully yellow -> the form is put underneath
    const LIFT = 0.67; // curtain starts to rise
    const glide = "cubic-bezier(.2,.85,.25,1)";
    const soft = "cubic-bezier(.45,0,.55,1)";
    const open = "cubic-bezier(.62,0,.78,.38)";
    const curtainEase = "cubic-bezier(.75,0,.25,1)";
    const timing = { duration: DURATION, easing: "linear", fill: "forwards" as const };
    start.source.style.visibility = "hidden";

    const widen = (el: HTMLDivElement, inset: number) =>
      el.animate(
        [
          { clipPath: oval(1, inset), opacity: 0 },
          { clipPath: oval(1, inset), opacity: 0, offset: OPEN - 0.001 },
          { clipPath: oval(1, inset), opacity: 1, offset: OPEN, easing: open },
          { clipPath: oval(kEnd, inset), opacity: 1, offset: FULL },
          { clipPath: oval(kEnd, inset), opacity: 1, offset: LIFT - 0.001 },
          { clipPath: oval(kEnd, inset), opacity: 0, offset: LIFT },
          { clipPath: oval(kEnd, inset), opacity: 0 },
        ],
        timing,
      );

    const anims = [
      shade.current!.animate(
        [
          { opacity: 0, easing: soft },
          { opacity: 1, offset: 0.22 },
          { opacity: 1, offset: LIFT - 0.001 },
          { opacity: 0, offset: LIFT },
          { opacity: 0 },
        ],
        timing,
      ),
      // Stars keep turning in place and fade out.
      ring.current!.animate(
        [
          { transform: `rotate(${start.angle}deg)`, opacity: 1 },
          { transform: `rotate(${start.angle + 22}deg)`, opacity: 0, offset: 0.22 },
          { transform: `rotate(${start.angle + 22}deg)`, opacity: 0 },
        ],
        timing,
      ),
      emblem.current!.animate(
        [
          { transform: `translate(${sx}px,${sy}px) scale(${from})`, opacity: 1, easing: glide },
          { transform: "translate(0px,0px) scale(1)", opacity: 1, offset: ARRIVE, easing: soft },
          { transform: `translate(0px,0px) scale(${breath})`, opacity: 1, offset: (ARRIVE + OPEN) / 2, easing: soft },
          { transform: "translate(0px,0px) scale(1)", opacity: 1, offset: OPEN, easing: "cubic-bezier(.4,0,.9,.6)" },
          { transform: "translate(0px,0px) scale(1)", opacity: 0, offset: OPEN + 0.12 },
          { transform: "translate(0px,0px) scale(1)", opacity: 0 },
        ],
        timing,
      ),
      glow.current!.animate(
        [
          { transform: "translate(-50%,-50%) scale(.35)", opacity: 0, easing: glide },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0.85, offset: ARRIVE, easing: soft },
          { transform: "translate(-50%,-50%) scale(1.06)", opacity: 1, offset: (ARRIVE + OPEN) / 2, easing: soft },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0.8, offset: OPEN },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0, offset: OPEN + 0.1 },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
        ],
        timing,
      ),
      widen(rim.current!, 0),
      widen(gap.current!, r),
      widen(field.current!, r + g),
      // The yellow screen rises like a curtain; its lower edge carries the medal's rim.
      curtain.current!.animate(
        [
          { transform: "translateY(0%)", opacity: 0 },
          { transform: "translateY(0%)", opacity: 0, offset: LIFT - 0.001 },
          { transform: "translateY(0%)", opacity: 1, offset: LIFT, easing: curtainEase },
          { transform: "translateY(-102%)", opacity: 1 },
        ],
        timing,
      ),
    ];

    // Moments on the same timeline: the page switch and the vibrations always line up with
    // what is on screen.
    let cancelled = false;
    const at = (part: number, fn: () => void) => {
      const tick = shade.current!.animate([], { duration: DURATION * part });
      void tick.finished.then(() => !cancelled && fn()).catch(() => {});
      return tick;
    };
    const ticks = [
      at(ARRIVE, () => haptic("light")),
      at(FULL, () => {
        haptic("rigid");
        callbacks.current.onMidpoint();
      }),
    ];
    void Promise.all(anims.map((x) => x.finished))
      .then(() => !cancelled && callbacks.current.onDone())
      .catch(() => {});
    return () => {
      cancelled = true;
      ticks.forEach((x) => x.cancel());
      anims.forEach((x) => x.cancel());
      start.source.style.visibility = "";
    };
  }, [start, geo]);

  const rr = start.ring;
  const layer = "absolute inset-0 opacity-0";
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      <div ref={shade} className="absolute inset-0 bg-bg opacity-0" />
      <div
        ref={glow}
        className="absolute rounded-full opacity-0"
        style={{
          left: geo.cx,
          top: geo.cy,
          width: geo.h * 2.2,
          height: geo.h * 2.2,
          background: "radial-gradient(circle, rgba(254,208,1,.30) 0%, rgba(254,208,1,.10) 40%, rgba(254,208,1,0) 70%)",
        }}
      />
      <div
        ref={ring}
        className="absolute"
        style={{ left: rr.left, top: rr.top, width: rr.width, height: rr.height, transformOrigin: "50% 50%" }}
      >
        <EuStarsLogo size={rr.width} />
      </div>
      <div ref={rim} className={layer} style={{ background: MEDAL_YELLOW }} />
      <div ref={gap} className={layer} style={{ background: "#080808" }} />
      <div ref={field} className={layer} style={{ background: MEDAL_YELLOW }} />
      {/* Laid out at the final size: drawn at full resolution, only ever scaled down. */}
      <img
        ref={emblem}
        src={HERO_EMBLEM_HD}
        alt=""
        draggable={false}
        decoding="sync"
        className="absolute select-none"
        style={{
          left: geo.cx - geo.w / 2,
          top: geo.cy - geo.h / 2,
          width: geo.w,
          height: geo.h,
          transformOrigin: "50% 50%",
        }}
      />
      <div ref={curtain} className="absolute inset-0 opacity-0" style={{ background: MEDAL_YELLOW }}>
        <div
          className="absolute inset-x-0"
          style={{
            bottom: -(geo.h * (MEDAL_RIM + MEDAL_GAP)),
            height: geo.h * (MEDAL_RIM + MEDAL_GAP),
            background: `linear-gradient(#080808 0 ${(MEDAL_GAP / (MEDAL_RIM + MEDAL_GAP)) * 100}%, ${MEDAL_YELLOW} 0)`,
          }}
        />
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

function AccountLoading({ locale }: { locale: Locale }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
      <EuStarsLogo size={120} title="Europe Private Blacklist" spin emblem />
      <p className="mt-6 font-display text-lg font-bold">{t(locale, "loadingTitle")}</p>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted">{t(locale, "loadingText")}</p>
    </div>
  );
}

function Home({
  identity,
  onComplaint,
  onHistory,
  onOwners,
}: {
  identity: { username: string; firstName?: string; telegramId: string };
  onComplaint: () => void;
  onHistory: () => void;
  onOwners: () => void;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  // Load the sharp emblem in advance, so the transition never shows a blurry frame.
  useEffect(() => {
    const img = new Image();
    img.src = HERO_EMBLEM_HD;
    void img.decode?.().catch(() => {});
  }, []);
  const handle = identity.username
    ? `@${identity.username}`
    : identity.firstName || (identity.telegramId ? `ID ${identity.telegramId}` : "");
  const canUse = Boolean(identity.telegramId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 [touch-action:pan-y]">
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <LangSwitch />
        <div data-epb-hero className="mt-5">
          <EuStarsLogo size={128} title="Europe Private Blacklist" spin emblem />
        </div>
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
      <button
        type="button"
        onClick={onOwners}
        className="mx-auto mb-5 text-sm font-medium text-muted underline underline-offset-4"
      >
        {t(locale, "ownersLink")}
      </button>
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
        {onReview ? (
          <Button size="lg" className="w-full" onClick={onReview}>
            {t(locale, "history")}
          </Button>
        ) : (
          <Button size="lg" className="w-full" onClick={() => onPage("history")}>
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
