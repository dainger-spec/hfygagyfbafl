#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".output", "server", "index.mjs");
const archive = join(root, "dist-output.tgz");

function hasVite() {
  try {
    createRequire(import.meta.url).resolve("vite", { paths: [root] });
    return true;
  } catch {
    return false;
  }
}

if (existsSync(output)) {
  process.exit(0);
}

if (existsSync(archive)) {
  mkdirSync(join(root, ".output"), { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", root], { stdio: "inherit" });
  if (unpacked.status === 0 && existsSync(output)) process.exit(0);
}

if (hasVite()) {
  const built = spawnSync(
    process.execPath,
    [join(root, "scripts/with-app-env.mjs"), "vite", "build"],
    { stdio: "inherit", cwd: root, env: process.env },
  );
  process.exit(built.status ?? 1);
}

console.error("Нет готовой сборки и нет пакета vite. Залейте новый архив с dist-output.tgz.");
process.exit(1);
