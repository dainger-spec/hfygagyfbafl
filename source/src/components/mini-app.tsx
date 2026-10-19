import { useCallback, useEffect, useState } from "react";
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
  readTelegramWebUser,
  telegramInitData,
  waitForTelegramUser,
} from "@/lib/telegram";
import { checkCounterparty, getMyComplaints, saveUserLocale } from "@/lib/telegram-bot.functions";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";
import type { ComplaintHistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { hasSavedLocale, t, type Locale } from "@/lib/i18n";

export type MiniPage = "home" | "apply" | "history" | "done" | "owners" | "check";

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
          <Home identity={identity} onComplaint={openComplaint} onHistory={openHistory} onOwners={openOwners} onCheck={openCheck} />
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
        {showApp && page === "check" ? <CheckCounterparty /> : null}
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
  onCheck,
}: {
  identity: { username: string; firstName?: string; telegramId: string };
  onComplaint: () => void;
  onHistory: () => void;
  onOwners: () => void;
  onCheck: () => void;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const handle = identity.username
    ? `@${identity.username}`
    : identity.firstName || (identity.telegramId ? `ID ${identity.telegramId}` : "");
  const canUse = Boolean(identity.telegramId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 [touch-action:pan-y]">
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
          <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={onCheck} disabled={!canUse}>
            {t(locale, "checkBtn")}
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

type CheckData = {
  query: { username: string; id: string };
  epb: { id: string; accounts: string; amount: string; currency: string; date: number }[];
  channels: { channelTitle: string; link: string; date: number; snippet: string }[];
};

function CheckCounterparty() {
  const locale = useBlacklistStore((s) => s.locale);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<CheckData | null>(null);

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
        setData(res.result as CheckData);
        haptic(res.result.epb.length || res.result.channels.length ? "heavy" : "soft");
      } else {
        setError(t(locale, "checkFail"));
      }
    } catch {
      setError(t(locale, "checkFail"));
    } finally {
      setLoading(false);
    }
  }

  const found = data && (data.epb.length > 0 || data.channels.length > 0);
  const fmtDate = (ms: number) =>
    ms ? new Date(ms).toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";

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
                    <div
                      key={e.id}
                      className="rounded-2xl bg-surface/70 p-3 text-sm shadow-[0_0_0_1px_rgba(243,239,228,0.08)]"
                    >
                      <p className="font-semibold">{e.accounts || e.id}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {t(locale, "checkEpbItem", { id: e.id, amount: e.amount, currency: e.currency })}
                        {fmtDate(e.date) ? ` · ${fmtDate(e.date)}` : ""}
                      </p>
                    </div>
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
