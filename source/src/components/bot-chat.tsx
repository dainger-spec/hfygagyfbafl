import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { Button } from "@/components/ui/button";
import { CHANNEL_NAME, CHANNEL_URL } from "@/lib/telegram";
import { getTelegramStatus } from "@/lib/telegram-bot.functions";
import { useBlacklistStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export function BotChat({
  onOpenApp,
  onBack,
}: {
  onOpenApp: () => void;
  onBack?: () => void;
}) {
  const hydrated = useHydrated();
  const identity = useBlacklistStore((s) => s.identity);
  const applications = useBlacklistStore((s) => s.applications);
  const mine = hydrated
    ? applications.filter(
        (a) =>
          a.id !== "EPB-SEED" &&
          (a.victim.telegramId === identity.telegramId ||
            a.victim.username.toLowerCase() === identity.username.toLowerCase()),
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <ChatHeader
        title="EPB Bot"
        subtitle="бот · Europe Private Blacklist"
        onBack={onBack}
        avatar={<EuStarsLogo size={22} />}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 md:px-6">
        <TelegramLiveStatus />
        <BotBubble>
          <p>Привет.</p>
          <p className="mt-2">
            Это бот <span className="font-semibold text-gold">{CHANNEL_NAME}</span> - закрытого
            европейского блеклиста.
          </p>
        </BotBubble>
        <BotBubble>
          <p className="font-medium text-fg">Как это работает</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-muted">
            <li>
              Открываете Mini App, входите через Telegram. На главной - «Подать жалобу».
            </li>
            <li>
              Прикладываете скрины и видео, описываете схему, указываете сумму ущерба и Telegram
              аккаунт. ID подтянется сам. Ваш @username нужен, чтобы арбитры могли связаться.
            </li>
            <li>Заявка уходит в закрытый чат арбитрам.</li>
            <li>
              Одобрили - пост публикуется в{" "}
              <a
                href={CHANNEL_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-gold underline-offset-2 hover:underline"
              >
                канале
              </a>
              . Отклонили - ничего не выходит.
            </li>
          </ol>
        </BotBubble>
        <BotBubble>
          <p>Открывайте приложение, если есть подтверждённый кейс.</p>
          <button
            type="button"
            onClick={onOpenApp}
            className="mt-3 flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3 text-left shadow-[0_0_0_1px_rgba(240,196,48,0.28)] transition-colors duration-150 hover:bg-surface"
          >
            <span className="flex size-11 items-center justify-center rounded-lg bg-bg">
              <EuStarsLogo size={28} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">Mini App</span>
              <span className="block font-semibold text-fg">Europe Private Blacklist</span>
            </span>
          </button>
        </BotBubble>

        {mine.map((app) => (
          <BotBubble key={app.id}>
            {app.status === "pending" ? (
              <p>
                Заявка <span className="font-medium text-fg">{app.id}</span> принята. Арбитры смотрят
                материалы.
              </p>
            ) : null}
            {app.status === "published" ? (
              <p>
                Заявка <span className="font-medium text-fg">{app.id}</span> опубликована в канале{" "}
                {CHANNEL_NAME}.
              </p>
            ) : null}
            {app.status === "rejected" ? (
              <p>
                Заявка <span className="font-medium text-fg">{app.id}</span> отклонена. В канал ничего
                не ушло.
              </p>
            ) : null}
          </BotBubble>
        ))}
      </div>
      <div className="border-t border-line bg-bg-elevated p-3 pb-20 md:pb-16">
        <Button size="lg" className="w-full rounded-xl" onClick={onOpenApp}>
          Открыть приложение
        </Button>
      </div>
    </div>
  );
}

export function ChatHeader({
  title,
  subtitle,
  onBack,
  avatar,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  avatar: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg-elevated px-2">
      {onBack ? (
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-md text-gold md:hidden"
          onClick={onBack}
          aria-label="К чатам"
        >
          <ChevronLeft className="size-5" />
        </button>
      ) : (
        <span className="hidden size-2 md:block" />
      )}
      <span className="flex size-9 items-center justify-center rounded-full bg-surface-2">
        {avatar}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold leading-tight">{title}</p>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
    </header>
  );
}

function TelegramLiveStatus() {
  const [status, setStatus] = useState<{
    bot: string;
    arbiterOk: boolean;
    channelOk: boolean;
  } | null>(null);

  useEffect(() => {
    void getTelegramStatus()
      .then(setStatus)
      .catch(() => {
        setStatus({ bot: "@EuropeBlack_bot", arbiterOk: false, channelOk: false });
      });
  }, []);

  if (!status) return null;

  return (
    <div className="rounded-xl bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted shadow-[0_0_0_1px_rgba(243,239,228,0.06)]">
      <p>
        Живой бот: <span className="font-semibold text-gold">{status.bot}</span>
      </p>
      <p className="mt-1">
        Чат арбитров:{" "}
        <span className={status.arbiterOk ? "text-ok" : "text-danger"}>
          {status.arbiterOk
            ? "подключён"
            : "бот не в чате - добавьте @EuropeBlack_bot админом и напишите /id"}
        </span>
      </p>
      <p>
        Канал:{" "}
        <span className={status.channelOk ? "text-ok" : "text-danger"}>
          {status.channelOk ? "подключён" : "добавьте @EuropeBlack_bot админом канала"}
        </span>
      </p>
    </div>
  );
}

function BotBubble({ children, className }: { children: ReactNode; className?: string }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    setTime(format(new Date(), "HH:mm", { locale: ru }));
  }, []);

  return (
    <div
      className={cn(
        "max-w-[min(100%,36rem)] rounded-2xl rounded-tl-md bg-surface px-3.5 py-3 text-sm leading-relaxed text-fg shadow-[0_0_0_1px_rgba(243,239,228,0.06)]",
        className,
      )}
    >
      {children}
      <p className="mt-2 text-right text-xs text-subtle">{time || "\u00a0"}</p>
    </div>
  );
}
