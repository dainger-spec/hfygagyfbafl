import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, LoaderCircle, X } from "lucide-react";
import { BrandLockup, EuStarsLogo } from "@/components/eu-stars-logo";
import { ApplyForm } from "@/components/apply-form";
import { Button } from "@/components/ui/button";
import {
  bootTelegramWebApp,
  lockTelegramViewport,
  readTelegramWebUser,
  waitForTelegramUser,
} from "@/lib/telegram";
import { getMyComplaints } from "@/lib/telegram-bot.functions";
import { rehydrateBlacklistStore, useBlacklistStore } from "@/lib/store";
import type { ComplaintHistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export type MiniPage = "home" | "apply" | "history" | "done";

const STATUS_LABEL: Record<ComplaintHistoryItem["status"], string> = {
  pending: "Подано",
  published: "Одобрено",
  rejected: "Отклонено",
};

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
  const identity = useBlacklistStore((s) => s.identity);
  const setIdentity = useBlacklistStore((s) => s.setIdentity);
  const title =
    page === "apply"
      ? "Подать жалобу"
      : page === "done"
        ? "Жалоба отправлена"
        : page === "history"
          ? "История жалоб"
          : "Europe Private Blacklist";

  const openComplaint = useCallback(() => onPage("apply"), [onPage]);
  const openHistory = useCallback(() => onPage("history"), [onPage]);

  useEffect(() => {
    rehydrateBlacklistStore();
    bootTelegramWebApp();
    const unlock = lockTelegramViewport();
    let cancelled = false;
    void (async () => {
      const user = (await waitForTelegramUser(4000)) || readTelegramWebUser();
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

  return (
    <div
      className={cn("flex flex-col overflow-hidden overscroll-none bg-bg text-fg", !embedded && "z-50")}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: "var(--app-top, 0px)",
        height: "var(--app-h, 100dvh)",
        maxHeight: "var(--app-h, 100dvh)",
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
        {page === "home" || !ready ? (
          <div className="flex h-11 flex-1 items-center px-2">
            <BrandLockup size={36} />
          </div>
        ) : (
          <>
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-md text-fg hover:bg-surface"
              onClick={() => onPage("home")}
              aria-label="Назад"
            >
              <ChevronLeft className="size-5" />
            </button>
            <p className="flex-1 font-display text-sm font-bold tracking-tight">{title}</p>
          </>
        )}
        {onClose ? (
          <button
            type="button"
            className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
            onClick={onClose}
            aria-label="Закрыть приложение"
          >
            <X className="size-5" />
          </button>
        ) : (
          <span className="size-11" />
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!ready ? <AccountLoading /> : null}
        {ready && page === "home" ? (
          <Home identity={identity} onComplaint={openComplaint} onHistory={openHistory} />
        ) : null}
        {ready && page === "apply" ? (
          <ApplyForm
            onSubmitted={(msg) => {
              setNotice(msg ?? "");
              onPage("done");
            }}
          />
        ) : null}
        {ready && page === "history" ? <History telegramId={identity.telegramId} /> : null}
        {ready && page === "done" ? (
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

function AccountLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
      <EuStarsLogo size={96} title="Europe Private Blacklist" />
      <LoaderCircle className="mt-8 size-8 animate-spin text-gold" />
      <p className="mt-4 font-display text-lg font-bold">Подключаем Telegram</p>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted">
        Подождите, подтягиваем ваш аккаунт. Это займёт пару секунд.
      </p>
    </div>
  );
}

function Home({
  identity,
  onComplaint,
  onHistory,
}: {
  identity: { username: string; firstName?: string; telegramId: string };
  onComplaint: () => void;
  onHistory: () => void;
}) {
  const handle = identity.username
    ? `@${identity.username}`
    : identity.firstName || (identity.telegramId ? `ID ${identity.telegramId}` : "");

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-8 text-center [touch-action:pan-y]">
      <EuStarsLogo size={104} title="Europe Private Blacklist" />
      <h1 className="mt-7 font-display text-3xl font-extrabold tracking-tight">
        Europe Private
        <span className="block text-gold">Blacklist</span>
      </h1>
      {handle ? (
        <p className="mt-4 text-xs text-subtle">
          Вы вошли как <span className="font-medium text-fg">{handle}</span>
        </p>
      ) : (
        <p className="mt-4 text-xs text-subtle">Откройте Mini App из бота Telegram, чтобы войти своим аккаунтом.</p>
      )}
      <div className="mt-8 flex w-full max-w-md flex-col gap-3">
        <Button size="lg" className="w-full rounded-xl" onClick={onComplaint} disabled={!identity.telegramId}>
          Подать жалобу
        </Button>
        <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={onHistory} disabled={!identity.telegramId}>
          История жалоб
        </Button>
      </div>
    </div>
  );
}

function History({ telegramId }: { telegramId: string }) {
  const [items, setItems] = useState<ComplaintHistoryItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!telegramId) {
        setItems([]);
        return;
      }
      try {
        const list = await getMyComplaints({ data: { telegramId } });
        if (!cancelled) setItems(list);
      } catch {
        if (!cancelled) setItems([]);
      }
    }
    void load();
    const t = window.setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [telegramId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
      <div className="mx-auto w-full max-w-md space-y-3">
        {items === null ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <LoaderCircle className="size-4 animate-spin text-gold" />
            Загружаем историю…
          </p>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">Пока нет поданных жалоб.</p>
        ) : (
          items.map((item) => <HistoryCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}

function HistoryCard({ item }: { item: ComplaintHistoryItem }) {
  const handle = item.scammerUsername
    ? item.scammerUsername
        .split(" · ")
        .map((u) => {
          const name = u.replace(/^@/, "").trim();
          return name ? `@${name}` : "";
        })
        .filter(Boolean)
        .join(" · ")
    : "без username";
  const when = item.createdAt
    ? new Date(item.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <article className="rounded-xl bg-surface px-4 py-3 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-sm font-bold leading-snug break-words">{handle}</p>
          <p className="mt-0.5 text-xs text-subtle break-words">
            {item.scammerId ? `Id: ${item.scammerId}` : "Id: —"}
            {item.amount ? ` · ${item.amount} ${item.currency}` : ""}
          </p>
          {when ? <p className="mt-1 text-xs text-subtle">{when}</p> : null}
        </div>
        <StatusBadge status={item.status} />
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: ComplaintHistoryItem["status"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide",
        status === "pending" && "bg-gold/15 text-gold",
        status === "published" && "bg-ok/15 text-ok",
        status === "rejected" && "bg-danger/15 text-danger",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
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
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-10 text-center [touch-action:pan-y]">
      <div className="flex size-16 items-center justify-center rounded-full bg-gold text-gold-fg">
        <EuStarsLogo size={40} className="text-gold-fg" />
      </div>
      <h2 className="mt-6 font-display text-2xl font-bold">Жалоба у арбитров</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
        {notice ||
          "Материалы ушли в закрытый чат. Если кейс подтвердят — карточка выйдет в канал. Если нет — публикации не будет."}
      </p>
      <div className="mt-8 flex w-full max-w-md flex-col gap-3">
        {onReview ? (
          <Button size="lg" className="w-full rounded-xl" onClick={onReview}>
            Открыть чат арбитров
          </Button>
        ) : (
          <Button size="lg" className="w-full rounded-xl" onClick={() => onPage("history")}>
            История жалоб
          </Button>
        )}
        <Button size="lg" variant="secondary" className="w-full rounded-xl" onClick={() => onPage("home")}>
          На главную
        </Button>
        {onClose ? (
          <Button size="lg" variant="ghost" className="w-full" onClick={onClose}>
            Закрыть приложение
          </Button>
        ) : null}
      </div>
    </div>
  );
}
