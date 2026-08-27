import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EvidencePicker } from "@/components/evidence-picker";
import { readTelegramWebUser, parseTelegramInput, resolveTelegramId } from "@/lib/telegram";
import { resolveTelegramHandle, submitToTelegram } from "@/lib/telegram-bot.functions";
import { useBlacklistStore } from "@/lib/store";
import type { Currency, EvidenceItem, PersonRef } from "@/lib/types";
import { uid } from "@/lib/utils";
import { cn } from "@/lib/utils";

const CURRENCIES: Currency[] = ["EUR", "USD", "USDT", "RUB"];
const MAX_ACCOUNTS = 8;

type AccRow = {
  key: string;
  input: string;
  username: string;
  id: string;
};

function emptyAcc(): AccRow {
  return { key: uid("acc"), input: "", username: "", id: "" };
}

export function ApplyForm({
  onSubmitted,
}: {
  onSubmitted: (notice?: string) => void;
}) {
  const identity = useBlacklistStore((s) => s.identity);
  const setIdentity = useBlacklistStore((s) => s.setIdentity);
  const submitApplication = useBlacklistStore((s) => s.submitApplication);

  const [victimUser, setVictimUser] = useState(identity.username);
  const [victimId, setVictimId] = useState(identity.telegramId);
  const [victimResolving, setVictimResolving] = useState(false);

  const [accounts, setAccounts] = useState<AccRow[]>([emptyAcc()]);

  const [story, setStory] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [files, setFiles] = useState<EvidenceItem[]>([]);
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);

  const fromTelegram = useMemo(() => Boolean(readTelegramWebUser()), []);

  useEffect(() => {
    const tg = readTelegramWebUser();
    if (!tg) return;
    setIdentity(tg);
    setVictimUser(tg.username);
    setVictimId(tg.telegramId);
  }, [setIdentity]);

  useEffect(() => {
    const handle = victimUser.trim();
    if (!handle || fromTelegram) return;
    let cancelled = false;
    setVictimResolving(true);
    const t = setTimeout(() => {
      void (async () => {
        let res = null;
        try {
          res = await resolveTelegramHandle({ data: { input: handle } });
        } catch {
          res = await resolveTelegramId(handle);
        }
        if (cancelled) return;
        setVictimResolving(false);
        if (res?.id) {
          setVictimId(res.id);
          setIdentity({
            username: res.username || handle.replace(/^@/, ""),
            telegramId: res.id,
          });
        }
      })();
    }, 480);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [victimUser, fromTelegram, setIdentity]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError("");

    const vUser = victimUser.replace(/^@/, "").trim();
    if (!vUser) {
      setFormError("Укажите ваш Telegram, чтобы арбитры могли связаться");
      return;
    }
    if (!victimId) {
      setFormError("ID пострадавшего ещё подтягивается");
      return;
    }
    const filled = accounts
      .map((a) => ({
        username: a.username.replace(/^@/, "").trim(),
        telegramId: a.id.trim(),
      }))
      .filter((a) => a.username || a.telegramId);
    if (!filled.length) {
      setFormError("Укажите хотя бы один аккаунт мошенника");
      return;
    }
    if (filled.some((a) => !a.telegramId)) {
      setFormError("У каждого аккаунта должен быть ID");
      return;
    }
    if (story.trim().length < 20) {
      setFormError("Опишите схему подробнее (от 20 символов)");
      return;
    }
    if (!amount.trim() || Number(amount) <= 0) {
      setFormError("Укажите сумму ущерба");
      return;
    }
    if (!files.length) {
      setFormError("Прикрепите хотя бы одно доказательство");
      return;
    }

    setSending(true);
    const app = {
      id: `EPB-${uid().slice(0, 4).toUpperCase()}`,
      createdAt: Date.now(),
      status: "pending" as const,
      victim: {
        username: vUser,
        telegramId: victimId,
        firstName: identity.firstName,
      },
      scammer: filled[0] as PersonRef,
      scammers: filled,
      story: story.trim(),
      damageAmount: amount.trim(),
      damageCurrency: currency,
      evidence: files,
    };
    submitApplication(app);
    setIdentity({ username: vUser, telegramId: victimId });
    let notice = "Заявка сохранена. Telegram ещё не принял — добавьте бота в чат арбитров.";
    try {
      const tg = await submitToTelegram({ data: app });
      notice = tg.ok
        ? "Заявка ушла в чат арбитров в Telegram."
        : tg.error || notice;
    } catch {
      // keep notice
    }
    setSending(false);
    onSubmitted(notice);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      onFocusCapture={(e) => {
        const el = e.target;
        if (!(el instanceof HTMLElement)) return;
        if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return;
        window.setTimeout(() => {
          el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          window.scrollTo(0, 0);
        }, 180);
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
        <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">Пострадавший</h2>
          <p className="text-sm text-muted">
            {fromTelegram
              ? "Данные подтянуты из Telegram. Username нужен, чтобы арбитры могли написать вам."
              : "Username нужен, чтобы арбитры могли написать вам."}
          </p>
        </header>
        <Field label="Ваш Telegram">
          <Input
            value={victimUser ? (victimUser.startsWith("@") ? victimUser : `@${victimUser}`) : ""}
            onChange={(e) => setVictimUser(e.target.value.replace(/^@/, ""))}
            placeholder="@username"
            autoComplete="username"
            required
          />
        </Field>
        <IdStatus
          label="Ваш ID"
          idValue={victimId}
          resolving={victimResolving}
          emptyText="Подтянется из username"
        />
      </section>

      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">Мошенник</h2>
          <p className="text-sm text-muted">
            @username или t.me. Если прятался под несколькими аккаунтами — добавьте все.
          </p>
        </header>
        <div className="space-y-4">
          {accounts.map((acc, index) => (
            <ScammerAccountRow
              key={acc.key}
              index={index}
              row={acc}
              canRemove={accounts.length > 1}
              onChange={(next) =>
                setAccounts((prev) => prev.map((item) => (item.key === acc.key ? { ...item, ...next } : item)))
              }
              onRemove={() => setAccounts((prev) => prev.filter((item) => item.key !== acc.key))}
            />
          ))}
        </div>
        {accounts.length < MAX_ACCOUNTS ? (
          <button
            type="button"
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-surface text-sm font-semibold text-gold shadow-[0_0_0_1px_rgba(240,196,48,0.28)]"
            onClick={() => setAccounts((prev) => [...prev, emptyAcc()])}
          >
            <Plus className="size-4" />
            Ещё аккаунт
          </button>
        ) : null}
      </section>

      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">Суть обмана</h2>
          <p className="text-sm text-muted">
            Как связывались, что обещали, куда просили перевести. Этот текст уйдёт в пост, если заявку одобрят.
          </p>
        </header>
        <Textarea
          value={story}
          onChange={(e) => setStory(e.target.value)}
          placeholder="Например: якобы продаёт FTP, клянчит по 50–100$, включает дурачка и пропадает."
        />
        <div className="space-y-3">
          <Field label="Сумма ущерба">
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
              placeholder="100"
            />
          </Field>
          <Field label="Валюта">
            <div className="flex h-11 overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(243,239,228,0.10)]">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCurrency(c)}
                  className={cn(
                    "min-w-0 flex-1 px-2 text-xs font-semibold transition-colors duration-150",
                    currency === c ? "bg-gold text-gold-fg" : "bg-surface text-muted hover:text-fg",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">Доказательства</h2>
          <p className="text-sm text-muted">Переписка, чеки, видеозвонки — всё, что подтверждает схему.</p>
        </header>
        <EvidencePicker files={files} onChange={setFiles} />
      </section>

      {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button type="submit" size="lg" className="w-full rounded-xl" disabled={sending}>
          {sending ? "Отправляем…" : "Отправить на рассмотрение"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function ScammerAccountRow({
  index,
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: AccRow;
  canRemove: boolean;
  onChange: (patch: Partial<AccRow>) => void;
  onRemove: () => void;
}) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const value = row.input.trim();
    setError("");
    if (!value) {
      if (row.username || row.id) onChange({ username: "", id: "" });
      return;
    }
    const parsed = parseTelegramInput(value);
    onChange({ username: parsed.username });
    if (parsed.id) {
      onChange({ username: parsed.username, id: parsed.id });
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    const t = setTimeout(() => {
      void (async () => {
        let res = null;
        try {
          res = await resolveTelegramHandle({ data: { input: value } });
        } catch {
          res = await resolveTelegramId(value);
        }
        if (cancelled) return;
        setResolving(false);
        if (!res) {
          onChange({ username: "", id: "" });
          setError("Не удалось разобрать username или ID");
          return;
        }
        if (res.id) {
          onChange({ username: res.username, id: res.id });
          setError("");
          return;
        }
        const local = await resolveTelegramId(value);
        if (local?.id) {
          onChange({ username: local.username || res.username, id: local.id });
          setError("");
          return;
        }
        onChange({ username: res.username, id: "" });
        setError("Не нашли ID. Проверьте @username или вставьте числовой ID.");
      })();
    }, 480);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [row.input]);

  return (
    <div className="space-y-3 rounded-xl bg-surface/60 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted">
          Аккаунт {index + 1}
        </p>
        {canRemove ? (
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            onClick={onRemove}
            aria-label="Удалить аккаунт"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      <Field label="Telegram мошенника">
        <Input
          value={row.input}
          onChange={(e) => onChange({ input: e.target.value })}
          placeholder="@username или t.me"
          required={index === 0}
        />
      </Field>
      <Field label="ID мошенника">
        <Input
          value={row.id}
          onChange={(e) => {
            onChange({ id: e.target.value.replace(/\D/g, "").slice(0, 15) });
            setError("");
          }}
          placeholder="Вставьте числовой ID"
          inputMode="numeric"
          required={index === 0}
        />
      </Field>
      {resolving ? (
        <p className="flex items-center gap-1.5 text-sm text-gold">
          <LoaderCircle className="size-3.5 animate-spin" />
          Подтягиваем ID…
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function IdStatus({
  label,
  idValue,
  resolving,
  emptyText,
}: {
  label: string;
  idValue: string;
  resolving: boolean;
  emptyText: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-surface px-3 py-2.5 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div>
        <p className="text-xs font-medium text-muted">{label}</p>
        {resolving ? (
          <p className="flex items-center gap-1.5 text-sm text-gold">
            <LoaderCircle className="size-3.5 animate-spin" />
            Подтягиваем ID…
          </p>
        ) : idValue ? (
          <p className="font-medium tabular-nums text-fg">{idValue}</p>
        ) : (
          <p className="text-sm text-subtle">{emptyText}</p>
        )}
      </div>
      {idValue && !resolving ? (
        <span className="flex size-8 items-center justify-center rounded-full bg-ok/15 text-ok">
          <Check className="size-4" />
        </span>
      ) : null}
    </div>
  );
}
