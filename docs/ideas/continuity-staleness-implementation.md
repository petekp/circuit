# Continuity staleness check: implementation spec

Status: BUILT 2026-06-07. Companion to the design exploration in
[`continuity-staleness-check.md`](continuity-staleness-check.md) and its
frame-check review. Slice 0 shipped via PR #45 (merge `8d9abb69`); Slices
1-3 shipped on `feat/handoff-brief-staleness`. Every code reference was
cited to source and verified on 2026-06-07. Kept as the rationale record.

## Scope

Two levers, sequenced. The frame-check review found that the staleness
signal is only as good as the intent it orients, and that the brief's
"Latest request" currently leaks slash-command skill bodies. So this spec
ships the intent-quality precondition first, then the staleness check.

- **Slice 0 (precondition): intent-quality drop fix.** Stop expanded
  slash-command skill bodies from leaking in as the harvested
  "Latest request".
- **Slice 1: structured staleness facts.** Compute deterministic git
  divergence at brief time and add a `staleness` object to the brief
  envelope. No rendered text yet.
- **Slice 2: render the block.** Turn the facts into a "Repo state since
  capture" block and one boundary clause in the ambient brief.
- **Slice 3: unchanged-case render.** Settle the one open product
  decision (omit vs show "unchanged").

Locked decisions carried from the design doc: report-only (no intent
rewrite, no brief suppression), ambient-only, deterministic git facts and
never an engine "done" verdict.

## Architecture facts this spec relies on

These were verified against source and drive the design:

1. **Both hosts spawn the same CLI brief.** `plugins/claude/hooks/session-start.ts:106-115`
   and `plugins/codex/hooks/session-start.ts:106-115` are byte-identical
   and both run `handoff brief --json --project-root <cwd>` with `cwd` set
   to the repo. The in-process hook path (`runHandoffHook`,
   `src/cli/handoff.ts:693-774`) and the CLI `brief` action
   (`src/cli/handoff.ts:2337-2345`) both call `handoffBrief(args, now)`.
   **Every brief path converges on `handoffBrief`.** Threading a git probe
   there (defaulted to a real impl) reaches both hosts with one change, and
   the probe runs against the resolved `--project-root`, never
   `process.cwd()` (AGENTS.md rule 7).

2. **The record already stores the captured baseline.** `GitState`
   carries `cwd`, `branch?`, `head?`, `base_commit?`
   (`src/schemas/continuity.ts:18-26`); the ambient writer populates
   `git.branch` and `git.head` (`src/cli/handoff.ts:2176-2180`). Staleness
   is read-time only: compare that baseline to live git.

3. **Ambient-only has a precedent to mirror.** `renderHandoffBrief`
   computes the A2 age line only for ambient records
   (`src/cli/handoff.ts:334-337`). Staleness uses the same guard.

4. **Nothing here touches the persisted schema.** Slice 0 changes a
   render-time intent filter; Slices 1-3 add fields to the
   `handoff-brief-v1` envelope and rendered text. No `ContinuityRecord` or
   `ContinuityIndex` field is added or changed, so the continuity
   invariants CONT-I1..I18 (`docs/contracts/continuity.md`) are untouched
   by construction. See Invariants below.

5. **The existing git probe is the template.** `realAmbientGitProbe`
   (`src/cli/handoff.ts:2046-2070`) shows the house pattern:
   `execFileSync('git', ['-C', projectRoot, ...], { stdio: ['ignore','pipe','ignore'] })`,
   guard on `rev-parse --is-inside-work-tree === 'true'`, return `{}` or
   `undefined` on any throw. The brief probe mirrors it.

---

## Slice 0: intent-quality drop fix (precondition)

### Problem

`parseTranscriptContent` (`src/cli/handoff.ts:1751-1780`) collects user
turns as intents, dropping host noise via `isDroppedIntent`
(`src/cli/handoff.ts:1692-1699`), which tests three patterns
(`src/cli/handoff.ts:1635-1641`):

- `AMBIENT_HOST_TAG_PREFIX` drops `^<command-name|<command-message|...` host tags
- `AMBIENT_DROP_LINE_PREFIX` drops `^(# /|# Warm continuity record|Caveat:|[SESSION CONTINUITY])`
- `AMBIENT_INTERRUPT_MARKER` drops `Request interrupted`

When the operator runs a slash command like `/write-goal`, the host emits
the `<command-name>` wrapper (dropped) and then a separate plain user turn
containing the **expanded skill body**, which begins
`Base directory for this skill: <path>` followed by the skill markdown.
That expansion carries no host tag, matches none of the three patterns, so
it survives as an intent. Because it is the last user turn before harvest,
it becomes `goal` (`src/cli/handoff.ts:2166-2169`) and renders as the
headline "Latest request". Reproduced live in this repo's ambient snapshot
on 2026-06-07.

### Fix

Extend `AMBIENT_DROP_LINE_PREFIX` to drop the skill-body preamble. The
expansion reliably begins with the literal `Base directory for this skill:`,
so add that alternative:

```
const AMBIENT_DROP_LINE_PREFIX =
  /^(# \/|# Warm continuity record|Caveat:|\[SESSION CONTINUITY\]|Base directory for this skill:)/;
```

This is the highest-precision deterministic catch: it keys on the exact
preamble the skill harness prepends. The cost of a false drop (a real user
message that happens to start with that string) is one omitted intent,
which the harvest already tolerates (the empty-capture guard at
`src/cli/handoff.ts:2154-2163` never blanks a good prior record).

### Decision to confirm

The preamble is a Claude Code skill-harness string. The drop filter is
already host-aware (it drops Claude `<command-name>` tags), so adding a
Claude skill preamble is consistent. If the harness wording changes, the
catch silently lapses (fails open, back to today's behavior, no crash).
Alternative considered and rejected for now: detect command expansions
structurally. There is no structural marker on the expansion turn itself
(the marker is on the separate, already-dropped `<command-name>` block), so
content-prefix matching is the only deterministic lever available.

### TDD

1. Failing test: a transcript fixture whose last user turn is
   `Base directory for this skill: /Users/x/.claude/skills/write-goal\n\n# Write Goal\n## Overview ...`
   harvests with that string **absent** from `parsed.intents` and absent
   from `record.narrative.goal` (the goal falls back to the prior real
   intent, or to the no-intent placeholder).
2. Regression test: a normal user turn that merely contains the substring
   mid-message (not at line start) is still captured, since the pattern is
   `^`-anchored.
3. Co-locate with the existing harvest tests (see Verification for the
   file). The `slice(0, AMBIENT_INTENT_MAX_CHARS)` truncation and
   `AMBIENT_MAX_INTENTS` window are unchanged.

---

## Slice 1: structured staleness facts (envelope-only)

### New types

A brief-time probe distinct from `AmbientGitProbe` (it needs ancestry,
merge, and count signals, some exit-code-based):

```
interface StalenessFacts {
  readonly head_advanced?: boolean;
  readonly capture_head_reachable?: boolean;   // capture HEAD in current history
  readonly branch_merged_or_gone?: boolean;
  readonly tree_clean?: boolean;
  readonly commits_since?: number;
  readonly current_head?: string;              // short SHA of HEAD now, for the render
}

type BriefGitProbe = (input: {
  readonly projectRoot: string;
  readonly capturedHead?: string;
  readonly capturedBranch?: string;
}) => StalenessFacts;
```

Every field optional: omit on soft-fail so a missing signal never renders
a wrong fact. Mirrors `relativeAge` returning `undefined`
(`src/cli/handoff.ts:415-417`).

### Real probe

`realBriefGitProbe`, modeled on `realAmbientGitProbe`
(`src/cli/handoff.ts:2046-2070`). One input subtlety drives the
definitions: the captured `git.head` was stored with `rev-parse --short
HEAD` (`src/cli/handoff.ts:2059`), so it is an abbreviated SHA whose length
git chooses dynamically, and the captured `git.branch` is the literal
string `HEAD` when the capturing session was in a detached-HEAD state
(`rev-parse --abbrev-ref HEAD` returns `HEAD` there,
`src/cli/handoff.ts:2058`). The probe normalizes around both.

- Guard: `rev-parse --is-inside-work-tree` must be `'true'`, else return `{}`.
- Resolve once up front: `headFull = rev-parse HEAD` (full SHA), and when
  `capturedHead` is set, `capturedFull = rev-parse --verify
  <capturedHead>^{commit}` (expands the stored short SHA to full; fails if
  that commit was rebased away or garbage-collected, in which case the
  SHA-based facts below stay omitted). Comparing full SHAs is what avoids
  the short-length-drift bug: the abbreviation length can grow between
  capture and brief time as the repo gains objects.
- `tree_clean`: `status --porcelain=v1` empty.
- `capture_head_reachable`: `merge-base --is-ancestor <capturedHead> HEAD`,
  read via **exit code** (0 = ancestor, 1 = not, other = error).
  `execFileSync` throws on non-zero; map `err.status === 1` to `false`, any
  other throw to `undefined` (omit). Only when `capturedHead` is set.
- `head_advanced`: `headFull !== capturedFull`. Only when both resolved;
  omit otherwise. Never compare the raw short strings.
- `commits_since`: `rev-list --count <capturedHead>..HEAD` parsed as int.
  Only when `capturedHead` is set and resolved.
- `current_head`: `rev-parse --short HEAD`, the short SHA of HEAD now. This
  is the only string fact; it exists solely so the render can name where
  the repo sits today (the captured side is already in `record.git`). Omit
  on soft-fail; the render drops the parenthetical when it is absent.
- `branch_merged_or_gone`: skip entirely when `capturedBranch` is absent or
  is the literal `HEAD` (a detached capture has no branch to track). Then
  it is true when EITHER the branch is gone (`rev-parse --verify --quiet
  refs/heads/<capturedBranch>` fails) OR the branch still resolves to a SHA
  `B` with `B !== headFull` AND `merge-base --is-ancestor <B> HEAD`
  succeeds (the branch tip is in current history but HEAD has moved past
  it). The `B !== headFull` clause is the fix for the self-match: a bare
  `git branch --merged` always lists the current branch as merged into
  itself, so sitting on the still-active captured branch would
  false-positive without it.

Each git call fails soft to `undefined`. Wrap the probe so any unexpected
throw yields `{}` rather than propagating (the brief must never crash the
hook). Keep a short per-call timeout; the whole brief runs in ~0.16s today
against a 3000ms hook budget, and the handful of git calls add tens of ms.

### Threading

`handoffBrief` gains a third defaulted parameter, exactly like `now`:

```
function handoffBrief(
  args: HandoffArgs,
  now: () => Date = () => new Date(),
  gitProbe: BriefGitProbe = realBriefGitProbe,
)
```

It passes `gitProbe` to `resolvePointerBrief`
(`src/cli/handoff.ts:481-539`), which owns the computation because it has
the parsed `record`:

- Compute `staleness` only when `record.continuity_kind === 'ambient'`
  (ambient-only guard, same as `ageLabel`).
- **Cross-repo guard:** only probe when `resolve(record.git.cwd)` equals
  the resolved project root. A mismatch means the captured baseline is for
  a different tree; omit staleness.
- Call `gitProbe({ projectRoot, capturedHead: record.git.head, capturedBranch: record.git.branch })`.
- Add the result to the available envelope as `staleness` (alongside
  `source`, `record_id`, `created_at`, `additional_context` at
  `src/cli/handoff.ts:526-538`). Omit the key when no facts were produced.

The CLI `brief` action and `runHandoffHook` call `handoffBrief` without a
probe arg, so they get `realBriefGitProbe` automatically.

`now` and `gitProbe` stay separate parameters so a test can pin time and
git independently.

### Testing approach (matches the existing house style)

The existing handoff tests in `tests/runner/handoff-harvest.test.ts` drive
the CLI by subprocess (`captureMain(['handoff', 'brief', '--json',
'--project-root', projectRoot])`) against a real temp git repo, not by
injecting into `handoffBrief`. Follow that style for the primary
assertions: in the test, `git init` a temp repo and construct the real
state (commit, branch, merge, rebase, dirty tree), then run the brief and
assert the envelope and text. This exercises `realBriefGitProbe`
end to end and sits next to the existing "A2 staleness" cases.

Keep the injectable `gitProbe` parameter anyway: it mirrors `now` and the
harvest `gitProbe`, and it is the clean way to unit-test the
fact-to-text mapping for states that are awkward to build with real git
(the rebased "reachable is false but the work landed" case especially).
That in-process path needs a test seam (export `handoffBrief`, or a thin
wrapper), which is a small, contained addition.

### TDD

1. Failing test: an ambient record (captured branch `feat/x`, captured
   head `aaaaaaa`) resolved through `handoffBrief` with a stub probe
   returning `{ capture_head_reachable: true, branch_merged_or_gone: true,
   tree_clean: true, head_advanced: true }` yields an envelope with that
   `staleness` object on the `available` status.
2. A manual (`standalone`/`run-backed`) record yields **no** `staleness`
   key (ambient-only).
3. Cross-repo: a record whose `git.cwd` differs from the project root
   yields no `staleness` key, even for an ambient record.
4. The default real probe in a non-git temp dir yields no `staleness` key
   (soft-fail), and the brief still renders.

---

## Slice 2: render the "Repo state since capture" block

### Render path

`resolvePointerBrief` passes the computed `StalenessFacts` into
`renderHandoffBrief` (`src/cli/handoff.ts:328-389`), which passes it
through `composeBriefFor` (`src/cli/handoff.ts:309-318`) to
`composeAmbientBrief` (`src/cli/handoff.ts:285-307`). The manual brief
(`composeHandoffBrief`) ignores it.

`composeAmbientBrief` renders a block between "Recent state" and the
boundary, from the facts (deterministic, fact-by-fact, no verdict):

```
Repo state since capture:
- Captured on branch feat/x at aaaaaaa.
- That branch is now merged and no longer present.
- The captured commit is already in the current history (HEAD bbbbbbb).
- 3 commits since capture.
- Working tree is clean.
```

Each line is emitted only for a present fact, and each token it prints is
already in hand:

- `feat/x` / `aaaaaaa` come from `record.git.branch` / `record.git.head`
  (the captured side, always present on an ambient record that carried
  them).
- "merged and no longer present" is gated on `branch_merged_or_gone`.
- "already in the current history" is gated on `capture_head_reachable`;
  the `(HEAD bbbbbbb)` parenthetical prints `current_head` and is dropped
  when that fact soft-failed.
- "N commits since capture" is gated on `commits_since` (omitted when 0 or
  absent).
- "Working tree is clean" is gated on `tree_clean`.

The boundary line gains one clause when any divergence fact is present:

```
Boundary: This is an automatic snapshot, not a saved plan. The repo has
advanced since it was captured, so check whether the captured request
already landed before acting. Confirm the current goal with the user, and
do not resume this work unasked.
```

### Budget interaction

`renderHandoffBrief` enforces `HANDOFF_BRIEF_MAX_CHARS` (3000,
`src/cli/handoff.ts:71`) and truncates `state`/`debt` to fit
(`src/cli/handoff.ts:343-388`). The staleness block is **fixed framing**,
not truncatable content, so it must ride along on `composeBriefFor` as a
new parameter that flows into **every** call site, not just one:
`renderHandoffBrief` calls `composeBriefFor` five times (the `full` render
at `:338`, the `fixed`-framing measurement at `:343`, and the three
re-render passes at `:367`, `:372`, `:377`). Thread `staleness` through the
signature so all five carry it. The one that matters for the cap proof is
`:343`: because the block sits in `fixed`, the `remaining` budget at `:352`
already subtracts it before `state`/`debt` are fitted, so the existing fit
loop trims the truncatable content around it. The block is a few short
lines. Add a test that a near-cap record still renders the staleness block
and stays within the cap.

### TDD

1. Failing test: a full-facts stub (the Slice 1 set plus
   `current_head: 'bbbbbbb'`, `commits_since: 3`) renders the
   `Repo state since capture:` block exactly as shown above (parenthetical
   and commits line included), and the boundary line contains the
   "has advanced ... already landed" clause. A second case drops
   `current_head` and asserts the same block without the `(HEAD ...)`
   parenthetical, locking the omit-when-absent rule.
2. Rebased fixture: stub returns `capture_head_reachable: false,
   branch_merged_or_gone: true`. Assert the block does **not** assert
   "commit already in history" and the boundary still nudges a check (no
   false "done"). This locks the "reachable is sufficient, not necessary"
   trap from the design doc.
3. Weak-divergence fixture: stub returns only `head_advanced: true` (other
   work). Assert a minimal block and the boundary clause, but no
   merged/reachable claims.
4. Manual record: no block, boundary unchanged.

---

## Slice 3: unchanged-case render (open decision)

When the probe returns facts that show no divergence (head not advanced,
tree clean, branch present), the block can either be omitted or show a
single line:

```
Repo state since capture:
- Repo unchanged since capture.
```

Recommendation: show it. "Unchanged" is orientation too; it tells the
agent the snapshot world still matches the real world, so the resume point
is live. This is a one-line product call for Pete; implement per his
answer. Either way, when the probe produced **no facts at all** (non-git,
cross-repo, soft-fail), render nothing (Slice 1/2 behavior).

---

## Dual-host parity

The staleness computation lives entirely in `handoffBrief` and its
callees, which both hosts reach by spawning `handoff brief --json
--project-root <cwd>` (identical hook files). The probe runs server-side
in the CLI process at the resolved project root; the render is shared
code. **The same record plus the same repo state produce byte-identical
briefs on both hosts.** No host-specific code changes, and the two
`session-start.ts` files are untouched, so no host-package regeneration is
required for this work.

Parity test: assert that `handoffBrief` with a fixed `now` and a stub
probe produces the identical envelope and `additional_context` regardless
of host (it is host-independent by construction; the test documents the
invariant).

## Invariants preserved (CONT-I1..I18)

The continuity invariants govern the persisted `ContinuityRecord` and
`ContinuityIndex` shapes (`docs/contracts/continuity.md:87-228`). This
work adds **no field to either** and writes nothing to disk:

- Slice 0 changes which user turns become intents at harvest, but the
  record shape (`narrative.goal`, `state_markdown`) is unchanged.
- Slices 1-3 add `staleness` to the `handoff-brief-v1` envelope and text
  to the rendered ambient brief. The brief envelope is a separate API from
  the record schema; `staleness` is an additive optional field, so the
  envelope `api_version` can stay `handoff-brief-v1`
  (`src/cli/handoff.ts:69`). Bumping is optional and not required for the
  hosts, which read `status`, `additional_context`, `operator_notice`, and
  `error.code` only.

No change to `ContinuityRecord`, `ContinuityIndex`, the resolver
precedence (`src/cli/handoff.ts:553-595`), or the A4 fall-through. The
staleness object rides on the same `available` envelope that A4 augments,
so an A4-recovered ambient brief also carries staleness (it is the same
`resolvePointerBrief` return). Add a test for that interaction.

## Verification

Focused proofs during iteration:

- `tests/runner/handoff-harvest.test.ts` is the home file. Slice 0 cases
  go in the `circuit handoff harvest (ambient continuity producer)` block;
  Slice 1-3 cases go in the
  `handoff brief robustness (A1 ... A2 staleness)` block (around line 801),
  beside the existing A2 age tests. These drive the CLI by subprocess, so
  build real temp git states in the test.
- `tests/runner/handoff-hook-adapters.test.ts` already asserts both hosts
  spawn `['handoff', 'brief', '--json', '--project-root', projectRoot]`
  (around line 126). Add the parity assertion there if one is wanted; no
  host-hook code changes, so the existing adapter tests should stay green
  untouched.
- `npm run verify:fast` (check + lint + build + test:fast + drift) on each
  slice. `tests/runner/` is included in `test:fast`; only
  `cli-router.test.ts` is excluded (AGENTS.md).
- Full `npm run verify` before claiming done.

`check-flow-drift` should be unaffected (no flow package or generated host
surface changes), but run it via `verify`. The host `session-start.ts`
files are byte-identical and unchanged, so no cache resync is needed.

## Slice order and gates

1. Slice 0 lands first and independently (it improves the brief on its
   own and is the precondition for staleness to be meaningful).
2. Slice 1 (envelope-only) lands behind Slice 0.
3. Slice 2 (render) lands behind Slice 1.
4. Slice 3 (unchanged-case) lands last. Decided: show the
   `Repo unchanged since capture.` line.

Each slice: failing test first, then implementation, then
`verify:fast`; full `verify` before the final commit. Two consecutive
clean adversarial reviews with all medium-or-above findings resolved
before claiming the work done.

## Decisions (resolved 2026-06-07)

1. **Unchanged-case render** (Slice 3): show the
   `Repo unchanged since capture.` line.
2. **Skill-preamble catch** (Slice 0): key the drop on the literal
   `Base directory for this skill:` harness string. It fails open if the
   wording changes.
3. **Ship Slice 0 separately:** yes. Slice 0 lands as its own PR ahead of
   the staleness slices. Built on `feat/handoff-drop-skill-body-intent`;
   failing test first, then the one-line filter extension, full `verify`
   green.
