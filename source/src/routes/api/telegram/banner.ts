import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import { bannerById, bannerFilePath } from "@/lib/telegram-bot.server";

// Serves a banner's media from our own origin (so the bot token never reaches
// the browser). Public, but only ids that match a stored banner are served, and
// the content-type comes from the stored record — not from the request.
export const Route = createFileRoute("/api/telegram/banner")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const id = url.searchParams.get("id") || "";
        const banner = bannerById(id);
        const path = banner ? bannerFilePath(id) : null;
        if (!banner || !path) return new Response("not found", { status: 404 });

        const size = statSync(path).size;
        const headersBase: Record<string, string> = {
          "content-type": banner.mime || "application/octet-stream",
          "x-content-type-options": "nosniff",
          // Defence in depth: even if some scriptable type were served, the
          // sandboxed, script-less context stops it executing on our origin.
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "public, max-age=86400",
          "accept-ranges": "bytes",
        };

        // Byte-range support: videos need it for seeking and for looping on iOS.
        const range = request.headers.get("range");
        const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
        if (match) {
          let start = match[1] ? Number(match[1]) : 0;
          let end = match[2] ? Number(match[2]) : size - 1;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end) || end >= size) end = size - 1;
          if (start > end || start >= size) {
            return new Response("range not satisfiable", {
              status: 416,
              headers: { "content-range": `bytes */${size}` },
            });
          }
          const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
          return new Response(stream, {
            status: 206,
            headers: {
              ...headersBase,
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-length": String(end - start + 1),
            },
          });
        }

        const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
        return new Response(stream, {
          headers: { ...headersBase, "content-length": String(size) },
        });
      },
    },
  },
});
