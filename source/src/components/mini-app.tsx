import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, LoaderCircle } from "lucide-react";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { ApplyForm } from "@/components/apply-form";
import { Button } from "@/components/ui/button";
import {
  bootTelegramWebApp,
  CHANNEL_URL,
  lockTelegramViewport,
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

// Full-screen overlay: the emblem moves to the centre and grows with a golden glow, the
// stars fly apart, then everything dissolves into the complaint form.
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
  const callbacks = useRef({ onMidpoint, onDone });
  callbacks.current = { onMidpoint, onDone };

  useLayoutEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const e = start.emblem;
    // Biggest size that stays sharp: even at its final 1.08x the emblem never shows more
    // screen pixels than the image has.
    const grow = 1.08;
    const targetH = Math.max(
      e.height,
      Math.min(vh * 0.4, vw * 0.68 * (e.height / e.width), HERO_EMBLEM_PX / dpr / grow),
    );
    const scale = targetH / e.height;
    const dx = vw / 2 - (e.left + e.width / 2);
    const dy = vh * 0.44 - (e.top + e.height / 2);
    // Easing per step (an easing on the whole animation would squeeze the steps together).
    const glide = "cubic-bezier(.22,.9,.24,1)";
    const soft = "cubic-bezier(.45,0,.55,1)";
    const fadeOut = "cubic-bezier(.4,0,1,1)";
    const DURATION = 1150;
    const timing = { duration: DURATION, easing: "linear", fill: "forwards" as const };
    start.source.style.visibility = "hidden";

    const anims = [
      // Background: the home screen fades away, later the form shows through.
      shade.current!.animate(
        [
          { opacity: 0, easing: soft },
          { opacity: 1, offset: 0.26 },
          { opacity: 1, offset: 0.6, easing: soft },
          { opacity: 0 },
        ],
        timing,
      ),
      // Stars speed up and fly apart.
      ring.current!.animate(
        [
          { transform: `rotate(${start.angle}deg) scale(1)`, opacity: 1, easing: "cubic-bezier(.5,0,.75,0)" },
          { transform: `rotate(${start.angle + 70}deg) scale(1.15)`, opacity: 1, offset: 0.2, easing: "cubic-bezier(.25,.6,.3,1)" },
          { transform: `rotate(${start.angle + 240}deg) scale(3)`, opacity: 0, offset: 0.62 },
          { transform: `rotate(${start.angle + 240}deg) scale(3)`, opacity: 0 },
        ],
        timing,
      ),
      // The emblem glides to the centre and grows, holds a moment, then dissolves upwards.
      emblem.current!.animate(
        [
          { transform: "translate(0px,0px) scale(1)", filter: "drop-shadow(0 0 0px rgba(240,196,48,0))", opacity: 1, easing: glide },
          {
            transform: `translate(${dx}px,${dy}px) scale(${scale})`,
            filter: "drop-shadow(0 0 22px rgba(240,196,48,.55))",
            opacity: 1,
            offset: 0.46,
            easing: soft,
          },
          {
            transform: `translate(${dx}px,${dy}px) scale(${scale * 1.03})`,
            filter: "drop-shadow(0 0 30px rgba(240,196,48,.4))",
            opacity: 1,
            offset: 0.62,
            easing: fadeOut,
          },
          { transform: `translate(${dx}px,${dy - 18}px) scale(${scale * grow})`, filter: "drop-shadow(0 0 0px rgba(240,196,48,0))", opacity: 0 },
        ],
        timing,
      ),
      // Golden halo behind the emblem.
      glow.current!.animate(
        [
          { transform: "translate(-50%,-50%) scale(.2)", opacity: 0, easing: glide },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 0.9, offset: 0.46, easing: soft },
          { transform: "translate(-50%,-50%) scale(1.05)", opacity: 0.8, offset: 0.62, easing: fadeOut },
          { transform: "translate(-50%,-50%) scale(1.5)", opacity: 0 },
        ],
        timing,
      ),
    ];
    // Swap to the form while the overlay still covers the screen; on the same timeline as
    // the animations, so it always lands at the same moment.
    const mid = shade.current!.animate([], { duration: DURATION * 0.6 });
    let cancelled = false;
    void mid.finished.then(() => !cancelled && callbacks.current.onMidpoint()).catch(() => {});
    void Promise.all(anims.map((a) => a.finished))
      .then(() => !cancelled && callbacks.current.onDone())
      .catch(() => {});
    return () => {
      cancelled = true;
      mid.cancel();
      anims.forEach((a) => a.cancel());
      start.source.style.visibility = "";
    };
  }, [start]);

  const e = start.emblem;
  const r = start.ring;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden>
      <div ref={shade} className="absolute inset-0 bg-bg opacity-0" />
      <div
        ref={glow}
        className="absolute rounded-full opacity-0"
        style={{
          left: "50%",
          top: "44%",
          width: "min(110vw, 620px)",
          height: "min(110vw, 620px)",
          background: "radial-gradient(circle, rgba(240,196,48,.32) 0%, rgba(240,196,48,.10) 38%, rgba(240,196,48,0) 68%)",
        }}
      />
      <div
        ref={ring}
        className="absolute"
        style={{ left: r.left, top: r.top, width: r.width, height: r.height, transformOrigin: "50% 50%" }}
      >
        <EuStarsLogo size={r.width} />
      </div>
      <img
        ref={emblem}
        src={HERO_EMBLEM_HD}
        alt=""
        draggable={false}
        className="absolute select-none"
        style={{
          left: e.left,
          top: e.top,
          width: e.width,
          height: e.height,
          transformOrigin: "50% 50%",
          willChange: "transform, opacity, filter",
        }}
      />
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
