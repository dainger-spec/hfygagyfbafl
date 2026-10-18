import { CHANNEL_NAME, CHANNEL_URL, formatChannelPost } from "@/lib/telegram";
import type { Application } from "@/lib/types";

export function PostBody({ app }: { app: Application }) {
  const text = formatChannelPost(app);
  const head = text.split("\n\nSubscribe: ")[0];
  return (
    <div className="whitespace-pre-wrap text-base leading-relaxed text-fg">
      <p className="whitespace-pre-wrap">{head}</p>
      <p className="mt-4">
        Subscribe:{" "}
        <a
          href={CHANNEL_URL}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-gold underline-offset-4 hover:underline"
        >
          {CHANNEL_NAME}
        </a>
      </p>
    </div>
  );
}