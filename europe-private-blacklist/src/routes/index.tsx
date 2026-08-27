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
