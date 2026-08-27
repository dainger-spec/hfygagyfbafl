import { createFileRoute } from "@tanstack/react-router";
import { saveUploadedEvidence } from "@/lib/telegram-bot.server";

export const Route = createFileRoute("/api/telegram/evidence")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const file = form.get("file");
        const id = String(form.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!id || !(file instanceof Blob) || !file.size) {
          return Response.json({ ok: false, error: "file required" }, { status: 400 });
        }
        if (file.size > 50 * 1024 * 1024) {
          return Response.json({ ok: false, error: "file too large" }, { status: 413 });
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        const storageKey = saveUploadedEvidence(id, bytes);
        return Response.json({ ok: true, storageKey });
      },
    },
  },
});
