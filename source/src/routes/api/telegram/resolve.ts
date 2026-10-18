import { createFileRoute } from "@tanstack/react-router";
import { resolveHandleServer, verifyTelegramInitData } from "@/lib/telegram-bot.server";

export const Route = createFileRoute("/api/telegram/resolve")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { input?: string; initData?: string };
        const authed = verifyTelegramInitData(String(body.initData || ""));
        if (!authed) {
          return Response.json({ ok: false, error: "telegram auth required" }, { status: 401 });
        }
        const input = String(body.input || "").slice(0, 200).trim();
        if (!input) return Response.json({ ok: false, error: "empty" }, { status: 400 });
        const result = await resolveHandleServer(input);
        return Response.json(result || { username: "", id: "", source: "unresolved" });
      },
    },
  },
});
