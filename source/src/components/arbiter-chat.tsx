import { useState, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { ChatHeader } from "@/components/bot-chat";
import { EvidenceGallery } from "@/components/evidence-picker";
import { PostBody } from "@/components/post-body";
import { Button } from "@/components/ui/button";
import { evidenceSrc } from "@/lib/evidence";
import { useBlacklistStore } from "@/lib/store";
import type { Application, EvidenceItem } from "@/lib/types";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export function ArbiterChat({ onBack }: { onBack?: () => void }) {
  const hydrated = useHydrated();
  const applications = useBlacklistStore((s) => s.applications);
  const publishApplication = useBlacklistStore((s) => s.publishApplication);
  const rejectApplication = useBlacklistStore((s) => s.rejectApplication);
  const [preview, setPreview] = useState<Application | null>(null);
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [lightbox, setLightbox] = useState<EvidenceItem | null>(null);

  const inbox = hydrated
    ? applications.filter((a) => a.id !== "EPB-SEED").sort((a, b) => b.createdAt - a.createdAt)
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <ChatHeader
        title="Арбитры"
        subtitle="закрытый чат · публикация в канал"
        onBack={onBack}
        avatar={<Shield className="size-4 text-gold" />}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 md:px-6">
        {!hydrated ? (
          <p className="text-sm text-muted">Загружаем заявки…</p>
        ) : inbox.length === 0 ? (
          <div className="rounded-2xl bg-surface px-4 py-8 text-center">
            <p className="font-display font-bold">Очередь пуста</p>
            <p className="mt-1 text-sm text-muted">
              Новые заявки из Mini App появляются здесь с кнопками «Принять» и «Отклонить».
            </p>
          </div>
        ) : (
          inbox.map((app) => (
            <article
              key={app.id}
              className="max-w-[min(100%,40rem)] rounded-2xl rounded-tl-md bg-surface p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.07)]"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium tracking-wide text-muted">Заявка {app.id}</p>
                <StatusPill status={app.status} />
              </div>

              <dl className="mt-3 space-y-2 text-sm">
                <Row
                  label="Пострадавший"
                  value={`@${app.victim.username.replace(/^@/, "")} · ID ${app.victim.telegramId}`}
                />
                <Row
                  label="Аккаунт"
                  value={`${app.scammer.username ? `@${app.scammer.username.replace(/^@/, "")} · ` : ""}ID ${app.scammer.telegramId}`}
                />
                <Row label="Ущерб" value={`${app.damageAmount} ${app.damageCurrency}`} />
              </dl>

              <p className="mt-3 text-xs font-medium text-muted">Кратко (в пост)</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-pretty">
                {app.summary || app.story}
              </p>
              {app.summary ? (
                <>
                  <p className="mt-3 text-xs font-medium text-muted">Подробно</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-pretty">{app.story}</p>
                </>
              ) : null}

              {app.evidence.length ? (
                <div className="mt-3">
                  <p className="mb-1.5 text-xs font-medium text-muted">Доказательства</p>
                  <EvidenceGallery items={app.evidence} onOpen={setLightbox} />
                </div>
              ) : null}

              {app.status === "pending" ? (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button className="rounded-lg" onClick={() => setPreview(app)}>
                    Принять
                  </Button>
                  <Button
                    variant="danger"
                    className="rounded-lg"
                    onClick={() => setRejecting(app)}
                  >
                    Отклонить
                  </Button>
                </div>
              ) : null}

              <p className="mt-3 text-right text-xs text-subtle">
                {format(app.createdAt, "d MMM, HH:mm", { locale: ru })}
              </p>
            </article>
          ))
        )}
      </div>

      {preview ? (
        <ConfirmModal
          title="Публикация в канал"
          confirmLabel="Принять"
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            publishApplication(preview.id);
            setPreview(null);
          }}
        >
          <p className="text-sm text-muted">Пост уйдёт в канал в таком виде:</p>
          <div className="mt-3 rounded-lg bg-bg p-3">
            <PostBody app={preview} />
          </div>
        </ConfirmModal>
      ) : null}

      {rejecting ? (
        <ConfirmModal
          title="Отклонить заявку"
          confirmLabel="Отклонить"
          danger
          onCancel={() => setRejecting(null)}
          onConfirm={() => {
            rejectApplication(rejecting.id);
            setRejecting(null);
          }}
        >
          <p className="text-sm text-muted">
            Заявка {rejecting.id} будет отклонена. В канал ничего не публикуется.
          </p>
        </ConfirmModal>
      ) : null}

      {lightbox ? <Lightbox item={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: Application["status"] }) {
  const map = {
    pending: { label: "на рассмотрении", className: "text-gold" },
    published: { label: "опубликовано", className: "text-ok" },
    rejected: { label: "отклонено", className: "text-danger" },
  } as const;
  const item = map[status];
  return (
    <span className={cn("text-xs font-semibold uppercase tracking-wide", item.className)}>
      {item.label}
    </span>
  );
}

function ConfirmModal({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_rgba(243,239,228,0.10)]">
        <h3 className="font-display text-lg font-bold">{title}</h3>
        <div className="mt-3">{children}</div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Назад
          </Button>
          <Button variant={danger ? "danger" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ item, onClose }: { item: EvidenceItem; onClose: () => void }) {
  const src = evidenceSrc(item);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-4"
      onClick={onClose}
      role="presentation"
    >
      {item.kind === "video" && src ? (
        <video
          src={src}
          controls
          autoPlay
          className="max-h-[80dvh] max-w-full rounded-lg"
          onClick={(e) => e.stopPropagation()}
        />
      ) : src ? (
        <img
          src={src}
          alt={item.name}
          className="max-h-[80dvh] max-w-full rounded-lg img-outline"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <p className="text-sm text-muted">Файл недоступен в этой сессии</p>
      )}
    </div>
  );
}
