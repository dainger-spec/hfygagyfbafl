import { createFileRoute } from "@tanstack/react-router";
import { handleUpdate, isDisconnectError, webhookSecretMatches } from "@/lib/telegram-bot.server";

const MAX_WEBHOOK_BYTES = 256_000;

async function readJsonCapped(request: Request, max: number) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > max) return { status: 413 as const };
  if (!request.body) return { status: 400 as const };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return { status: 413 as const };
    }
    chunks.push(value);
  }
  try {
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { json: JSON.parse(text) as unknown };
  } catch {
    return { status: 400 as const };
  }
}

export const Route = createFileRoute("/api/telegram/webhook")({
  server: {
    handlers: {
      GET: async () => new Response("not found", { status: 404 }),
      POST: async ({ request }) => {
        try {
          const secret = request.headers.get("x-telegram-bot-api-secret-token");
          const poller = webhookSecretMatches(request.headers.get("x-epb-poller"));
          if (!webhookSecretMatches(secret) && !poller) {
            return new Response("forbidden", { status: 403 });
          }
          const body = await readJsonCapped(request, MAX_WEBHOOK_BYTES);
          if ("status" in body) return new Response(body.status === 413 ? "too large" : "bad request", { status: body.status });
          void handleUpdate(body.json as Parameters<typeof handleUpdate>[0]);
          return new Response("ok");
        } catch (err) {
          if (!isDisconnectError(err)) console.error("[epb] webhook", err);
          return new Response("ok");
        }
      },
    },
  },
});
