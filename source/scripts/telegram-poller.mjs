import { createHash } from "node:crypto";

/**
 * Long-poll Telegram updates in the live workspace and forward them
 * to the app webhook. Production uses setWebhook instead.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK = "http://127.0.0.1:8080/api/telegram/webhook";
const SECRET = `epb-${createHash("sha256").update(TOKEN).digest("hex").slice(0, 24)}`;

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://127.0.0.1:8080/");
      if (res.ok || res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  await waitForApp();
  await fetch(`${API}/deleteWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drop_pending_updates: false }),
  });

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query", "my_chat_member"],
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        const desc = String(json.description || "");
        if (/webhook/i.test(desc)) {
          await fetch(`${API}/deleteWebhook`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ drop_pending_updates: false }),
          });
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const update of json.result ?? []) {
        offset = update.update_id + 1;
        await fetch(WEBHOOK, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-epb-poller": SECRET,
          },
          body: JSON.stringify(update),
        });
      }
    } catch (err) {
      console.error("[telegram-poller]", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
