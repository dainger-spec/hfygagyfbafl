import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BINDINGS = "/workspace/.grok/telegram-bindings.json";
const API = `https://api.telegram.org/bot${TOKEN}`;

async function register(url) {
  mkdirSync("/workspace/.grok", { recursive: true });
  let current = {};
  try {
    current = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(BINDINGS, "utf8")));
  } catch {
    current = {};
  }
  current.miniAppUrl = url;
  writeFileSync(BINDINGS, JSON.stringify(current, null, 2));
  await fetch(`${API}/setChatMenuButton`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      menu_button: {
        type: "web_app",
        text: "Открыть",
        web_app: { url },
      },
    }),
  });
  console.log("[telegram-tunnel] Mini App URL", url);
}

const child = spawn(
  "npx",
  ["--yes", "cloudflared", "tunnel", "--url", "http://127.0.0.1:8080"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let registered = "";
function consume(buf) {
  const text = buf.toString();
  process.stderr.write(text);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match && registered !== match[0]) {
    registered = match[0];
    void register(registered);
  }
}

child.stdout.on("data", consume);
child.stderr.on("data", consume);
child.on("exit", (code) => {
  console.error("[telegram-tunnel] exited", code);
  process.exit(code ?? 1);
});
