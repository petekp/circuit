# Spec: slim the generated command surfaces and carry the operator "why" into relays

Status: spec, not built.
Origin: 2026-06-09 review of Anthropic's Fable 5 prompting guide.
Two findings drive this work. First, command surfaces written for older
models lean on enumeration (many near-identical examples, repeated
prose), and that style can degrade output on models with strong
instruction following. Second, models perform measurably better when
they are given the reason behind a request, not just the request.
Circuit's relays carry the goal but not the why.

The two workstreams are independent in substance but overlap in one
file (`src/commands/run.md`), so they land in sequence.

---

## Workstream A: slim the generated command surfaces

### Problem

`src/commands/run.md` (237 lines) is the source for three generated
surfaces: `plugins/claude/commands/run.md` (163 lines),
`plugins/codex/commands/run.md` (229), and
`plugins/codex/skills/run/SKILL.md` (229). The source contains:

- 11 bash invocation examples (lines 86-141, 56 lines) that differ
  only in flow name or one flag.
- Routing prose stated twice: the intro (lines 13-39) and the
  "Routed Flows" section (lines 225-232).
- 76 lines of rendering, parsing, and checkpoint instructions
  (sections 3-8, lines 148-223).

`src/flows/pursue/command.md` (122 lines) duplicates run.md's
rendering, parsing, and checkpoint sections nearly verbatim (its
lines 73-116 mirror run.md lines 153-223).

### What must not change (test-pinned inventory)

The slim pass keeps every phrase below verbatim. Changing one is a
deliberate test change, not a side effect.

| Test file | Pins |
|---|---|
| `tests/unit/emit-flows-renderers.test.ts` | `${CLAUDE_PLUGIN_ROOT}` wrapper path; at least one example matching `present run [a-z]+ --goal`; "Let the presentation wrapper render output"; no HTML comments in output; Codex command keeps `--progress jsonl`; Codex skill has `name:`, a `## Use Case` section, and no `$ARGUMENTS`, `/circuit:`, or `## Authority` |
| `tests/contracts/generated-surface-framing.test.ts` | "intent front door"; "records the selected flow"; "not published as separate host commands"; "Goal is not a kind of work"; "completion standard Run uses by default"; absence pins (no "flow selector", no classifier language) |
| `tests/runner/plugin-command-invocation.test.ts` | an executable router invocation; explicit examples for explore, review, and build; single-quote safety on every `--goal` bash block; the `'\''` apostrophe escape documentation |
| `tests/contracts/host-experience-docs.test.ts` | the `/circuit:run — default Circuit command` title; "Recommend the flow before invoking the CLI"; "Circuit records the selected flow"; the `present run fix --goal` example; "state the recommended flow and your one-line reason"; "routing is model-only" |

The tests imply a floor: four flow examples (fix, review, build,
explore) plus the apostrophe escape documentation must survive.

### Changes

**A1. Slim `src/commands/run.md`.**

- Keep five examples: fix, review, build, explore, and the apostrophe
  escape case. Replace the other six (prototype, prototype tournament,
  pursue, build deep, fix lite) with a short variants paragraph: the
  flow name substitutes directly; `--rigor deep` and `--rigor lite`
  tune depth; prototype model comparison adds
  `--tournament --tournament-n N`.
- Merge the "Routed Flows" section into the intro. The pinned framing
  phrases move with it.
- Tighten sections 3-8 (rendering, parsing, checkpoint, abort) to
  roughly half their current length. Keep the pinned phrases.
- Target: source 237 to roughly 150 lines; generated Claude surface
  163 to roughly 100.

**A2. Apply the same tightening to `src/flows/pursue/command.md`.**
Its copies of the rendering, parsing, and checkpoint sections shrink
to match run.md's new versions. Its two examples stay.

**A3. Light pass on `src/commands/handoff.md`.** Its four examples are
distinct modes, so all stay. Tighten the progress-rendering paragraph
only.

**A4. Regenerate and prove.** `npm run emit-flows`, then confirm
`npm run check-flow-drift` is clean.

### Non-goals for A

- No renderer changes (`scripts/flows/host-renderers.ts`). Injecting a
  shared rendering block would deduplicate run and pursue prose
  structurally, but it adds transform complexity to save about 40
  lines across two files. Revisit only if a third command source
  appears.
- No framing changes. The framing pins encode product decisions, not
  prose style.
- No relay-hint edits. The audit that produced this spec found relay
  hints are schema contracts the engine enforces, which is exactly the
  kind of prescription to keep.

### Risks and checks

- Behavioral risk: with fewer examples, a host model might mis-build a
  CLI invocation for a flow that lost its example. The invocation
  tests pin structure, not behavior. Before the next release, run the
  standard surface test pass (each flow once through `/circuit:run` on
  a scratch repo) and watch the constructed commands.
- Known gotchas: a contract test on the generated Codex run SKILL is
  sensitive to line rewrapping, and biome objects to some apostrophe
  styles. Keep diffs to the lines being slimmed; do not rewrap
  untouched paragraphs.

### Verification for A

```bash
npm run emit-flows
npm run check-flow-drift
npx vitest run tests/unit/emit-flows-renderers.test.ts \
  tests/contracts/generated-surface-framing.test.ts \
  tests/runner/plugin-command-invocation.test.ts \
  tests/contracts/host-experience-docs.test.ts
npm run verify
```

---

## Workstream B: carry the operator "why" into relays

### Problem

Workers receive the goal (`Operator Goal:` section,
`src/runtime/run/relay-support.ts:252-254`) but not the motivation
behind it. The host model usually knows the why from conversation; the
CLI never hears it, so relays cannot carry it.

### Design

The host is the only party that knows the conversational why, so the
channel is: host command surface, to CLI flag, to run context, to
relay prompt, to persisted result.

**B1. CLI flag.** Add optional `--why <text>` to the shared execution
options (`src/cli/run.ts`: `addExecutionOptions` near line 123,
`ParsedArgs`, extraction in `runExecutionCommand` near lines 657-662,
pass-through near line 794). Confirm the `present` wrapper path
forwards it; the cli-router tests cover that path.

**B2. Runtime plumbing.** Optional `why?: string` on
`CompiledFlowRunOptions` (`src/runtime/run/compiled-flow-runner.ts`),
`GraphRunnerOptions` (`src/runtime/run/graph-runner.ts:59`), and
`RunContext` (`src/runtime/run/run-context.ts:21`; optional, unlike
the required `goal`).

**B3. Relay prompt.** Append `operatorWhy?: string` as a trailing
parameter on `composeRelayPrompt`
(`src/runtime/run/relay-support.ts:209`). Trailing position avoids
breaking the existing positional call sites, including the relay
executor (`src/runtime/executors/relay.ts:465-470`). Render inside the
existing goal block, only when non-empty:

```
Operator Goal:
<goal text>
Why: <why text>
```

Every role sees it, same as the goal. Reviewer independence means not
seeing implementer hints; operator intent is the standard a reviewer
judges against, the same reasoning that put the `alignment` block on
`build.review@v1`. Thread the why wherever the goal is threaded today,
including the fanout path (`tests/runtime/fanout.test.ts` shows the
goal in fanout prompts; mirror it).

**B4. Persistence.** Optional `why` on `RunResult`
(`src/schemas/result.ts`, next to `goal` at line 43). Additive and
optional, so existing results still parse. Check `docs/contracts/` for
a result contract that enumerates fields and update it if so.

**B5. Host surface instruction.** In run.md's invocation-builder
instruction, add one sentence: when the conversation states the reason
behind the task, pass it as `--why '...'` with the same single-quote
escaping as the goal. Update exactly one example (fix) to show
`--why`. Extend the single-quote safety test to cover `--why` blocks
the same way it covers `--goal` blocks. Optionally pin the new
instruction phrase in `host-experience-docs.test.ts` for drift
protection (recommended, one phrase).

**B6. Pursue surface.** The same one-line instruction in
`src/flows/pursue/command.md`, since it builds the same CLI shape.

### Tests for B

- `composeRelayPrompt` renders the `Why:` line when given and omits it
  when absent (extend the compose-section tests near
  `tests/runner/relay-pull-affordance.test.ts`).
- CLI accepts `--why` and threads it through both the direct and
  `present` paths (`tests/runner/cli-router.test.ts` pattern).
- `RunResult` accepts the optional field; old fixtures still parse.
- Single-quote safety extended to `--why` examples.
- Fanout prompts carry the why when set.

### Non-goals for B

- No model-inferred why. If the conversation does not state one, the
  flag is omitted and relays are byte-identical to today.
- No role gating of the why.
- No continuity or memory integration. Harvesting the why into the
  ambient brief is a future idea, not this change.
- No options-object refactor of `composeRelayPrompt`. The signature is
  long, and appending one optional parameter is the minimal change. A
  refactor is separate cleanup if wanted.

### Verification for B

Full `npm run verify`, plus one live probe: a run invoked with
`--why` whose relay prompt (visible in the run folder) shows the
`Why:` line, and a run without it whose prompts are unchanged.

---

## Sequencing and acceptance

Both workstreams edit `src/commands/run.md`. Land A first, then B on
top. One branch each: A is PR 1 (source prose plus regenerated
surfaces, no engine code), B is PR 2 (small engine plumbing plus the
host instruction). B does not depend on A's content, only on avoiding
a merge conflict in run.md.

Acceptance for A: the four pinned test files pass, drift check clean,
generated Claude run.md at or under roughly 100 lines, full verify
green, surface test pass before the next release.

Acceptance for B: new tests green, the live probe shows the `Why:`
line, full verify green.

Flag name decided 2026-06-09: `--why`.

Estimate: A is a half-day prose pass with regeneration and test runs.
B is about a day including tests.
