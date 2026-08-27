#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prep = spawnSync(process.execPath, [join(root, "scripts/ensure-build.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
if (prep.status) process.exit(prep.status ?? 1);
await import(pathToFileURL(join(root, ".output/server/index.mjs")).href);
