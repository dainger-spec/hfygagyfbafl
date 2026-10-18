import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EvidencePicker } from "@/components/evidence-picker";
import { persistEvidence } from "@/lib/evidence";
import { readTelegramWebUser, parseTelegramInput, lookupTelegramHandle, telegramInitData, parseDamageAmount } from "@/lib/telegram";
import { submitToTelegram } from "@/lib/telegram-bot.functions";
import { useBlacklistStore } from "@/lib/store";
import { t } from "@/lib/i18n";
import type { Currency, EvidenceItem, PersonRef } from "@/lib/types";
import { uid } from "@/lib/utils";
import { cn } from "@/lib/utils";

const CURRENCIES: Currency[] = ["USD", "EUR"];
const MAX_ACCOUNTS = 8;

type AccRow = {
  key: string;
  input: string;
  username: string;
  id: string;
  // Set when Telegram confirmed the id for this username: the field is then read-only.
  idLocked?: boolean;
};

function emptyAcc(): AccRow {
  return { key: uid("acc"), input: "", username: "", id: "", idLocked: false };
}

export function ApplyForm({
  onSubmitted,
}: {
  onSubmitted: (notice?: string) => void;
}) {
  const identity = useBlacklistStore((s) => s.identity);
  const locale = useBlacklistStore((s) => s.locale);
  const setIdentity = useBlacklistStore((s) => s.setIdentity);
  const submitApplication = useBlacklistStore((s) => s.submitApplication);

  const [accounts, setAccounts] = useState<AccRow[]>([emptyAcc()]);

  const [summary, setSummary] = useState("");
  const [story, setStory] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [files, setFiles] = useState<EvidenceItem[]>([]);
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const tg = readTelegramWebUser();
    if (!tg) return;
    setIdentity(tg);
  }, [setIdentity]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError("");

    const tgUser = readTelegramWebUser();
    const vUser = (tgUser?.username || "").replace(/^@/, "").trim();
    const vId = tgUser?.telegramId || "";
    if (!vId) {
      setFormError(t(locale, "errOpenBot"));
      return;
    }
    const filled = accounts
      .map((a) => ({
        username: a.username.replace(/^@/, "").trim(),
        telegramId: a.id.trim(),
      }))
      .filter((a) => a.username || a.telegramId);
    if (!filled.length) {
      setFormError(t(locale, "errAccount"));
      return;
    }
    if (filled.some((a) => !a.telegramId)) {
      setFormError(t(locale, "idNotFound"));
      return;
    }
    if (summary.trim().length < 10) {
      setFormError(t(locale, "errSummary"));
      return;
    }
    if (summary.trim().length > 800) {
      setFormError(t(locale, "errSummaryLong"));
      return;
    }
    if (story.trim().length < 20) {
      setFormError(t(locale, "errStory"));
      return;
    }
    if (story.trim().length > 5000) {
      setFormError(t(locale, "errStoryLong"));
      return;
    }
    const parsedAmount = parseDamageAmount(amount);
    if (!parsedAmount) {
      setFormError(t(locale, "errAmount"));
      return;
    }
    if (!files.length) {
      setFormError(t(locale, "errFiles"));
      return;
    }

    setSending(true);
    try {
      const uploaded = await persistEvidence(files);
      setFiles(uploaded);
      const app = {
        id: `EPB-${uid().slice(0, 4).toUpperCase()}`,
        createdAt: Date.now(),
        status: "pending" as const,
        victim: {
          username: vUser,
          telegramId: vId,
          firstName: tgUser?.firstName || identity.firstName,
        },
        scammer: filled[0] as PersonRef,
        scammers: filled,
        story: story.trim(),
        summary: summary.trim(),
        damageAmount: parsedAmount.amount,
        damageCurrency: parsedAmount.currency || currency,
        evidence: uploaded.map((f) => ({ ...f, dataUrl: "" })),
      };
      const tg = await Promise.race([
        submitToTelegram({ data: { ...app, initData: telegramInitData(), locale } }),
        new Promise<{ ok: false; error: string }>((resolve) =>
          window.setTimeout(() => resolve({ ok: false, error: t(locale, "errTimeout") }), 90_000),
        ),
      ]);
      if (!tg.ok) {
        setFormError(tg.error || t(locale, "sentFail"));
        return;
      }
      submitApplication(app);
      setIdentity({ username: vUser, telegramId: vId, firstName: tgUser?.firstName || identity.firstName });
      onSubmitted(t(locale, "sentOk"));
    } catch {
      setFormError(t(locale, "sentFail"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [touch-action:pan-y]">
        <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">{t(locale, "accTitle")}</h2>
          <p className="text-sm text-muted">{t(locale, "accHint")}</p>
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
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-surface text-sm font-semibold text-gold shadow-[0_0_0_1px_rgba(240,196,48,0.28)] hover:bg-surface-2"
            onClick={() => setAccounts((prev) => [...prev, emptyAcc()])}
          >
            <Plus className="size-4" />
            {t(locale, "addAccount")}
          </button>
        ) : null}
      </section>

      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">{t(locale, "summaryTitle")}</h2>
          <p className="text-sm text-muted">{t(locale, "summaryHint")}</p>
        </header>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value.slice(0, 800))}
          maxLength={800}
          placeholder={t(locale, "summaryPh")}
        />
        <p className="text-right text-xs text-subtle">{summary.length}/800</p>
      </section>

      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="font-display text-lg font-bold">{t(locale, "storyTitle")}</h2>
          <p className="text-sm text-muted">{t(locale, "storyHint")}</p>
        </header>
        <Textarea
          value={story}
          onChange={(e) => setStory(e.target.value.slice(0, 5000))}
          maxLength={5000}
          placeholder={t(locale, "storyPh")}
        />
        <p className="text-right text-xs text-subtle">{story.length}/5000</p>
        <div className="space-y-3">
          <Field label={t(locale, "amount")}>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.,\s]/g, ""))}
              placeholder="15,000"
            />
          </Field>
          <Field label={t(locale, "currency")}>
            <div className="grid h-11 grid-cols-2 overflow-hidden rounded-xl shadow-[0_0_0_1px_rgba(243,239,228,0.10)]">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCurrency(c)}
                  className={cn(
                    "h-11 px-1 text-xs font-semibold transition-colors",
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
          <h2 className="font-display text-lg font-bold">{t(locale, "evidenceTitle")}</h2>
          <p className="text-sm text-muted">{t(locale, "evidenceHint")}</p>
        </header>
        <EvidencePicker files={files} onChange={setFiles} />
      </section>

      {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-bg px-4 py-3">
        <Button type="submit" size="lg" className="w-full" disabled={sending}>
          {sending ? t(locale, "sending") : t(locale, "send")}
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
  const locale = useBlacklistStore((s) => s.locale);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const idRef = useRef(row.id);
  idRef.current = row.id;

  useEffect(() => {
    const value = row.input.trim();
    setError("");
    if (!value) {
      if (row.username || row.id) onChange({ username: "", id: "", idLocked: false });
      return;
    }
    const parsed = parseTelegramInput(value);
    if (parsed.id) {
      onChange({ username: parsed.username, id: parsed.id, idLocked: false });
      setResolving(false);
      return;
    }
    onChange({ username: parsed.username, id: "", idLocked: false });
    // Do not look up half-typed names: every lookup spends the shared limit for
    // username searches (4 is the shortest username Telegram has).
    if (parsed.username.length < 4) {
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    const timer = setTimeout(() => {
      void (async () => {
        let res = null;
        try {
          res = await lookupTelegramHandle(value);
        } catch {
          res = null;
        }
        if (cancelled) return;
        setResolving(false);
        if (!res) {
          onChange({ username: parsed.username, id: idRef.current });
          if (!idRef.current) setError(t(locale, "parseFail"));
          return;
        }
        if (res.id) {
          onChange({ username: res.username, id: res.id, idLocked: res.source === "telegram" });
          setError("");
          return;
        }
        onChange({ username: res.username, id: idRef.current });
        if (!idRef.current) setError(t(locale, res.busy ? "idBusy" : "idNotFound"));
      })();
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [row.input]);

  return (
    <div className="space-y-3 rounded-2xl bg-surface/70 p-3 shadow-[0_0_0_1px_rgba(243,239,228,0.08)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted">
          {t(locale, "accountN")} {index + 1}
        </p>
        {canRemove ? (
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            onClick={onRemove}
            aria-label={t(locale, "removeAccount")}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      <Field label="Telegram">
        <Input
          value={row.input}
          onChange={(e) => onChange({ input: e.target.value })}
          placeholder={t(locale, "accPlaceholder")}
          required={index === 0}
        />
      </Field>
      <Field label="ID">
        {/* Display only: the id comes from Telegram or from the Telegram field above,
            never from free typing here. */}
        <Input
          value={row.id}
          readOnly
          tabIndex={-1}
          aria-readonly
          className="cursor-not-allowed opacity-70"
          placeholder={t(locale, "idAuto")}
          inputMode="numeric"
          required={false}
        />
      </Field>
      {row.idLocked ? <p className="text-xs text-muted">{t(locale, "idLocked")}</p> : null}
      {resolving ? (
        <p className="flex items-center gap-1.5 text-sm text-gold">
          <LoaderCircle className="size-3.5 animate-spin" />
          {t(locale, "resolvingId")}
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
