import { inspect } from "node:util";
import { definePlugin } from "nitro";

// A visitor closing the app mid-request (or a scanner probing made-up server
// functions) is not an error worth a log line. Filtered here too, so it also
// holds when the server is started without scripts/start.mjs.
const NOISE = /AbortError|aborted|ECONNRESET|EPIPE|socket hang up|premature close|Invalid server action param for serverFnId/i;
function isNoise(args: unknown[]) {
  return args.some((item) => {
    if (!item) return false;
    try {
      return NOISE.test(typeof item === "string" ? item : inspect(item, { depth: 3, breakLength: Infinity }));
    } catch {
      return false;
    }
  });
}
if (!(console.error as { __epbQuiet?: boolean }).__epbQuiet) {
  const orig = console.error.bind(console);
  const quiet = (...args: unknown[]) => {
    if (isNoise(args)) return;
    orig(...args);
  };
  (quiet as { __epbQuiet?: boolean }).__epbQuiet = true;
  console.error = quiet;
}

function isDisconnect(err: unknown) {
  const any = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const text = `${any?.code || ""} ${any?.message || ""} ${any?.cause?.code || ""} ${any?.cause?.message || ""}`;
  return /aborted|ECONNRESET|EPIPE|socket hang up|premature close/i.test(text);
}

export default definePlugin((nitroApp) => {
  const app = nitroApp.h3 as { config?: { onError?: (err: unknown) => unknown; silent?: boolean } } | undefined;
  if (app?.config) {
    const prev = app.config.onError;
    app.config.onError = (error) => {
      if (isDisconnect(error)) return new Response("ok");
      return prev?.(error);
    };
  }
  nitroApp.hooks.hook("error", (error) => {
    if (isDisconnect(error)) return;
  });
});
