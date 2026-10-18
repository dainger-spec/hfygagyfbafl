import { useEffect, useState } from "react";
import { ArbiterChat } from "@/components/arbiter-chat";
import { BotChat } from "@/components/bot-chat";
import { ChannelFeed } from "@/components/channel-feed";
import { ChatsList } from "@/components/chats-list";
import { MiniApp, type MiniPage } from "@/components/mini-app";
import { BrandLockup } from "@/components/eu-stars-logo";
import { Button } from "@/components/ui/button";
import { useBlacklistStore } from "@/lib/store";
import type { ChatId } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TelegramSimulator() {
  const [activeChat, setActiveChat] = useState<ChatId | null>(null);
  const [miniOpen, setMiniOpen] = useState(false);
  const [miniPage, setMiniPage] = useState<MiniPage>("home");
  const resetDemo = useBlacklistStore((s) => s.resetDemo);

  const chat = activeChat ?? "bot";
  const showListOnMobile = activeChat === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && miniOpen) setMiniOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [miniOpen]);

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <div className="hidden items-center justify-between gap-3 border-b border-line px-4 py-2 md:flex">
        <BrandLockup size={32} />
        <Button
          variant="ghost"
          size="sm"
          className="text-muted"
          onClick={() => {
            resetDemo();
            setActiveChat(null);
            setMiniOpen(false);
            setMiniPage("home");
          }}
        >
          Сбросить демо
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <ChatsList
          active={chat}
          onOpen={setActiveChat}
          className={cn(showListOnMobile ? "flex" : "hidden md:flex")}
        />
        <section
          className={cn(
            "min-w-0 flex-1",
            showListOnMobile ? "hidden md:flex md:flex-col" : "flex flex-col",
          )}
        >
          {chat === "bot" ? (
            <BotChat
              onBack={() => setActiveChat(null)}
              onOpenApp={() => {
                setMiniPage("home");
                setMiniOpen(true);
              }}
            />
          ) : null}
          {chat === "arbiters" ? <ArbiterChat onBack={() => setActiveChat(null)} /> : null}
          {chat === "channel" ? <ChannelFeed onBack={() => setActiveChat(null)} /> : null}
        </section>
      </div>

      {miniOpen ? (
        <MiniApp
          page={miniPage}
          onPage={setMiniPage}
          onReview={() => {
            setMiniOpen(false);
            setActiveChat("arbiters");
          }}
          onClose={() => {
            setMiniOpen(false);
            if (miniPage === "done") setActiveChat("arbiters");
          }}
        />
      ) : null}
    </div>
  );
}

export function TelegramOnlyMiniApp() {
  const [page, setPage] = useState<MiniPage>("home");
  return <MiniApp page={page} onPage={setPage} embedded />;
}
