import { useRef, useState } from "react";
import { Film, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  canAddEvidence,
  EVIDENCE_MAX,
  evidenceSrc,
  fileToEvidence,
} from "@/lib/evidence";
import type { EvidenceItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export function EvidencePicker({
  files,
  onChange,
}: {
  files: EvidenceItem[];
  onChange: (next: EvidenceItem[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (!incoming.length) return;
    if (!canAddEvidence(files.length, incoming.length)) {
      setError(`Максимум ${EVIDENCE_MAX} файлов`);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const next: EvidenceItem[] = [];
      for (const file of incoming) {
        next.push(await fileToEvidence(file));
      }
      onChange([...files, ...next]);
    } catch {
      setError("Не удалось загрузить файл. Видео до 50 МБ.");
    } finally {
      setBusy(false);
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
          "flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl bg-surface px-4 py-6 text-center shadow-[0_0_0_1px_rgba(243,239,228,0.10)] transition-[background-color,box-shadow] duration-150",
          "hover:bg-surface-2",
        )}
      >
        <ImagePlus className="size-6 text-gold" />
        <span className="text-sm font-medium text-fg">
          {busy ? "Загружаем файлы…" : "Скрины и видео"}
        </span>
        <span className="text-xs text-muted">
          До {EVIDENCE_MAX} файлов. Можно перетащить сюда.
        </span>
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
                aria-label="Удалить файл"
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
      <div className="relative aspect-square overflow-hidden rounded-lg bg-surface-2">
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
