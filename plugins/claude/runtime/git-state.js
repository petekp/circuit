#!/usr/bin/env node

// src/shared/git-state.ts
import { execFileSync } from "node:child_process";
import process from "node:process";
var SYSTEM_GIT = "/usr/bin/git";
var GIT_EXECUTABLE = process.env.CIRCUIT_MCP_PROOF_SANDBOX === "1" && process.platform === "darwin" ? SYSTEM_GIT : "git";
var GIT_GLOBAL_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "interactive.diffFilter=",
  "-c",
  "submodule.recurse=false"
];
function git(args) {
  return execFileSync(GIT_EXECUTABLE, [...GIT_GLOBAL_ARGS, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 5e7
  });
}
function gitBytes(args) {
  return execFileSync(GIT_EXECUTABLE, [...GIT_GLOBAL_ARGS, ...args], {
    cwd: process.cwd(),
    maxBuffer: 5e7
  });
}
function fail(message) {
  process.stderr.write(`fix-git-state: ${message}
`);
  process.exit(1);
}
var head;
try {
  head = git(["rev-parse", "HEAD"]).trim();
} catch (err) {
  fail(`git rev-parse HEAD failed: ${err instanceof Error ? err.message : String(err)}`);
}
var statusBuf;
try {
  statusBuf = gitBytes([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all"
  ]);
} catch (err) {
  fail(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
}
var entries = [];
{
  const text = statusBuf.toString("utf8");
  let i = 0;
  while (i < text.length) {
    if (text.length - i < 4) break;
    const code = text.slice(i, i + 2);
    i += 2;
    if (text[i] !== " ") {
      const next = text.indexOf("\0", i);
      i = next === -1 ? text.length : next + 1;
      continue;
    }
    i += 1;
    const endA = text.indexOf("\0", i);
    if (endA === -1) break;
    const path = text.slice(i, endA);
    i = endA + 1;
    let fromPath;
    const statusKind = code[0];
    const isRenameOrCopy = statusKind === "R" || statusKind === "C";
    if (isRenameOrCopy) {
      const endB = text.indexOf("\0", i);
      if (endB === -1) break;
      fromPath = text.slice(i, endB);
      i = endB + 1;
    }
    let fingerprint;
    const isDeleted = code.includes("D");
    if (isDeleted) {
      fingerprint = "<deleted>";
    } else {
      try {
        fingerprint = git(["hash-object", "--no-filters", "--", path]).trim();
      } catch (err) {
        const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
        fingerprint = `<unhashable:${reason}>`;
      }
    }
    const entry = { status_code: code, path, fingerprint };
    if (fromPath !== void 0) entry.from = fromPath;
    entries.push(entry);
  }
}
var hiddenIndexFlags = [];
try {
  const lsFiles = git(["ls-files", "-v"]);
  for (const line of lsFiles.split("\n")) {
    if (line.length < 2) continue;
    const tag = line[0];
    if (tag === void 0) continue;
    const rest = line.slice(2);
    if (tag !== tag.toLowerCase()) continue;
    if (tag === " ") continue;
    hiddenIndexFlags.push({ tag, path: rest });
  }
} catch {
}
process.stdout.write(
  JSON.stringify({ head_sha: head, entries, hidden_index_flags: hiddenIndexFlags })
);
