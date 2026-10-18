import { definePlugin } from "nitro";

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
