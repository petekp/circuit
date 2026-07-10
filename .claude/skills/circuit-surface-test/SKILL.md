---
name: circuit-surface-test
description: Comprehensively manually test the Circuit plugin's user-facing surface in the current host, Claude Code or Codex. Use this skill whenever the user asks to "manually test Circuit", "QA the Circuit plugin", "exercise the Circuit surface", "run the Circuit checklist", "smoke test Circuit", "find regressions in Circuit", "test the Circuit plugin", "test the Claude Circuit plugin", "test the Codex Circuit plugin", or when preparing a Circuit release for marketplace publication. If no host is named, automatically test the host you are currently running in. Before testing, refresh generated plugin output and sync local host plugin caches from the current Circuit checkout so the run never exercises a stale cached plugin. Produces a Markdown report with per-command pass/fail, exploratory findings ranked by severity, run-folder evidence links, and a concise terminal summary. Use even if the user does not say the word "test" - phrases like "go through every Circuit command" or "make sure Circuit still works end-to-end" should also trigger.
---

# Circuit Surface Test

You are about to act as a QA tester for the Circuit plugin. The user has asked
you to walk the user-facing surface of the plugin in the current host
(Claude Code or Codex), looking for regressions, broken progress rendering,
missing summaries, and other defects a real user would hit.

This skill is a protocol, not a script. It tells you what to test, in what
order, what counts as a finding, and what to put in the report. The source
inventory and two host-specific checklists in `references/` carry the
per-command details.

## Host selection

Default to the host you are currently running in:

- `claude` — the Claude Code plugin at `plugins/claude/`. The published slash
  commands are `/circuit:run`, `/circuit:handoff`, and `/circuit:pursue`.
  Built-in flows (build, explore, fix, prototype, review) are routed through
  Run; they ship as compiled flow mirrors under `plugins/claude/skills/<flow>/`,
  not as separate slash commands. Pursue is both Run-routable and a direct
  slash command, and it also ships a compiled mirror like the other flows.
- `codex` — the Codex plugin at `plugins/codex/`. The published Codex
  commands/skills are `run`, `handoff`, and `pursue`; the other flows are
  routed through Run and ship as compiled mirrors under
  `plugins/codex/flows/<flow>/`. Pursue ships a compiled mirror too.

If the user does not name a host, do not ask. Infer it from the execution
context: Codex means `codex`; Claude Code means `claude`. If the user explicitly
names the other host, honor that as a cross-host test and record the limit in
the report. If the execution context is genuinely unknowable, stop with a
blocker instead of guessing.

## Native vs. cross-host execution

Circuit's surface is meant to be triggered from the host the plugin targets.
The normal path is native: current host equals tested host. Cross-host testing
only happens when the user explicitly asks for the other host.

| You are running in | Host to test by default | Execution mode |
|---|---|---|
| Claude Code | `claude` | **Native.** Use real `/circuit:*` slash commands. |
| Codex | `codex` | **Native.** Use real Codex Circuit skills. |

| Explicit override | Execution mode |
|---|---|
| Claude Code testing `codex` | **Cross-host.** Slash commands won't work for the Codex package. Drop to CLI-only and inspect the Codex skill manifests for surface coverage. Note this clearly in the report. |
| Codex testing `claude` | **Cross-host.** Same situation, reversed. |

When you can't natively invoke a host's surface, you are testing a strict
subset (CLI behavior + manifest correctness). State that limitation in the
report's `Environment` block so the operator isn't misled.

## Why this skill exists

Circuit's automated tests cover runtime contracts, generated surfaces, and
focused connector paths. They do not prove every installed host package path,
native rendering path, wrapper injection, and real worker subprocess shape in
one user-facing pass. **The whole point of this protocol is exercising the
installed or packaged host surface against strict schemas.**

Freshness is part of the surface. Before any checklist row runs, rebuild the
current plugin package from the Circuit checkout, replace the local host plugin
caches from that package, and prove the installed caches match. Do not continue
with a stale cache and downgrade it to a finding. If cache sync, cache check, or
installed-plugin doctor fails after sync, stop before the checklist and report a
blocked test setup. If the current host caches command or skill metadata at
session start, reload the host surface after cache sync before native rows. If
you cannot reload it in the current environment, use the refreshed wrapper for
CLI-backed rows and mark native UI rows partial-skip instead of treating a
pre-sync loaded command as authoritative.

Concrete consequence: before declaring a clean run, you must have executed at
least one default-axis invocation per public flow against the real connector,
reached either through Run (host model recommendation — routing is model-only,
there is no deterministic router) or the explicit CLI flow start; pursue is the
only flow that also ships its own host command. If a
default-axis flow aborts on its first relay step, that is the headline finding
and the rest of the surface coverage is moot until it's fixed. Section A0 of the
checklist exists for exactly this reason — run it first, stop on structural
failure.

## Why you should be checklist-first, exploratory-second

Circuit is a tool with many entry points, modes, and outcomes. Skipping
straight to exploratory testing tends to find one or two showy bugs and miss
the boring regressions that matter for a release. Inverting the order — run a
fixed checklist first, then circle back to anything that looked off and probe
deeper — gives the operator both a baseline pass-rate signal and a ranked
issues list.

Run the checklist for the chosen host. Mark each item pass /
pass-with-finding / fail / skipped / partial-skip with a one-line note and a
pointer to its run folder. Then, for any failures or anything that smelled wrong
(slow, ugly progress output, vague error, missing field in the summary), do a
focused exploratory pass.

## Test environment

Code-changing Circuit flows mutate files. Running them
against the user's working repo would damage the actual project. Before
starting, set up an isolated scratch repo unless the user has told you to
test against the live repo.

```bash
# macOS mktemp -t treats the suffix as a literal — drop the trailing X's
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/circuit-surface-test.XXXXXX")
cd "$SCRATCH"
git init -q
echo "# scratch fixture for circuit-surface-test" > README.md
echo "function add(a, b) { return a + b; }" > add.js
echo "function buggyAdd(a, b) { return a - b; }" > bug.js

# Stub package.json so flows that emit a verify step have something to run.
# Without this, Build's verify step has nothing to invoke and may abort the
# run even when the implementation step landed correct edits.
cat > package.json <<'JSON'
{
  "name": "scratch",
  "private": true,
  "scripts": {
    "verify": "echo ok",
    "test": "echo ok",
    "check": "echo ok",
    "lint": "echo ok"
  }
}
JSON

git add -A && git -c user.email=qa@example.com -c user.name=qa commit -q -m "fixture"
echo "Scratch: $SCRATCH"
```

The `bug.js` file is a planted bug for exercising Fix. The `add.js` file
gives Build something innocuous to act on. The stub `package.json` ensures
verify-style steps have an executable target.
Add more fixture files only if a checklist item asks for one.

**Skill-Hooks setup (Section F only).** Project skill-hook policy goes in
`$SCRATCH/.circuit/config.yaml` (user-global alternative:
`~/.config/circuit/config.yaml`). Run Section F rows through the host wrapper
with cwd at `$SCRATCH` — bare `bin/circuit` from a scratch cwd fails flow
resolution before config even loads. For auto-injection rows, pre-install a
resolvable local skill at `~/.agents/skills/<id>/SKILL.md` (or
`~/.claude/skills/<id>/SKILL.md`); Circuit discovers only flat `<root>/<id>/SKILL.md`
folders, so namespaced plugin/marketplace skills are not discoverable. With no
`skill_hooks` config the Skill-Hooks surface is silent by design (the opt-in
gate), so do not flag the absent section as a regression on a default run.

For Explore and Review you can stay inside the scratch repo (or, if the user
explicitly asks, the live Circuit repo) — those flows do not mutate.

### Development override when debugging a source checkout

Surface tests should use the refreshed installed plugin root produced by the
cache-sync gate. The wrapper uses its bundled runtime by default. If you
explicitly need to debug a source checkout while operating on the scratch repo,
pass the source CLI as a development override and keep the shell cwd at
`$SCRATCH`. Mark that run as source-debug coverage, not installed-surface
coverage:

```bash
cd "$SCRATCH"
CIRCUIT_CLI="$WORKTREE/bin/circuit" \
  node "$WORKTREE/plugins/claude/scripts/circuit.ts" run <flow> ...
```

Do not set project-root environment variables just to make the wrapper find a
runtime. The project root the flow operates on should stay the scratch repo
unless the operator explicitly asked for live-repo coverage.

## Report path

The report and per-run-folder evidence must outlive the scratch repo, since
operators sometimes want to re-read findings days later and `mktemp -d`
output gets cleaned. Default location:

```bash
REPORT_ROOT="$HOME/circuit-surface-test/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir -p "$REPORT_ROOT"
```

If the user passed an explicit `--keep-report-at <path>` (or set
`CIRCUIT_SURFACE_TEST_REPORT_ROOT`), use that instead. Pass
`--run-folder "$REPORT_ROOT/<flow-id>"` to every Circuit invocation so all
evidence lands inside the report tree, not inside the scratch repo. Write
the final report to `$REPORT_ROOT/report.md`.

## The protocol

Follow these steps in order. Do not improvise the order of phases — the
phases exist to keep the report honest.

### 1. Select the host and refresh the installed package

Set `HOST` before reading the checklist:

```bash
# Default this from your execution context; explicit user host names override it.
# Codex session: HOST=codex
# Claude Code session: HOST=claude
HOST="<claude|codex>"
```

Read `references/current-surface-inventory.md` in full, then run its evidence
commands from the current Circuit checkout. The evidence commands now include
the latest-state gate:

1. Run the single local refresh command (`npm run plugins:refresh-local`).
2. Confirm its output shows fresh Claude and Codex cache targets and installed
   doctor success.

If any of those commands fails, stop before the checklist. Do not continue
against the repo wrapper or an older host cache and call it a surface test.
Record the failed command, stdout/stderr path, and the stale or missing cache
details in the report.

Record the observed commit, dirty state, host packages, cache sync targets, CLI
help, wrapper versions, wrapper doctor summaries, and installed-package doctor
result in the report. Local refresh is a test precondition, not a public
marketplace publish.

The generated source map, generated host packages, local CLI/help output,
runtime bundles, contracts, and specs are authority. If the checklist and the
inventory disagree, trust the observable source, mark the checklist row stale,
and record a finding against this skill rather than inventing expected behavior.

### 2. Read the host checklist

Read either `references/checklist-claude.md` or `references/checklist-codex.md`
in full. Each checklist enumerates every command/skill, the axis flags to
test, the expected outcomes, and what counts as a finding. Do not paraphrase
items from memory — read them.

### 3. Set up the environment

Create the scratch repo as described above. Resolve the plugin root from the
refreshed installed cache for the chosen host. Do not point `$PLUGIN_ROOT` at
`$CIRCUIT_REPO/plugins/<host>` for canonical surface rows; that bypasses the
cache freshness proof.

```bash
CIRCUIT_REPO="${CIRCUIT_REPO:-/Users/petepetrash/Code/circuit}"
PLUGIN_VERSION="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); console.log(JSON.parse(fs.readFileSync(path.join(process.argv[1],"plugins/version.json"),"utf8")).version)' "$CIRCUIT_REPO")"
case "$HOST" in
  claude)
    PLUGIN_ROOT="${HOME}/.claude/plugins/cache/circuit/circuit/${PLUGIN_VERSION}"
    ;;
  codex)
    CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
    PLUGIN_ROOT="${CODEX_HOME}/plugins/cache/circuit-local/circuit/${PLUGIN_VERSION}"
    ;;
  *)
    echo "unknown HOST: $HOST" >&2
    exit 2
    ;;
esac
```

Sanity-check the plugin actually exists and the CLI runs:

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" --help
node "$PLUGIN_ROOT/scripts/circuit.ts" version --json
node "$PLUGIN_ROOT/scripts/circuit.ts" doctor --json
```

If any of those fail, stop. Record the failure in the report's `Environment`
block and surface it to the user — the rest of the checklist is moot.

Then snapshot the version under test so the report names exactly what
got exercised:

```bash
git -C "$CIRCUIT_REPO" log -1 --format='%H %s'
git -C "$CIRCUIT_REPO" status --short
node "$PLUGIN_ROOT/scripts/circuit.ts" version --json
```

Record the commit, plugin version, and any uncommitted-files list in
the report's `Environment` block. If `git status` shows uncommitted
changes that affect plugin behavior (anything in `plugins/`, `src/`,
`commands/`, `scripts/`), call them out explicitly — the test only
exercises committed state if you ran `npm run build` after switching
worktrees, so divergence between working-tree intent and what's
actually being tested is itself a finding worth surfacing.

### 3b. Wrapper vs. bare CLI

The plugin ships a wrapper at `$PLUGIN_ROOT/scripts/circuit.ts` which
injects packaged-flow paths and other host-specific arguments before
forwarding to the underlying CLI. The wrapper has its own injection logic
and is a separate failure surface from the bare bin.

Whenever a checklist row is exercised through the host, you are testing the
wrapper. CLI fallback rows in the checklists already use the wrapper path,
so most coverage is automatic. But if you spot a wrapper-specific bug
(e.g. wrapper injects a flag the underlying subcommand rejects), confirm it
also fails through the host and reproduces against the wrapper from a
plain shell — not just against `bin/circuit` directly. Wrapper-only
bugs are easy to miss if the bare bin is your default debugging path.

### 4. Phase 1 — run the checklist

Walk the checklist top to bottom. For each item:

1. Construct the invocation per the checklist. Native invocations go through
   the host (slash command or Codex skill). Cross-host or "host can't expose
   this" items go through the CLI directly with the same arguments the host
   would have constructed.
2. Run it.
3. Capture stdout/stderr (or the host-rendered output) and the run folder
   path.
4. Apply the checklist's pass criteria. Use this five-state rubric:
   - **pass** — every criterion holds.
   - **pass-with-finding** — the user-observable goal of the row was met
     (e.g., the file edit landed correctly, the summary rendered) but a
     non-fatal criterion broke (e.g., the run reported `outcome: aborted`
     even though the implementation step succeeded). Record the row as
     pass-with-finding and file a separate exploratory finding for the
     broken criterion. Without this tier, every "edits landed but verify
     cycle aborted the run" turns into a Fail and obscures the real
     regression count.
   - **fail** — the row's goal was not met.
   - **skipped** — the item cannot run in this environment. Note why.
   - **partial-skip** — a file-backed or CLI-backed degraded check ran, but
     native host rendering or host UI behavior still needs an interactive
     session. Use this for operator-summary file checks when you cannot observe
     the real host render.
5. Move to the next item. Do NOT pause to fix or investigate failures during
   this phase — finish the checklist first, then come back. This keeps the
   pass-rate signal clean and prevents the test session from rabbit-holing
   on the first regression. **The one exception** is Section A0's
   structural smoke matrix: a schema-validation abort there compounds
   across many downstream rows, so A0 explicitly authorizes stopping
   and consulting the operator before continuing. Anywhere else in the
   checklist, take the note and move on.

### 5. Phase 2 — exploratory pass

After the checklist is complete, look at every fail and every "smelled
wrong" pass (slow, weird progress text, surprising summary, ambiguous error,
sluggish render between events). Pick the most suspicious 3-5 and probe
deeper. The probes that tend to find real issues:

- **Adversarial input**: pass tasks containing single-quotes, double-quotes,
  backticks, `$(cmd)`-shaped substrings, embedded newlines. The shell-escape
  rule in every command requires single-quote wrapping with `'\''` for
  literal apostrophes — verify it actually holds.
- **Axis combinations** the checklist did not cover. Try valid combinations
  such as Explore `--depth high --tournament 2`, power dials
  (`--power low`, `--power auto`), and supported autonomous runs. Also test
  fail-closed combinations such as Build `--tournament`, Review `--autonomous`,
  and `--tournament 5` outside the v1 range.
- **Checkpoint resume**: trigger a checkpoint-waiting outcome, kill the
  session, and resume with `--checkpoint-choice` from a fresh shell.
- **Operator-summary completeness**: the host commands render the readable digest
  (`operator_summary_markdown_path`) verbatim when present, falling back to
  `run_surface_markdown_path` only when the digest is absent. Verify the rendered
  summary matches the digest file, not the run surface. When
  `operator_summary_status_text` or `operator_summary_html_path` is present,
  verify host behavior against `docs/contracts/host-rendering.md`.
- **Outcome legibility**: drive a non-`complete` outcome (the `runtime-proof`
  internal flow aborts deterministically offline; `goal` closes `stopped`) and
  confirm the digest reads as an honest failure with a `reason`, never as a
  neutral or complete result. `escalated` in particular must not render as a
  false success.
- **Skill hooks**: if the build under test has Skill Hooks, author a small
  `.circuit/config.yaml` policy (see Section F) and confirm a fired hook is
  disclosed in the digest's `## Skill hooks` section — and that a run with no
  config shows no skill-hook surface at all.
- **Untracked content**: in Review, confirm `--include-untracked-content`
  changes behavior (default omits content; flag includes it).
- **Cross-flow handoff**: save a handoff in the middle of a Build, resume
  it, confirm the saved state is faithful.

For each probe, write down what you tried, what happened, and what the
expected behavior was if the result looks wrong.

### 6. Run one local protocol smoke

Before writing the final report, run at least one local smoke that proves the
protocol can be followed without depending on a live worker connector. Good
minimum smokes:

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" version --json
node "$PLUGIN_ROOT/scripts/circuit.ts" doctor --json
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff save \
  --goal 'surface-test protocol smoke' \
  --next 'confirm wrapper accepts utility subcommand args' \
  --state-markdown 'scratch session' \
  --debt-markdown 'none' \
  --progress jsonl
```

Record the smoke transcript and result in the report. This smoke is not a
replacement for the checklist; it only proves the revised protocol's local
setup and wrapper path can be followed.

### 7. Write the report

Use `assets/report-template.md` as the structure. Fill every section. The
report must be self-contained — someone reading it without your terminal
should be able to assess plugin health. In particular:

- **Ranked findings.** Stack-rank exploratory findings by severity (Critical,
  High, Medium, Low). Do not bury big problems behind small ones.
- **Repro for every finding.** Every finding gets a one-paragraph repro:
  command run, expected, actual, run folder path or transcript snippet.
- **Source-backed inventory.** Include the current commands, public/internal
  flows, generated host packages, axis allow-list, runtime bundle result,
  operator-summary fields observed, and any host-only limits.
- **Pass-rate.** Surface the checklist pass rate (e.g. `27/31 pass, 3 fail,
  1 pass-with-finding, 1 skipped, 2 partial-skip`) at the top.

Save the report to the path described in "Report path" above.

### 8. Print a concise terminal summary

After saving the report, print to the terminal — verbatim, no preamble:

```
Circuit surface test — host: <claude|codex>
Pass rate: <P>/<T> (<F> failed, <PWF> pass-with-finding, <S> skipped, <PS> partial-skip)
Critical: <count> | High: <count> | Medium: <count> | Low: <count>
Top findings:
  1. <highest-severity finding> — <one-line>
  2. <next highest> — <one-line>
  3. <next highest> — <one-line>
Report: <absolute report path>
Scratch repo: <absolute scratch path>
```

Top findings are the three highest-severity findings overall — Critical
first, then High, then Medium — not one-per-bucket. If there are fewer than
three findings, list however many there are. The operator wants to glance
and know the health number without opening the file.

## What counts as a finding

A finding is anything a real user would notice and complain about. Concretely:

- A command crashes or returns a non-zero exit code where success was
  expected.
- The host fails to render visible `presentation.status_text`, or when
  `presentation` is absent, a visible `display.text` event.
- The final operator summary is missing, truncated, or differs from the file
  it claims to render.
- A documented flag is rejected, silently ignored, or behaves opposite to
  its description.
- An unsupported flag such as `--mode` or `--rigor` appears in a generated host
  surface or checklist row.
- A generated public flow is missing from the surface inventory, or a host
  direct command/skill is claimed for a flow that only has packaged CLI JSON.
- Shell-escape handling is wrong — special characters in task text either
  blow up the command or appear mangled in the output.
- A checkpoint-waiting outcome cannot be resumed cleanly.
- An aborted outcome surfaces no abort reason or surfaces the wrong one.
- A failure outcome (`aborted`, `escalated`, `failed`, `blocked`) reads as a
  neutral or complete result instead of an honest failure — `escalated`
  rendering as a false success is the specific regression the failure-legibility
  work fixed.
- The host renders the compact run surface (`CIRCUIT` / `⎿ <status>`) as the
  final answer while the readable digest exists on disk (digest-first is the
  contract).
- A configured-and-firing skill hook produces no `skill_hook_activations` entry
  and no `## Skill hooks` digest section (silent injection — a legibility
  regression), or the section appears on a run with no `skill_hooks` config.
- Time-to-first-useful-output is dramatically worse than expected (subjective
  but worth noting — log it as Medium and let the operator decide).

A finding is NOT:

- The flow doing something you personally would not have done. You are
  testing the surface, not the flow's judgment.
- The flow taking a long time on a real task — only worth flagging if the
  CLI itself is unresponsive (no progress events for >30s when work is
  ongoing).

## Voice and posture

You are testing on the operator's behalf. Be terse and concrete in the
report. Do not soften findings to be polite. If something is broken, say it
is broken and show the repro. If everything passed, say so plainly — a clean
report is a real result.

## Authority

- `references/checklist-claude.md` — Claude Code surface checklist
- `references/checklist-codex.md` — Codex surface checklist
- `references/current-surface-inventory.md` — current source-backed surface map
- `assets/report-template.md` — report structure
- The Circuit plugin source under `plugins/claude/` and `plugins/codex/`
- The CLI source at `src/cli/circuit.ts`
