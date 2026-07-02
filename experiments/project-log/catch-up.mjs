#!/usr/bin/env node
// catch-up.mjs — a readable activity log for a Circuit project (and across many).
//
// Prototype. Lives in experiments/, touches nothing in the engine, reads only
// local disk. The point: Circuit already RECORDS what happened in structured
// form, so this can READ rather than reconstruct the way the /catch-up skill
// has to (git + transcript). It fuses three on-disk signals per project:
//
//   1. Circuit runs        .circuit/runs/<id>/reports/{result,operator-summary}.json
//   2. Last chat session   .circuit/continuity/records/*.json (harvested goal/state)
//   3. Git                 commits, branch, working-tree status
//
// Usage:
//   node catch-up.mjs                 briefing for the current project (cwd)
//   node catch-up.mjs <path>          briefing for a specific project
//   node catch-up.mjs --all           portfolio roll-up across ~/Code
//   node catch-up.mjs --all --root <dir>
//   flags: --days <n> (window, default 21), --json, --no-color

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ---------- args ----------
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--days', '--root']);
const flags = new Set();
const positionals = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    opts[a] = argv[i + 1];
    i++; // consume the value so it is not mistaken for a target path
  } else if (a.startsWith('--')) {
    flags.add(a);
  } else {
    positionals.push(a);
  }
}
const getOpt = (name, fallback) => opts[name] ?? fallback;
const WINDOW_DAYS = Number(getOpt('--days', '21'));
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const AS_JSON = flags.has('--json');
const NO_COLOR = flags.has('--no-color') || !process.stdout.isTTY;
const ALL = flags.has('--all') || flags.has('--portfolio');
const ROOT_DIR = resolve(expandHome(getOpt('--root', join(homedir(), 'Code'))));

// ---------- tiny helpers ----------
function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function relTime(ms) {
  if (!ms) return 'unknown';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}
function clip(s, n) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// ---------- color ----------
const C = NO_COLOR
  ? new Proxy({}, { get: () => (s) => s })
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      mag: (s) => `\x1b[35m${s}\x1b[0m`,
    };

// Color an outcome word the way a reader scans it: done = good, stopped/blocked
// = needs eyes, anything else = neutral.
function paintOutcome(outcome) {
  if (!outcome) return C.dim('open');
  if (outcome === 'complete') return C.green('complete');
  if (outcome === 'stopped' || outcome === 'aborted') return C.yellow(outcome);
  if (outcome === 'handoff') return C.cyan('handoff');
  return outcome;
}

// ---------- gather one project ----------
function pendingCheckpoints(runFolder) {
  const dir = join(runFolder, 'reports', 'checkpoints');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir);
  const out = [];
  for (const f of files) {
    const m = f.match(/^(.*)-request\.json$/);
    if (!m) continue;
    const id = m[1];
    if (files.includes(`${id}-response.json`)) continue; // already answered
    const req = readJSON(join(dir, f)) || {};
    out.push({
      id,
      prompt: req.prompt || req.question || req.title || '(decision)',
      choices: Array.isArray(req.choices)
        ? req.choices.map((c) => c.label || c.id || c.title).filter(Boolean)
        : [],
    });
  }
  return out;
}

function latestContinuity(root) {
  const dir = join(root, '.circuit', 'continuity', 'records');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const rec = readJSON(join(dir, f));
    if (!rec || !rec.created_at) continue;
    const when = Date.parse(rec.created_at);
    if (!best || when > best.when) best = { when, rec };
  }
  return best;
}

function gatherProject(root) {
  const runsDir = join(root, '.circuit', 'runs');
  const runs = [];
  if (existsSync(runsDir)) {
    for (const id of readdirSync(runsDir)) {
      const rf = join(runsDir, id);
      let isDir = false;
      try {
        isDir = statSync(rf).isDirectory();
      } catch {
        /* ignore */
      }
      if (!isDir) continue;
      const result = readJSON(join(rf, 'reports', 'result.json'));
      const summary = readJSON(join(rf, 'reports', 'operator-summary.json'));
      const pending = pendingCheckpoints(rf);
      const when = result?.closed_at ? Date.parse(result.closed_at) : mtimeMs(rf);
      runs.push({
        id,
        result,
        summary,
        pending,
        closed: !!result,
        when,
      });
    }
  }
  runs.sort((a, b) => b.when - a.when);

  const continuity = latestContinuity(root);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const lastCommitEpoch = Number(git(root, ['log', '-1', '--format=%ct']) || 0) * 1000;

  // Most recent thing that happened in this project, from any signal.
  const lastActivity = Math.max(
    runs[0]?.when || 0,
    continuity?.when || 0,
    lastCommitEpoch || 0,
  );

  const inWindow = (r) => r.when >= Date.now() - WINDOW_MS;
  const openRuns = runs.filter((r) => !r.closed);
  // A decision only counts as "waiting on you" if it is recent. Old parked
  // test runs are noise, not a live fork — surface them only as a count.
  const waiting = runs.filter((r) => r.pending.length > 0 && inWindow(r));
  const staleWaiting = runs.filter((r) => r.pending.length > 0 && !inWindow(r)).length;

  return {
    root,
    name: basename(root),
    branch,
    runs,
    openRuns,
    waiting,
    staleWaiting,
    continuity,
    lastActivity,
    lastCommitEpoch,
  };
}

// ---------- single-project briefing ----------
function renderBriefing(p) {
  const out = [];
  const header = [
    C.bold(p.name),
    p.branch ? C.dim('·') + ' ' + C.mag(p.branch) : '',
    C.dim('·') + ' last active ' + C.dim(relTime(p.lastActivity)),
  ]
    .filter(Boolean)
    .join('  ');
  out.push('');
  out.push(header);

  const recentRuns = p.runs.filter((r) => r.when >= Date.now() - WINDOW_MS);

  // WHAT'S HAPPENED
  out.push('');
  out.push(C.bold(`WHAT'S HAPPENED`) + C.dim(`  (last ${WINDOW_DAYS} days)`));
  if (recentRuns.length === 0) {
    out.push('  ' + C.dim('No Circuit runs in this window.'));
  } else {
    out.push('  ' + C.dim('Runs'));
    for (const r of recentRuns.slice(0, 8)) {
      const flow = (r.result?.flow_id || r.summary?.flow_id || '?').padEnd(9);
      const goal = clip(r.result?.goal || r.summary?.headline || '(no goal)', 46).padEnd(46);
      const verdict = r.result?.verdict ? C.dim(' · ' + r.result.verdict) : '';
      const tag = r.closed ? paintOutcome(r.result?.outcome) : C.dim('open');
      out.push(
        `    ${C.dim(relTime(r.when).padStart(6))}  ${C.cyan(flow)} ${goal}  ${tag}${verdict}`,
      );
      // one condensed key point from the operator summary, if it adds signal
      const detail = r.summary?.details?.find((d) => !/^Run note:/.test(d));
      if (detail) out.push('            ' + C.dim('└ ' + clip(detail, 78)));
    }
    if (recentRuns.length > 8) {
      out.push('    ' + C.dim(`… and ${recentRuns.length - 8} more`));
    }
  }

  // Git
  const log = git(p.root, ['log', '--oneline', '-30', `--since=${WINDOW_DAYS} days ago`]);
  const commits = log ? log.split('\n').filter(Boolean) : [];
  const status = git(p.root, ['status', '--porcelain']);
  const dirty = status ? status.split('\n').filter(Boolean) : [];
  out.push('  ' + C.dim('Git'));
  if (commits.length) {
    const latest = commits[0].replace(/^\S+\s/, '');
    out.push(
      `    ${commits.length} commit${commits.length === 1 ? '' : 's'} in window · latest: ${C.dim(clip(latest, 60))}`,
    );
  } else {
    out.push('    ' + C.dim('No commits in window.'));
  }
  if (dirty.length) {
    const changed = dirty.filter((l) => !l.startsWith('??')).length;
    const untracked = dirty.filter((l) => l.startsWith('??')).length;
    out.push(`    ${C.yellow('Uncommitted')}: ${changed} changed, ${untracked} untracked`);
  }

  // WAITING ON YOU
  if (p.waiting.length || p.staleWaiting) {
    out.push('');
    out.push(C.bold('WAITING ON YOU'));
    for (const r of p.waiting) {
      const goal = clip(r.result?.goal || r.summary?.headline || r.id, 50);
      for (const cp of r.pending) {
        out.push(`    ${C.yellow('▸')} ${goal}  ${C.dim('· ' + relTime(r.when))}`);
        out.push(`      parked at: ${C.bold(clip(cp.prompt, 70))}`);
        if (cp.choices.length) {
          out.push('      ' + cp.choices.map((c, i) => C.dim(`[${i + 1}] `) + clip(c, 30)).join('   '));
        }
        out.push('      ' + C.dim(`resume: circuit run --resume ${r.id}`));
      }
    }
    if (p.staleWaiting) {
      out.push(
        '    ' +
          C.dim(
            `(${p.staleWaiting} older parked run${p.staleWaiting === 1 ? '' : 's'} hidden; widen with --days)`,
          ),
      );
    }
  }

  // WHERE YOU LEFT OFF (last chat session). The harvested goal is the payload;
  // the record's "next"/"debt" fields are mostly capture provenance, so skip them.
  if (p.continuity) {
    const n = p.continuity.rec.narrative || {};
    if (n.goal) {
      out.push('');
      out.push(C.bold('WHERE YOU LEFT OFF') + C.dim(`  (last session, ${relTime(p.continuity.when)})`));
      out.push('    ' + clip(n.goal, 88));
    }
  }

  out.push('');
  out.push(
    C.dim(
      'Reads Circuit runs + git + last session snapshot. Chat work with no commit and no run will not show here.',
    ),
  );
  out.push('');
  return out.join('\n');
}

// ---------- portfolio roll-up ----------
function discoverProjects(rootDir) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const root = join(rootDir, name);
    if (existsSync(join(root, '.circuit'))) found.push(root);
  }
  return found;
}

function renderPortfolio(rootDir) {
  const projects = discoverProjects(rootDir)
    .map(gatherProject)
    .filter((p) => p.lastActivity >= Date.now() - WINDOW_MS)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const out = [];
  out.push('');
  out.push(
    C.bold('YOUR PROJECTS') +
      '  ' +
      C.dim(`· ${rootDir} · active in last ${WINDOW_DAYS} days`),
  );
  out.push('');
  if (projects.length === 0) {
    out.push('  ' + C.dim('No Circuit-touched projects active in this window.'));
    out.push('');
    return out.join('\n');
  }

  const nameW = Math.min(22, Math.max(...projects.map((p) => p.name.length)) + 1);
  let totalWaiting = 0;
  for (const p of projects) {
    const dot = p.waiting.length ? C.yellow('●') : C.green('●');
    const runN = `${p.runs.length} run${p.runs.length === 1 ? '' : 's'}`;
    const waitN = p.waiting.length ? C.yellow(`· ${p.waiting.length} waiting`) : C.dim('· clear');
    totalWaiting += p.waiting.length;
    out.push(
      `  ${dot} ${C.bold(clip(p.name, nameW).padEnd(nameW))} ${C.dim(relTime(p.lastActivity).padStart(7))}   ${runN.padEnd(8)} ${waitN}   ${C.mag(clip(p.branch || '', 34))}`,
    );
  }
  out.push('');
  if (totalWaiting) {
    out.push(
      '  ' +
        C.yellow(
          `${totalWaiting} decision${totalWaiting === 1 ? '' : 's'} waiting on you across ${projects.filter((p) => p.waiting.length).length} project${projects.filter((p) => p.waiting.length).length === 1 ? '' : 's'}.`,
        ),
    );
  } else {
    out.push('  ' + C.dim('Nothing waiting on you.'));
  }
  out.push('  ' + C.dim('Full briefing: node catch-up.mjs <project-path>'));
  out.push('');
  return out.join('\n');
}

// ---------- main ----------
function main() {
  if (ALL) {
    if (AS_JSON) {
      const projects = discoverProjects(ROOT_DIR)
        .map(gatherProject)
        .filter((p) => p.lastActivity >= Date.now() - WINDOW_MS)
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .map((p) => ({
          name: p.name,
          root: p.root,
          branch: p.branch,
          runs: p.runs.length,
          waiting: p.waiting.length,
          last_activity: p.lastActivity ? new Date(p.lastActivity).toISOString() : null,
        }));
      process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderPortfolio(ROOT_DIR));
    return;
  }

  const target = resolve(expandHome(positionals[0] || process.cwd()));
  if (!existsSync(join(target, '.circuit'))) {
    process.stderr.write(
      `No .circuit store at ${target}. This project has no Circuit runs yet.\n` +
        `Git and last-session signals still work; try --all for the portfolio view.\n`,
    );
  }
  const p = gatherProject(target);
  if (AS_JSON) {
    process.stdout.write(
      JSON.stringify(
        {
          name: p.name,
          branch: p.branch,
          last_activity: p.lastActivity ? new Date(p.lastActivity).toISOString() : null,
          runs: p.runs.map((r) => ({
            id: r.id,
            flow: r.result?.flow_id || r.summary?.flow_id,
            goal: r.result?.goal,
            outcome: r.result?.outcome || 'open',
            verdict: r.result?.verdict,
            when: r.when ? new Date(r.when).toISOString() : null,
            pending: r.pending,
          })),
          waiting: p.waiting.length,
          continuity: p.continuity?.rec?.narrative?.goal || null,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  process.stdout.write(renderBriefing(p));
}

main();
