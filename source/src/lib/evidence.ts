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

export async function fileToEvidence(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<EvidenceItem> {
  const id = uid("ev");
  if (isVideoFile(file)) {
    sessionBlobs.set(id, URL.createObjectURL(file));
    const storageKey = await uploadEvidenceFile(file, onProgress);
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

  let dataUrl = "";
  try {
    dataUrl = await resizeImage(file);
  } catch {
    sessionBlobs.set(id, URL.createObjectURL(file));
    const storageKey = await uploadEvidenceFile(file, onProgress);
    return {
      id,
      kind: "image",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      dataUrl: "",
      storageKey,
    };
  }
  sessionBlobs.set(id, dataUrl);
  const jpeg = dataUrlToJpegFile(dataUrl, file.name);
  const storageKey = await uploadEvidenceFile(jpeg, onProgress);
  return {
    id,
    kind: "image",
    name: file.name,
    size: jpeg.size,
    mime: "image/jpeg",
    dataUrl: "",
    storageKey,
  };
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
