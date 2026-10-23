import { definePlugin } from "nitro";

// The bot code lives in the app bundle, which the server only loads on the first
// matching request. With long polling no request ever comes from Telegram, so
// right after start we send one internal request (no network, no port needed):
// it loads the bot, which then starts pulling updates on its own. Works the same
// however the server was started (scripts/start.mjs or .output/server/index.mjs).
export default definePlugin((nitroApp) => {
  const app = nitroApp as unknown as { fetch?: (req: Request) => Promise<Response> | Response };
  if (typeof app.fetch !== "function") return;
  const warm = async (attempt: number) => {
    try {
      await app.fetch!(new Request("http://localhost/api/telegram/webhook", { method: "GET" }));
    } catch {
      if (attempt < 5) setTimeout(() => void warm(attempt + 1), 5000 * (attempt + 1));
    }
  };
  setTimeout(() => void warm(0), 1500);
});
