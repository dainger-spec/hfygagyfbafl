import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MiniApp, type MiniPage } from "@/components/mini-app";
import { bootTelegramWebApp } from "@/lib/telegram";
import { configureTelegram } from "@/lib/telegram-bot.functions";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [page, setPage] = useState<MiniPage>("home");
  const [canClose, setCanClose] = useState(false);

  useEffect(() => {
    // opened from the bot's "Open in the app" on the check screen
    try {
      const start = new URLSearchParams(window.location.search).get("page") || (window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined)?.start_param || "";
      if (start === "check") setPage("check");
    } catch {
      /* ignore */
    }
    bootTelegramWebApp();
    setCanClose(Boolean(window.Telegram?.WebApp?.close));
    void configureTelegram({ data: { origin: window.location.origin } }).catch(() => {});
  }, []);

  return (
    <MiniApp
      page={page}
      onPage={setPage}
      embedded
      onClose={canClose ? () => window.Telegram?.WebApp?.close?.() : undefined}
    />
  );
}
