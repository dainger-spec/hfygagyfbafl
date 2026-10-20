#!/usr/bin/env node
// One-time login of a Telegram USER account for the counterparty-check search.
// Run on the host:  node scripts/login-user.mjs
// It logs in interactively and saves the session to data/user-session.txt, which the
// bot then uses to read channels (including old posts) the account is subscribed to.
//
// You need your own api_id / api_hash from https://my.telegram.org (API development tools).
// WARNING: the saved session grants full access to this account. Keep data/ private.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DATA_DIR || join(root, "data");
const out = join(dataDir, "user-session.txt");

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

async function main() {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const apiId = Number(process.env.TELEGRAM_API_ID || (await ask("api_id (my.telegram.org): ")));
  const apiHash = (process.env.TELEGRAM_API_HASH || (await ask("api_hash: "))).trim();
  if (!apiId || !apiHash) {
    console.error("Нужны api_id и api_hash.");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: async () => (await ask("Телефон (в формате +7999...): ")).trim(),
    password: async () => (await ask("Пароль двухфакторной защиты (если есть, иначе Enter): ")).trim(),
    phoneCode: async () => (await ask("Код из Telegram: ")).trim(),
    onError: (err) => console.error(err),
  });

  const session = client.session.save();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(out, session, { mode: 0o600 });
  console.log("\nГотово. Сессия сохранена в:", out);
  console.log("Теперь задайте на хосте TELEGRAM_API_ID и TELEGRAM_API_HASH (те же) и перезапустите бота.");
  console.log("Аккаунт должен быть подписан на каналы, по которым нужен поиск.");
  await client.disconnect();
  await rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
