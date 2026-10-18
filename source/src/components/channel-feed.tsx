import { Megaphone } from "lucide-react";
import { format, isToday } from "date-fns";
import { ru } from "date-fns/locale";
import { ChatHeader } from "@/components/bot-chat";
import { EvidenceGallery } from "@/components/evidence-picker";
import { PostBody } from "@/components/post-body";
import { CHANNEL_NAME } from "@/lib/telegram";
import { useBlacklistStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";

export function ChannelFeed({ onBack }: { onBack?: () => void }) {
  const hydrated = useHydrated();
  const applications = useBlacklistStore((s) => s.applications);
  const posts = hydrated
    ? applications
        .filter((a) => a.status === "published")
        .sort((a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <ChatHeader
        title={CHANNEL_NAME}
        subtitle="канал · только одобренные кейсы"
        onBack={onBack}
        avatar={<Megaphone className="size-4 text-gold" />}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 md:px-6">
        {!hydrated ? (
          <p className="text-sm text-muted">Загружаем канал…</p>
        ) : posts.length === 0 ? (
          <div className="rounded-2xl bg-surface px-4 py-8 text-center">
            <p className="font-display font-bold">Пока нет публикаций</p>
            <p className="mt-1 text-sm text-muted">
              Одобренные арбитрами заявки появляются здесь по шаблону.
            </p>
          </div>
        ) : (
          posts.map((app) => {
            const at = app.publishedAt ?? app.createdAt;
            const time = isToday(at)
              ? format(at, "HH:mm")
              : format(at, "d MMM, HH:mm", { locale: ru });
            return (
              <article
                key={app.id}
                className="max-w-[min(100%,40rem)] rounded-2xl rounded-tl-md bg-surface p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.07)]"
              >
                <PostBody app={app} />
                {app.evidence.length ? (
                  <div className="mt-3">
                    <EvidenceGallery items={app.evidence} />
                  </div>
                ) : null}
                <p className="mt-3 text-right text-xs text-subtle">{time}</p>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
