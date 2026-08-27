import { createFileRoute } from "@tanstack/react-router";
import { allowEvidenceUpload, saveUploadedEvidence } from "@/lib/telegram-bot.server";

export const Route = createFileRoute("/api/telegram/evidence")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const file = form.get("file");
        const id = String(form.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
        const initData = String(form.get("initData") || request.headers.get("x-telegram-init-data") || "");
        if (!id || !(file instanceof Blob) || !file.size) {
          return Response.json({ ok: false, error: "file required" }, { status: 400 });
        }
        const gate = allowEvidenceUpload(initData, file.size);
        if (!gate.ok) {
          return Response.json({ ok: false, error: gate.error }, { status: 429 });
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        const storageKey = saveUploadedEvidence(id, bytes);
        return Response.json({ ok: true, storageKey });
      },
    },
  },
});
