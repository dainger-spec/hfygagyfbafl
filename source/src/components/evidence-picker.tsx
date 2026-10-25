import { useRef, useState } from "react";
import { Film, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  canAddEvidence,
  EVIDENCE_MAX,
  evidenceSrc,
  fileToEvidence,
  isEvidenceFile,
} from "@/lib/evidence";
import type { EvidenceItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBlacklistStore } from "@/lib/store";
import { t } from "@/lib/i18n";

export function EvidencePicker({
  files,
  onChange,
}: {
  files: EvidenceItem[];
  onChange: (next: EvidenceItem[]) => void;
}) {
  const locale = useBlacklistStore((s) => s.locale);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");

  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter(isEvidenceFile);
    if (!incoming.length) return;
    if (!canAddEvidence(files.length, incoming.length)) {
      setError(t(locale, "maxFiles", { n: EVIDENCE_MAX }));
      return;
    }
    setError("");
    setBusy(true);
    setProgress("");
    try {
      const next: EvidenceItem[] = [];
      for (let i = 0; i < incoming.length; i++) {
        const file = incoming[i]!;
        setProgress(
          incoming.length > 1
            ? t(locale, "uploadingN", { i: i + 1, n: incoming.length })
            : file.type.startsWith("video/")
              ? t(locale, "uploadingVideo")
              : t(locale, "uploadingFile"),
        );
        next.push(
          ...(await fileToEvidence(file, (done, total) => {
            setProgress(
              incoming.length > 1
                ? t(locale, "uploadingNProgress", { i: i + 1, n: incoming.length, done, total })
                : t(locale, "uploadingVideoProgress", { done, total }),
            );
          })),
        );
      }
      // a long screenshot cut into parts can go past the limit: keep the first ones
      onChange([...files, ...next].slice(0, EVIDENCE_MAX));
    } catch {
      setError(t(locale, "uploadFail"));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files) void addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "epb-glass flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-2xl px-4 py-6 text-center",
        )}
      >
        <ImagePlus className="size-6 text-gold" />
        <span className="text-sm font-medium text-fg">
          {busy ? progress || t(locale, "uploading") : t(locale, "dropFiles")}
        </span>
        <span className="text-xs text-muted">{t(locale, "dropHint", { n: EVIDENCE_MAX })}</span>
      </button>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {files.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2">
          {files.map((file) => (
            <li key={file.id} className="relative">
              <EvidenceThumb item={file} />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute top-1 right-1 size-8 rounded-full"
                onClick={() => onChange(files.filter((f) => f.id !== file.id))}
                aria-label={t(locale, "removeFile")}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EvidenceThumb({ item }: { item: EvidenceItem }) {
  const src = evidenceSrc(item);
  if (item.kind === "video") {
    return (
      <div className="epb-glass-lite relative aspect-square overflow-hidden rounded-lg">
        {src ? (
          <video src={src} className="size-full object-cover img-outline" muted />
        ) : (
          <div className="flex size-full items-center justify-center text-muted">
            <Film className="size-6" />
          </div>
        )}
        <span className="absolute bottom-1 left-1 rounded-sm bg-bg/80 px-1.5 py-0.5 text-xs font-medium tracking-wide text-fg">
          VIDEO
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={item.name}
      className="aspect-square w-full rounded-lg object-cover img-outline"
    />
  );
}

export function EvidenceGallery({
  items,
  onOpen,
}: {
  items: EvidenceItem[];
  onOpen?: (item: EvidenceItem) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="grid grid-cols-3 gap-1.5">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="block w-full overflow-hidden rounded-md"
            onClick={() => onOpen?.(item)}
          >
            <EvidenceThumb item={item} />
          </button>
        </li>
      ))}
    </ul>
  );
}
