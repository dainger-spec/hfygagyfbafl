#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".output", "server", "index.mjs");
const archive = join(root, "dist-output.tgz");

if (existsSync(output)) process.exit(0);

if (!existsSync(archive)) {
  console.error("Нет dist-output.tgz. Залейте полный архив.");
  process.exit(1);
}

mkdirSync(root, { recursive: true });
const unpacked = spawnSync("tar", ["-xzf", archive, "-C", root], { stdio: "inherit" });
if (unpacked.status === 0 && existsSync(output)) process.exit(0);

console.error("Не удалось распаковать dist-output.tgz");
process.exit(1);
