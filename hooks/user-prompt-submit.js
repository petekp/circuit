#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const pluginRoot = resolve(__dirname, "..");
const cliPath = resolve(pluginRoot, "scripts/runtime/bin/user-prompt-submit.js");
const nodeBin = process.env.NODE_BIN || process.execPath;
const input = readFileSync(0, "utf-8");

const result = spawnSync(nodeBin, [cliPath], {
  encoding: "utf-8",
  env: process.env,
  input,
});

if (typeof result.stdout === "string" && result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (typeof result.stderr === "string" && result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exit(result.status ?? 1);
