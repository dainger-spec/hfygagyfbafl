import { uid } from "@/lib/utils";
import type { EvidenceItem } from "@/lib/types";

const MAX_FILES = 20;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const sessionBlobs = new Map<string, string>();

export function sessionBlobUrl(id: string): string | undefined {
  return sessionBlobs.get(id);
}

function resizeImage(file: File, max = 960, quality = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("canvas"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("image"));
    };
    img.src = objectUrl;
  });
}

async function uploadEvidenceFile(id: string, file: File): Promise<string> {
  const body = new FormData();
  body.set("id", id);
  body.set("file", file, file.name);
  const res = await fetch("/api/telegram/evidence", { method: "POST", body });
  if (!res.ok) throw new Error("upload failed");
  const json = (await res.json()) as { storageKey?: string };
  if (!json.storageKey) throw new Error("upload failed");
  return json.storageKey;
}

export async function fileToEvidence(file: File): Promise<EvidenceItem> {
  const isVideo = file.type.startsWith("video/");
  const id = uid("ev");
  if (isVideo) {
    if (file.size > MAX_VIDEO_BYTES) {
      throw new Error("video too large");
    }
    sessionBlobs.set(id, URL.createObjectURL(file));
    const storageKey = await uploadEvidenceFile(id, file);
    return {
      id,
      kind: "video",
      name: file.name,
      size: file.size,
      mime: file.type || "video/mp4",
      dataUrl: "",
      storageKey,
    };
  }

  const dataUrl = await resizeImage(file);
  return {
    id,
    kind: "image",
    name: file.name,
    size: file.size,
    mime: "image/jpeg",
    dataUrl,
  };
}

export function canAddEvidence(current: number, incoming: number): boolean {
  return current + incoming <= MAX_FILES;
}

export const EVIDENCE_MAX = MAX_FILES;

export function evidenceSrc(item: EvidenceItem): string {
  return item.dataUrl || sessionBlobs.get(item.id) || "";
}
