import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import {
  allowEvidenceChunk,
  allowEvidenceDownload,
  allowEvidenceUpload,
  appendEvidenceChunk,
  isDisconnectError,
  saveUploadedEvidence,
  uploadedEvidencePath,
  verifyEvidenceDownload,
} from "@/lib/telegram-bot.server";

const MAX_POST_BYTES = 2 * 1024 * 1024 + 96_000;

export const Route = createFileRoute("/api/telegram/evidence")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!allowEvidenceDownload()) return new Response("too many requests", { status: 429 });
        const url = new URL(request.url);
        const key = url.searchParams.get("key") || "";
        const exp = url.searchParams.get("exp") || "";
        const sig = url.searchParams.get("sig") || "";
        if (!verifyEvidenceDownload(key, exp, sig)) {
          return new Response("forbidden", { status: 403 });
        }
        const path = uploadedEvidencePath(key);
        if (!path) return new Response("not found", { status: 404 });
        const stat = statSync(path);
        const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
        return new Response(stream, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="evidence.bin"',
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
            "x-frame-options": "DENY",
            "content-length": String(stat.size),
            "cache-control": "private, no-store",
          },
        });
      },
      POST: async ({ request }) => {
        try {
          const declared = Number(request.headers.get("content-length") || 0);
          if (!declared || declared > MAX_POST_BYTES) {
            return Response.json({ ok: false, error: "too large" }, { status: 413 });
          }
          const form = await request.formData();
          const id = String(form.get("id") || "");
          const initData = String(form.get("initData") || request.headers.get("x-telegram-init-data") || "");
          const chunk = form.get("chunk");
          const file = form.get("file");
          const blob = chunk instanceof Blob && chunk.size ? chunk : file instanceof Blob ? file : null;
          if (!blob) {
            return Response.json({ ok: false, error: "file required" }, { status: 400 });
          }
          const index = Number(form.get("index") || 0);
          const total = Number(form.get("total") || 1);
          const gate =
            index === 0 ? allowEvidenceUpload(initData, blob.size) : allowEvidenceChunk(initData, blob.size);
          if (!gate.ok) {
            return Response.json({ ok: false, error: gate.error }, { status: gate.error === "telegram auth required" ? 401 : 429 });
          }
          const bytes = Buffer.from(await blob.arrayBuffer());
          if (bytes.length > 2 * 1024 * 1024) {
            return Response.json({ ok: false, error: "chunk too large" }, { status: 413 });
          }
          if (total <= 1 && !(chunk instanceof Blob)) {
            const storageKey = saveUploadedEvidence(gate.userId, bytes);
            return Response.json({ ok: true, storageKey });
          }
          const storageKey = appendEvidenceChunk(gate.userId, id, index, Math.max(1, total), bytes);
          return Response.json({ ok: true, storageKey: storageKey || undefined });
        } catch (err) {
          if (isDisconnectError(err)) return Response.json({ ok: false, error: "upload aborted" }, { status: 400 });
          const msg = err instanceof Error ? err.message : "";
          if (msg === "forbidden") return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
          if (msg === "not media") return Response.json({ ok: false, error: "only photos and videos" }, { status: 400 });
          console.error("[epb] evidence", err);
          return Response.json({ ok: false, error: "upload failed" }, { status: 500 });
        }
      },
    },
  },
});
