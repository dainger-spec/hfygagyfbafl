#!/usr/bin/env node
// Restores the data files from an off-site backup the bot sent to the owner
// (epb-backup-YYYY-MM-DD.json.gz). Stop the bot first.
//
//   node scripts/restore-backup.mjs path/to/epb-backup-2026-10-23.json.gz
//
// Files are written into DATA_DIR (default ./data). Whatever is there now is
// first copied to data/backups/before-restore-<time>/, so a restore can be undone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/restore-backup.mjs <epb-backup-YYYY-MM-DD.json.gz>");
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
} catch (err) {
  console.error("Not a readable backup file:", err instanceof Error ? err.message : err);
  process.exit(1);
}
if (bundle?.kind !== "epb-backup" || typeof bundle.files !== "object") {
  console.error("This is not an EPB backup.");
  process.exit(1);
}

const dataDir = resolve(root, process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const saveDir = join(dataDir, "backups", `before-restore-${stamp}`);

let restored = 0;
for (const [name, content] of Object.entries(bundle.files)) {
  // Only plain data-file names: nothing can be written outside the data folder.
  if (!/^telegram-[a-z0-9-]+\.json$/.test(name) || typeof content !== "string") {
    console.warn("skipped:", name);
    continue;
  }
  try {
    JSON.parse(content);
  } catch {
    console.warn("skipped (broken JSON):", name);
    continue;
  }
  const dest = join(dataDir, name);
  if (existsSync(dest)) {
    mkdirSync(saveDir, { recursive: true });
    copyFileSync(dest, join(saveDir, name));
  }
  writeFileSync(dest, content);
  restored += 1;
  console.log("restored:", name);
}
console.log(`Done: ${restored} files from ${bundle.createdAt || "?"} into ${dataDir}.`);
if (existsSync(saveDir)) console.log(`Previous files saved in ${saveDir}`);
