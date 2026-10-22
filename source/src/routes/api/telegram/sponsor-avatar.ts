import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import { sponsorAvatarPath } from "@/lib/telegram-bot.server";

// Serves a cached sponsor-chat avatar from our own origin (no bot token to the
// browser). Only keys that match a cached avatar file are served.
export const Route = createFileRoute("/api/telegram/sponsor-avatar")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("a") || "";
        const path = sponsorAvatarPath(key);
        if (!path) return new Response("not found", { status: 404 });
        const size = statSync(path).size;
        const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
        return new Response(stream, {
          headers: {
            "content-type": "image/jpeg",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "public, max-age=86400",
            "content-length": String(size),
          },
        });
      },
    },
  },
});
