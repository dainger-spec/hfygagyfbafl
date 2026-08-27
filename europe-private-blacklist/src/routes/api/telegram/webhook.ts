import { createFileRoute } from "@tanstack/react-router";
import { handleUpdate, WEBHOOK_SECRET } from "@/lib/telegram-bot.server";

export const Route = createFileRoute("/api/telegram/webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, bot: "@EuBlackList_bot" }),
      POST: async ({ request }) => {
        const secret = request.headers.get("x-telegram-bot-api-secret-token");
        const poller = request.headers.get("x-epb-poller") === WEBHOOK_SECRET;
        if (secret !== WEBHOOK_SECRET && !poller) {
          return new Response("forbidden", { status: 403 });
        }
        const update = await request.json();
        await handleUpdate(update);
        return new Response("ok");
      },
    },
  },
});
