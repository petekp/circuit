# Faster, more robust continuity restore

Status: design exploration, 2026-06-06. Design only, no engine or runtime
edits. Every current-behavior claim below is cited to source or to a probe
run captured in the Appendix.

## What this explores

How to make restoring continuity faster and more robust at the two moments
the operator feels it: starting a new session, and clearing. In this plugin
both moments are the same code path. The Claude `SessionStart` hook matches
`startup|resume|clear|compact` (`plugins/claude/hooks/hooks.json:5`), so a
fresh start, a `/clear`, and a compaction all run the same brief injection.
"Restore when clearing" and "restore when starting" are therefore one target,
not two.

## The headline finding

Raw restore latency is not the bottleneck. The brief that gets injected runs
in about 0.16s through the real plugin launcher, against a 3000ms hook timeout
(`plugins/claude/hooks/session-start.ts:12`). That is roughly 18x of headroom.
See Appendix A.

So "much faster" splits into two honest readings:

1. Wall-clock speed of the injection. Already fine. The expensive structural
   fixes that target this (a resident daemon, a warm process) are not worth it
   and are rejected below.
2. Time-to-useful-context. This is the real lever. What gets restored today is
   thin, sometimes stale, and silently absent when anything goes wrong. The
   operator pays that cost in re-deriving state by hand, which dwarfs 0.16s.

"More robust" is the larger half of the request and is where most of the value
is.

## Recommendation up front

Do the cheap, high-leverage robustness work first, then the scaling fix, then
correctness, then richness. Reject the daemon.

1. Make restore failures visible (Option A1), and fall through to the ambient
   record when a manual save is broken (Option A4). Tiny changes, together they
   remove invisible continuity loss and total restore loss from one bad record.
2. Add a staleness signal to the brief (Option A2). Small, stops a stale
   snapshot from reading as current.
3. Parse the harvest incrementally (Option B1), or at least throttle it (B2).
   Removes the real wasted work and stops cost growing with session length.
4. Key ambient records per session (Option D1). Stops parallel sessions
   destroying each other's state on disk. Bigger change, do it once the above
   land.
5. Treat richness and clear-semantics (Options C, E) as evidence-gated
   follow-ups, not day-one work.
6. Do not build a resident daemon (Option F1). The saving is real but trivial.

## How restore works today

The full path, both hosts, cited:

1. A session starts, resumes, clears, or compacts. The host fires
   `SessionStart` and runs `session-start.ts`
   (`plugins/claude/hooks/hooks.json:3-13`).
2. The hook reads the host's stdin JSON for `cwd`
   (`plugins/claude/hooks/session-start.ts:27-29,47-51`), then spawns
   `node scripts/circuit.ts handoff brief --json --project-root <cwd>` with a
   3000ms timeout (`session-start.ts:58-67`).
3. `handoff brief` resolves the per-repo control plane, reads
   `index.json`, and picks a record by precedence: a manual `pending_record`
   first, then the mechanical `ambient_record`, then empty
   (`src/cli/handoff.ts:482-488`; `docs/contracts/continuity.md` section
   "Resolver precedence").
4. The chosen record renders to a brief capped at 3000 characters
   (`HANDOFF_BRIEF_MAX_CHARS`, `src/cli/handoff.ts:64`). State and debt are
   truncated to fit while the safety framing is always preserved
   (`src/cli/handoff.ts:299-361`).
5. The hook injects the brief as `additionalContext` only when
   `status === 'available'`; on anything else it returns 0 and injects nothing
   (`session-start.ts:98-110`).

What feeds restore is the harvest, which is the capture side:

6. Every `Stop` and every `SessionEnd` run `harvest.ts`
   (`plugins/claude/hooks/hooks.json:14-33`). `Stop` fires at the end of every
   turn, not just at session end.
7. Harvest reads the whole transcript with `readFileSync` then `split('\n')`
   and scans every line (`src/cli/handoff.ts:1477-1512`). It keeps the last 4
   user intents (`AMBIENT_MAX_INTENTS = 4`), each truncated to 280 characters
   (`AMBIENT_INTENT_MAX_CHARS = 280`, `src/cli/handoff.ts:1358-1360,1509`),
   plus the latest compaction summary and up to 40 lines of git status
   (`src/cli/handoff.ts:1528-1532`).
8. It writes a single record, `ambient-latest`, overwriting it each time
   (`DEFAULT_AMBIENT_RECORD_STEM`, `src/cli/handoff.ts:1358`; confirmed by
   probe, Appendix B). It read-merge-writes the index so a manual
   `pending_record` and any `current_run` survive untouched, moving only the
   `ambient_record` pointer (`src/cli/handoff.ts:1648-1662`). Writes are atomic
   via stage-then-rename (`src/cli/handoff.ts:239-244`).
9. A "nothing to harvest" guard skips the write when there are no intents, no
   summary, and no git status, so a good prior record is never blanked by an
   empty turn (`src/cli/handoff.ts:1594-1602`).

Codex restores the same record through the same brief resolver, but by a
different route, and this distinction matters for any fix. A standalone file
`plugins/codex/hooks/session-start.ts` exists and is byte-identical to the
Claude hook, but it is not what Codex installs. `handoff hooks install --host
codex` registers a hook whose command is `handoff hook --host codex`
(`src/cli/handoff.ts:640-650`), with matcher `startup|resume|clear` (note: no
`compact`, unlike Claude) and a 3 second timeout
(`circuitCodexHookEntry`, `src/cli/handoff.ts:691-701`). That command runs
`runHandoffHook` (`src/cli/handoff.ts:522-573`), which calls `handoffBrief`
in-process rather than spawning a launcher, and swallows every failure the same
way the Claude hook does: `invalid` returns 0 (`:554-556`), non-available
returns 0 (`:558`), an exception is caught and debug-logged (`:568-570`).

So restore is behaviourally parallel across hosts, but there are two distinct
code paths to change, not one: the Claude spawn-based `session-start.ts` and the
Codex in-process `runHandoffHook`. The wiring also differs: Claude ships
`hooks.json` so restore is zero-setup, while Codex requires the install step. If
a Codex user has not installed, there is no restore and no signal that one is
missing.

## What "faster and more robust" means here

Grouped by the failure each option removes.

### A. Restore robustness (cheap, high value)

**A1. Make restore failures visible.**
Today the hook swallows every failure path: a timeout, a non-zero exit,
unparseable JSON, or a `status: invalid` envelope all return 0 with only a
debug-gated warning (`session-start.ts:69-100`). A corrupt `index.json` or a
dangling record pointer produces `status: invalid` (`src/cli/handoff.ts:377-395,
417-445`), which the hook drops silently. The operator sees nothing and cannot
tell "no continuity existed" from "continuity existed but failed to load."
- Mechanism: when the brief returns `invalid`, or the spawn times out or
  errors, emit one short visible line instead of staying silent. Keep the
  `empty` case silent (nothing to say).
- Removes: invisible continuity loss. A broken store currently looks identical
  to a clean one.
- Cost: a few lines, but in two places on the Codex side. The change lands in
  the Claude spawn hook (`session-start.ts`) and again in the Codex in-process
  path (`runHandoffHook`, `src/cli/handoff.ts:522-573`). No schema change.
- Risk: noise if it fires on benign states. Mitigate by only speaking on
  `invalid`, `timeout`, and spawn error, never on `empty`.

**A4. Fall through to the ambient record when a manual save is broken.**
The resolver tries `pending_record` first and returns its result, including an
`invalid` result, without ever trying `ambient_record`
(`src/cli/handoff.ts:482-488`). So a single corrupt or dangling manual save
blinds restore entirely, even when a perfectly good ambient snapshot sits right
behind it. That is the opposite of robust: the safety net exists but is not
reached.
- Mechanism: when `pending_record` resolves to `invalid` (missing file,
  malformed record, kind mismatch), fall through to `ambient_record` instead of
  returning `invalid`. Pair with A1 so the operator still sees that the manual
  save was broken.
- Removes: total restore loss from one bad manual record while a valid fallback
  exists.
- Cost: one branch in `handoffBrief`. No schema change.
- Risk: silently masking a broken manual save. A1 covers that, but note the
  seam: once A4 falls through, the brief returns `available`, not `invalid`, so
  A1's invalid-trigger no longer fires on this case. The fall-through needs to
  thread its own "recovered from a broken manual save" signal to the hook on the
  `available` path, rather than relying on A1's invalid branch.

**A2. Add a staleness signal to the brief.**
`created_at` rides in the record and the brief JSON
(`src/cli/handoff.ts:462,1615`), but the rendered ambient brief never shows age
(`composeAmbientBrief`, `src/cli/handoff.ts:275-291`). Because harvest fires
every `Stop`, the ambient record stays fresh in an active repo; the stale case
is specifically returning to a repo untouched since the last session, where a
snapshot harvested weeks ago is injected as "Latest request" with no hint that
it is old. That narrower case is real and is exactly where a wrong-but-confident
restore does the most harm.
- Mechanism: render the age of the ambient record in the brief, for example
  "captured 3 weeks ago." Optionally age-gate: above some age, downgrade the
  framing or suppress injection and fall through to empty.
- Removes: stale state presented as current, which is worse than no state
  because it misleads.
- Cost: render-time only for the signal. Age-gating adds one resolver branch.
- Risk: an age threshold is a policy choice. Start with a visible signal and no
  hard cutoff; add a cutoff only if a stale-restore incident shows up.

**A3. Codex install assurance.**
The zero-setup asymmetry above means Codex users can silently have no restore.
- Mechanism: a one-time nudge when Circuit runs on Codex and the hook is not
  installed, pointing at `handoff hooks install --host codex`.
- Removes: the silent "Codex has no continuity and never said so" state.
- Cost: a detection point plus a nudge. No schema change.
- Risk: nagging. Make it once-per-repo, not per-session.

### B. Capture cost and scaling ("faster" upstream)

**B1. Parse the transcript incrementally (primary lever).**
Harvest fires on every `Stop`, which is every turn end
(`plugins/claude/hooks/hooks.json:14-23`), and each run re-reads and re-parses
the entire transcript from byte zero (`src/cli/handoff.ts:1477-1512`). Measured
cost is about 0.36s on a 1.8MB, 760-line transcript (Appendix B), and the
transcript only grows, so cumulative capture cost across a session scales with
turns times size. This is the largest pile of avoidable work in the system.
- Mechanism: remember the byte offset or last-parsed line of the transcript and
  read only the tail appended since the last harvest, rather than the whole file.
  Persist that cursor in the control plane next to the ambient record.
- Removes: O(turns x size) repeated full-file parsing. Capture stops getting
  slower as the session grows, while still running every `Stop` so nothing is
  lost on a crash.
- Cost: a small cursor persisted per repo, plus tail-read logic.
- Risk: the transcript can be truncated, rotated, or compacted in place, which
  invalidates the cursor. Detect a shrink or identity change and fall back to a
  full read. This is the load-bearing correctness case for the option.

This is the better lever than throttling because it removes the cost without
giving up per-turn freshness. Throttling (B2) trades freshness for cost;
incremental parse keeps both.

**B2. Throttle the trigger (secondary, only if B1 is too large).**
If the cursor work in B1 feels too big, harvest on `SessionEnd` always plus on
`Stop` only every N turns or every T seconds.
- Removes: most of the repeated full-file parsing with almost no code.
- Cost: a small hook-config and counter change.
- Risk: this is a real freshness loss, not a small one. `SessionEnd` is exactly
  the event least likely to fire on a hard crash, `kill -9`, or a closed
  terminal, which is precisely when you most want the last turns captured. With
  `Stop` throttled to every N turns, the worst case is losing up to N turns plus
  the current one, not "the last few." Keep N small, and prefer B1, which avoids
  the tradeoff entirely.

### C. Capture richness ("faster to useful")

**C1. Capture decisions and next-step, not only user intents.**
Restore today is 4 user messages plus the last compaction summary plus git
status (`src/cli/handoff.ts:1358-1360,1509,1528-1532`). It carries no record of
what was decided or done. A returning session re-derives that by hand, which is
the real "slow to useful."
- Mechanism: also lift the latest assistant-stated next-step or decision from
  the transcript into the harvested state.
- Removes: the re-derivation tax on the human and the next agent.
- Cost: more transcript parsing logic and careful selection.
- Risk: noise and fidelity. Assistant prose is long and not always a clean
  decision. This is the option most likely to make the brief worse, so gate it
  on real evidence that thin state is the felt problem.

**C2. Lean on the compaction summary as the spine.**
The compaction summary is already a distilled state and harvest keeps the
latest one (`src/cli/handoff.ts:1501-1503`). Prefer it as the backbone of the
restored state and layer recent intents on top, rather than treating intents as
primary.
- Removes: thin restores on long sessions that have a good compaction summary.
- Cost: small re-ordering in `composeAmbientStateMarkdown`.
- Risk: low. Bounded by the existing 3000-char cap.

### D. Concurrency correctness

**D1. Key ambient records per session.**
Harvest always writes the single `ambient-latest` record
(`src/cli/handoff.ts:1358`; Appendix B). Two sessions in the same repo, for
example two terminal tabs, race on that one record file: each `Stop` overwrites
the other's, so the losing session's state is destroyed on disk.
- Mechanism: write per-session ambient records keyed by `session_id` and point
  `ambient_record` at the most recent by time. Garbage-collect old per-session
  records.
- Caveat that shapes the design: `session_id` is optional in the schema
  (`src/schemas/continuity.ts:67`, `z.string().min(1).optional()`) and harvest
  only sets it when the host supplies it (`src/cli/handoff.ts:1635`). If the
  host omits it, every session keys to the same fallback and the clobber
  returns. So the option must define a fallback key (for example a per-process
  id) rather than assuming `session_id` is always present.
- Removes: the on-disk data loss. Each session's last state survives as its own
  record instead of being overwritten. It does NOT, by itself, let two tabs each
  restore their own state: the index still has one `ambient_record` pointer
  (`src/cli/handoff.ts:482-488`), so restore still surfaces a single
  most-recent session. Two tabs restoring their respective states would need a
  per-session resolver keyed on the resuming session, which is out of scope
  here. D1 is the necessary first half: stop destroying the data, then a
  resolver can choose among it later.
- Cost: record naming with a fallback key, a GC pass, and a pointer-selection
  rule. The schema already allows it; `record_id` is a `ControlPlaneFileStem`
  (`docs/contracts/continuity.md` section "Path-safe identity").
- Risk: record sprawl without GC, and the fallback-key choice when `session_id`
  is absent.

### E. Clearing semantics

**E1. Decide what `done` does to the ambient record.**
`handoff done` clears `pending_record` and `current_run` but deliberately keeps
`ambient_record` (`src/cli/handoff.ts:1320-1330`). So after the operator
declares a task done, the next session still surfaces that finished task's
recent ambient state. That is sometimes a useful fallback and sometimes a
finished thing resurfacing.
- Mechanism: offer `done` an option to also age or clear the ambient record, or
  surface "this is from a task you marked done" framing.
- Removes: confusion when finished work reappears as a brief.
- Cost: small, one flag and one branch.
- Risk: removing the fallback some users rely on. Make it opt-in, keep
  keep-ambient as the default.

**E2. Make brief injection source-aware (`clear` and `compact`).**
The `SessionStart` matcher fires on four sources, `startup|resume|clear|compact`
(`plugins/claude/hooks/hooks.json:5`), and today the hook injects the same brief
for all of them; it reads only `cwd` from the hook input and ignores the
`source` field (`plugins/claude/hooks/session-start.ts:38-51`). Two of those
sources have different operator intent that the current uniform behaviour
ignores:
- `compact`: right after a compaction the brief re-injects on top of the host's
  own compaction summary, which can duplicate state.
- `clear`: the operator just deliberately wiped context, then the brief
  re-injects a snapshot that may be the very state they cleared. That can feel
  like `/clear` did not work.
- Mechanism: branch on the `source` field already present in the hook input.
  For `compact`, skip injection or inject only what the compaction summary
  lacks. For `clear`, decide whether to suppress, or inject a lighter pointer
  rather than the full snapshot, since the operator's intent on `clear` is
  ambiguous. Leave `startup` and `resume` injecting the full brief.
- Removes: redundant double-context after compaction, and unwanted state
  resurrection right after a manual clear.
- Cost: read the `source` field and branch in both host hooks. No schema change.
- Risk: a compaction or clear that genuinely needed repo state back would no
  longer get it. Make each per-source behaviour a flag, defaulting to today's
  inject-everything so the change is opt-in.

### F. Rejected

**F1. Resident daemon or warm process for the brief.**
A standing process so the brief is near-instant. Rejected, but be precise about
why. The ~0.16s of restore is mostly Node startup and module load: the
`node -e` baseline is 0.02s (Appendix A), so roughly 0.14s is process and import
overhead that a resident process genuinely would remove. So a daemon would
work; it is not that it fails to help. It is rejected because the saving is
real but trivial and paid once per session, about 0.14s against a 3000ms
timeout, while the cost is permanent: a process lifecycle to manage, a new
failure mode when it dies or goes stale, and added complexity. The trade is bad
at this magnitude. Revisit only if a real, reproduced latency regression makes
the per-session cost actually felt.

## Sequenced recommendation

Ordered by value over cost. Each step is independently shippable.

1. A1 and A4, make restore failures visible and fall through to the ambient
   record when a manual save is broken. Cheapest, removes invisible loss and
   total loss from one bad record.
2. A2, staleness signal. Small, stops misleading restores.
3. B1, parse the harvest incrementally (or at least B2, throttle it). Removes
   the real wasted work and the only cost that grows with session length.
4. D1, per-session ambient records. Stops parallel sessions destroying each
   other's state on disk, larger change, do after the above.
5. C2 then E, richness via the compaction spine and clear-semantics, gated on
   evidence that thin or resurfaced state is actually the felt problem.
6. A3, Codex install assurance, whenever Codex parity is being touched anyway.
7. Not F1.

Everything except A3 is host-agnostic because both hosts share the restore
code. A3 is Codex-only by definition.

## Open questions

- Is "clearing" in the original request the host `/clear` (the `SessionStart`
  matcher, addressed throughout) or `handoff done` (Option E1)? This doc treats
  the host `/clear` as primary and folds `done` into Option E. Confirm which
  matters more.
- For A2, signal-only or also age-gate, and at what age? Default proposed:
  signal only until an incident justifies a cutoff.
- For B2 (only if the B1 cursor is skipped), what `Stop` cadence balances
  capture freshness against cost? Default proposed: `SessionEnd` always plus
  `Stop` every few turns. B1 needs no cadence decision because it keeps running
  every `Stop`.

## Appendix A: restore latency probe

Measured 2026-06-06 on this machine.

- `node plugins/claude/scripts/circuit.ts handoff brief --json`: 0.17, 0.16,
  0.16, 0.16s across 4 runs (the real hook path).
- `./bin/circuit handoff brief --json` through `dist/`: 0.23, 0.14, 0.14s.
- `node -e 'process.exit(0)'` baseline: 0.02s.
- Hook timeout: 3000ms (`session-start.ts:12`).

Conclusion: restore is roughly 18x under its timeout. Latency is not the
bottleneck.

## Appendix B: harvest cost and overwrite probe

Measured 2026-06-06 against transcript `8ab23406...jsonl`, 1823998 bytes, 760
lines.

- `handoff harvest` cost: 0.38, 0.36, 0.35s across 3 runs, each a full-file
  read and parse.
- After two harvests into a temp control plane, the records directory held a
  single `ambient-latest.json`, confirming overwrite rather than per-session
  accumulation.

Both probes ran into throwaway temp control planes; the real `.circuit` store
was not mutated.

## Sources

- `plugins/claude/hooks/hooks.json` (restore and capture triggers)
- `plugins/claude/hooks/session-start.ts` (restore spawn, timeout, silent
  failure, injection)
- `plugins/codex/hooks/session-start.ts` (host parity)
- `src/cli/handoff.ts` (brief, harvest, resume, clear, atomic writes, caps,
  precedence)
- `src/schemas/continuity.ts` (record and index shapes, ambient provenance)
- `docs/contracts/continuity.md` (resolver precedence, path-safe identity,
  invariants)
