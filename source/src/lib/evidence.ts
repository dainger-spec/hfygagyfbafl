import { uid } from "@/lib/utils";
import { telegramInitData } from "@/lib/telegram";
import type { EvidenceItem } from "@/lib/types";

const MAX_FILES = 30;
const CHUNK_SIZE = 1536 * 1024;
const sessionBlobs = new Map<string, string>();

export function sessionBlobUrl(id: string): string | undefined {
  return sessionBlobs.get(id);
}

function isVideoFile(file: File) {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name || "");
}

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
}

export function isEvidenceFile(file: File) {
  return isVideoFile(file) || isImageFile(file);
}

// Long screenshots stay readable: the longest side is capped at 2560 px (what
// Telegram keeps for photos) and the picture at ~4.5 MP (phones run out of
// canvas memory above that and hand back a black frame).
const MAX_SIDE = 2560;
const MAX_PIXELS = 4_500_000;

// A canvas that failed to draw (memory pressure in the Telegram webview, an
// image not decoded yet) comes back all black; such a result is not used.
function looksBlank(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 16;
    probe.height = 16;
    const p = probe.getContext("2d");
    if (!p) return false;
    p.drawImage(canvas, 0, 0, 16, 16);
    const d = p.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > 10 || d[i + 1]! > 10 || d[i + 2]! > 10) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// A long chat screenshot shrunk into one photo becomes a thin unreadable strip
// (Telegram scales photos to 2560 px on the long side). Taller than this ratio,
// it is cut into readable parts that overlap a little.
const LONG_RATIO = 3.2;
const PART_RATIO = 2.1;
const MAX_PARTS = 8;

function drawJpeg(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, quality: number): string {
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh), Math.sqrt(MAX_PIXELS / (sw * sh)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  // JPEG has no transparency: transparent parts of a PNG would turn black
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (looksBlank(canvas)) throw new Error("blank");
  const url = canvas.toDataURL("image/jpeg", quality);
  // free the canvas memory right away (iOS keeps it otherwise)
  canvas.width = 0;
  canvas.height = 0;
  if (!url.startsWith("data:image/jpeg")) throw new Error("encode");
  return url;
}

// The picture as one JPEG, or as a few overlapping parts when it is a very
// long screenshot.
function resizeImage(file: File, quality = 0.86): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    const done = (fn: () => void) => {
      URL.revokeObjectURL(objectUrl);
      fn();
    };
    img.onload = async () => {
      try {
        // wait until the picture is fully decoded before drawing it
        await img.decode?.().catch(() => {});
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error("image");
        if (h / w <= LONG_RATIO || w < 200) {
          done(() => resolve([drawJpeg(img, 0, 0, w, h, quality)]));
          return;
        }
        const overlap = Math.round(w * 0.08);
        let partH = Math.round(w * PART_RATIO);
        let count = Math.ceil((h - overlap) / (partH - overlap));
        if (count > MAX_PARTS) {
          count = MAX_PARTS;
          partH = Math.ceil((h - overlap) / count) + overlap;
        }
        const step = (h - partH) / Math.max(1, count - 1);
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
          const y = Math.round(i * step);
          parts.push(drawJpeg(img, 0, y, w, Math.min(partH, h - y), quality));
        }
        done(() => resolve(parts));
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new Error("image")));
      }
    };
    img.onerror = () => done(() => reject(new Error("image")));
    img.src = objectUrl;
  });
}

function postChunkOnce(body: FormData): Promise<{ storageKey?: string; ok?: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/telegram/evidence");
    xhr.timeout = 120_000;
    xhr.responseType = "text";
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`upload ${xhr.status}`));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText || "{}") as { storageKey?: string; ok?: boolean });
      } catch {
        reject(new Error("bad upload response"));
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(body);
  });
}

async function postChunk(makeBody: () => Promise<FormData>, attempt = 0): Promise<{ storageKey?: string; ok?: boolean }> {
  try {
    return await postChunkOnce(await makeBody());
  } catch (err) {
    if (attempt >= 6) throw err;
    await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    return postChunk(makeBody, attempt + 1);
  }
}

async function chunkAsFile(file: File, index: number, total: number): Promise<File> {
  const start = index * CHUNK_SIZE;
  const end = Math.min(file.size, (index + 1) * CHUNK_SIZE);
  const slice = file.slice(start, end);
  const buf = await slice.arrayBuffer();
  return new File([buf], file.name || `video-${index + 1}-of-${total}.mp4`, {
    type: file.type || "video/mp4",
  });
}

async function uploadEvidenceFile(file: File, onProgress?: (done: number, total: number) => void): Promise<string> {
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE) || 1);
  let storageKey = "";
  for (let index = 0; index < total; index++) {
    const json = await postChunk(async () => {
      const part = await chunkAsFile(file, index, total);
      const body = new FormData();
      if (storageKey) body.set("id", storageKey);
      body.set("index", String(index));
      body.set("total", String(total));
      body.set("initData", telegramInitData());
      body.set("chunk", part, part.name);
      return body;
    });
    onProgress?.(index + 1, total);
    if (json.storageKey) storageKey = json.storageKey;
  }
  if (!storageKey) throw new Error("upload failed");
  return storageKey;
}

function dataUrlToJpegFile(dataUrl: string, name: string): File {
  const b64 = dataUrl.split(",")[1] || "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const safe = (name || "photo.jpg").replace(/\.[^.]+$/, ".jpg");
  return new File([bytes], safe, { type: "image/jpeg" });
}

// One picked file as evidence: a video as it is, a picture as a JPEG (or a few,
// for a very long screenshot).
export async function fileToEvidence(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<EvidenceItem[]> {
  if (isVideoFile(file)) {
    const id = uid("ev");
    sessionBlobs.set(id, URL.createObjectURL(file));
    const storageKey = await uploadEvidenceFile(file, onProgress);
    return [
      {
        id,
        kind: "video",
        name: file.name,
        size: file.size,
        mime: file.type || "video/mp4",
        dataUrl: "",
        storageKey,
      },
    ];
  }

  let parts: string[] = [];
  try {
    parts = await resizeImage(file);
  } catch {
    // the browser could not draw it (HEIC, out of memory): the original goes up
    const id = uid("ev");
    sessionBlobs.set(id, URL.createObjectURL(file));
    const storageKey = await uploadEvidenceFile(file, onProgress);
    return [
      {
        id,
        kind: "image",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        dataUrl: "",
        storageKey,
      },
    ];
  }
  const out: EvidenceItem[] = [];
  for (const [i, dataUrl] of parts.entries()) {
    const id = uid("ev");
    sessionBlobs.set(id, dataUrl);
    const name = parts.length > 1 ? (file.name || "screenshot").replace(/\.[^.]+$/, "") + `-${i + 1}.jpg` : file.name;
    const jpeg = dataUrlToJpegFile(dataUrl, name);
    const storageKey = await uploadEvidenceFile(jpeg, parts.length > 1 ? undefined : onProgress);
    onProgress?.(i + 1, parts.length);
    out.push({ id, kind: "image", name, size: jpeg.size, mime: "image/jpeg", dataUrl: "", storageKey });
  }
  return out;
}

export async function persistEvidence(files: EvidenceItem[]): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];
  for (const file of files) {
    if (file.storageKey) {
      out.push({ ...file, dataUrl: "" });
      continue;
    }
    const src = file.dataUrl || sessionBlobs.get(file.id) || "";
    if (!src.startsWith("data:")) {
      out.push({ ...file, dataUrl: "" });
      continue;
    }
    const jpeg = dataUrlToJpegFile(src, file.name || "photo.jpg");
    const storageKey = await uploadEvidenceFile(jpeg);
    out.push({ ...file, dataUrl: "", storageKey, size: jpeg.size, mime: "image/jpeg" });
  }
  return out;
}

export function canAddEvidence(current: number, incoming: number): boolean {
  return current + incoming <= MAX_FILES;
}

export const EVIDENCE_MAX = MAX_FILES;

export function evidenceSrc(item: EvidenceItem): string {
  return item.dataUrl || sessionBlobs.get(item.id) || "";
}
