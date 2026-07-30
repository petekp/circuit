# Flow dossiers

One dossier per flow in the catalog. Each answers the same five questions:

1. **What a user expects.** What a reasonable person thinks will happen when they
   type the request. Written before looking at the code, from the command text and
   the flow name.
2. **What actually happens.** The real step path, routes, caps, and terminal
   outcomes, read off the compiled schematic in `generated/flows/<id>/circuit.json`.
3. **Friction.** Where the two diverge in a way that costs the user something.
4. **Confirmed bugs.** Defects with evidence, each traced to a file and line or a
   run in the corpus. Suspicions are labeled as suspicions.
5. **What would make it superlative.** The specific changes that would make this a
   flow we reach for by choice, ranked.

## Method

Three sources, no memory:

- **Structure** from the compiled schematics. Every claim about steps, routes,
  caps, depths, and engine flags comes from `generated/flows/`, not from the
  authoring source, so it reflects what the engine actually runs.
- **Behavior** from the local run corpus at `.circuit/runs`: 54 runs between
  2026-05-20 and 2026-07-23. Every abort reason quoted here is from a real
  `result.json`.
- **Code** for anything the first two leave ambiguous.

The corpus is one machine and one repo, and it is a developer's corpus, so it
over-represents flows under construction and under-represents settled ones. Read
the run counts as evidence of what got exercised, not as a usage ranking. It is
still the only record of what these flows do when they meet real work.

## Corpus at a glance

| flow | runs | complete | stopped | aborted | no result |
|---|---|---|---|---|---|
| build | 13 | 2 | 1 | 10 | 0 |
| explore | 12 | 10 | 0 | 1 | 1 |
| prototype | 8 | 4 | 0 | 3 | 5 |
| review | 5 | 3 | 1 | 1 | 0 |
| steer | 5 | 3 | 0 | 2 | 0 |
| pursue | 2 | 1 | 0 | 1 | 0 |
| fix | 1 | 0 | 0 | 1 | 0 |
| goal | 1 | 0 | 0 | 1 | 0 |
| explainer | 1 | 0 | 0 | 0 | 1 |

Counts include five prototype runs and two others that never wrote a
`result.json`; they appear in both their flow's row and the "no result" column.
`steer` is on a held branch and is not in the shipped catalog.

## The three findings that are not flow-specific

Every dossier that mentions these links back here rather than restating them.

### 1. Retry exhaustion is a hard abort that destroys all upstream work

`src/runtime/run/run-transition.ts:99` returns
`recovery_attempts_exhausted_abort` when a retry route re-enters a completed step
past `max_attempts`. There is no declarable alternative. A flow cannot say "on
exhaustion, close with what you have" or "on exhaustion, ask me."

Eight of the twenty aborts in the corpus are this, and they are the expensive
ones because exhaustion by definition happens late:

| flow | step | workers paid | steps reached |
|---|---|---|---|
| build | verify-step | 3 | 6 of 9 |
| build | verify-step | 3 | 6 of 9 |
| build | verify-step | 3 | 6 of 9 |
| build | verify-step | 3 | 6 of 9 |
| fix | fix-verify | 4 | 7 of 13 |
| pursue | verify-step | 2 | 5 of 7 |
| steer | steer-probe | 3 | 3 |
| steer | steer-scout | 2 | 2 |

Five of these read `last recovery reason: verification step ... failed one or
more commands`. That is the ordinary case of a change that does not pass tests
yet. A person in that position wants the diff, the failure output, and a choice.
What they get is an abort and an empty result.

The corpus shows the cost directly, as repeated goals: "Enhance the `circuit
reclaim` command" ran four times (three aborts, then one complete), "Create a
proposal for adding sandbox support" twice (both aborted), "Build a minimal
single-file HTML viewer" twice (one abort, then complete). Those are hand-retries
of work the flow threw away.

Explainer is the only flow that solves this, and it solves it by hand: a
`retry-gate-step` checkpoint sits between the expensive editorial work and the
child build, with a comment explaining that a build failure must resume from
there instead of re-running the tournament. Every other flow pays full price.

The engine-level fix is a declarable exhaustion route. The flow-level workaround
is a gate before each expensive relay. The first is correct.

### 2. The failure headline blames the evidence system for causes it can see

`src/app/run-envelope/source-record.ts:717` headlines every aborted run:

```
⎿ Failed: <flow> could not close with the required process evidence.
   next: Inspect the process evidence and rerun with a corrected goal.
```

For the run whose `result.json` says `codex connector cannot honor effort
'none'`, nothing was wrong with the evidence and nothing was wrong with the goal.
The cause is sitting in the same directory. `operator-summary.md` prints it
correctly on the next line down, so the headline is the only surface that lies.

This is the same defect shape as the `stopped` misclassification fixed on
2026-07-29, one outcome over. It was not fixed at the same time.

### 3. Connector failure is the largest single cause of lost runs

Seven of twenty aborts are the connector layer, not flow logic:

- `codex connector cannot honor effort 'none'` (build, 2026-07-16 and again
  2026-07-19, three days apart, unfixed between them)
- `codex subprocess: capability-boundary violation: item.completed[12].item.type='web_search' is not in the known-types allowlist`
- `claude-code subprocess exited with code 143; result trace_entry missing from subprocess stdout`
- `claude-code subprocess timed out: no output for 180000ms (inactivity)`
- `codex subprocess exited with code 1` (twice, in review and explore)

Two observations. The effort-`none` bug is a pure input-validation failure that
should have been caught before a single worker was paid; it aborted two runs.
And no connector failure anywhere in the corpus is retried at the connector
level. A subprocess that dies takes the run with it.

The flows are better engineered than the pipes they run on.
