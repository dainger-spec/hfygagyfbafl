import type { ReactNode } from "react";
import { Megaphone, Shield } from "lucide-react";
import { EuStarsLogo } from "@/components/eu-stars-logo";
import { useBlacklistStore } from "@/lib/store";
import type { ChatId } from "@/lib/types";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export function ChatsList({
  active,
  onOpen,
  className,
}: {
  active: ChatId | null;
  onOpen: (id: ChatId) => void;
  className?: string;
}) {
  const hydrated = useHydrated();
  const pending = useBlacklistStore(
    (s) => s.applications.filter((a) => a.status === "pending").length,
  );
  const count = hydrated ? pending : 0;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 w-full flex-col border-line bg-bg-elevated md:w-80 md:border-r",
        className,
      )}
    >
      <header className="flex h-14 items-center px-4">
        <p className="font-display text-base font-bold tracking-tight">Чаты</p>
      </header>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <ChatRow
          active={active === "bot"}
          onClick={() => onOpen("bot")}
          avatar={<EuStarsLogo size={28} />}
          title="EPB Bot"
          preview="Откройте приложение и подайте заявку"
        />
        <ChatRow
          active={active === "arbiters"}
          onClick={() => onOpen("arbiters")}
          avatar={<Shield className="size-5 text-gold" />}
          title="Арбитры"
          preview={count ? `${count} на рассмотрении` : "Закрытый чат проверки"}
          badge={count}
        />
        <ChatRow
          active={active === "channel"}
          onClick={() => onOpen("channel")}
          avatar={<Megaphone className="size-5 text-gold" />}
          title="Europe Private Blacklist"
          preview="Канал публикаций"
          meta="канал"
        />
      </nav>
      <footer className="border-t border-line p-3 md:hidden">
        <p className="text-xs leading-relaxed text-muted">
          Превью пути: бот → приложение → арбитры → канал
        </p>
      </footer>
    </aside>
  );
}

function ChatRow({
  active,
  onClick,
  avatar,
  title,
  preview,
  badge,
  meta,
}: {
  active: boolean;
  onClick: () => void;
  avatar: ReactNode;
  title: string;
  preview: string;
  badge?: number;
  meta?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors duration-150",
        active ? "bg-surface" : "hover:bg-surface/70",
      )}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-2 text-gold">
        {avatar}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-fg">{title}</span>
          {meta ? <span className="text-xs text-subtle">{meta}</span> : null}
        </span>
        <span className="mt-0.5 block truncate text-sm text-muted">{preview}</span>
      </span>
      {badge ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1.5 text-xs font-bold text-gold-fg">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
