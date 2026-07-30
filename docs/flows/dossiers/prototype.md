# Prototype

Public. 6 steps standard, 10 in tournament mode. Depths `medium | high` only.
`tournament: true`. `autonomous: true`. Engine flag:
`binds_execution_depth_to_relay_selection`.

Corpus: 8 runs. 4 complete, 3 aborted, **5 stalled at a checkpoint and never
closed** (overlapping the aborted set; see below).

## 1. What a user expects

"Throw together a quick version of this so I can look at it":

- **Speed over polish.** This is disposable.
- **Do not touch my real code.**
- **Let me see it.** A prototype I cannot open is not a prototype.
- **If I asked for variants, show me the variants side by side** and tell me which
  one is better.
- **Do not tell me it is production ready.**

## 2. What actually happens

Standard mode:

```
frame-step               (compose)      objective, prototype_root, claim_limits
plan-step                (compose)      files_to_create, verification
act-step                 (relay)        build it
verify-step              (verification) confirm reported files exist under prototype_root
prototype-checkpoint-step(checkpoint)   keep / save-build-input / discard
close-step               (compose)      emit prototype.result@v1
```

Tournament mode fans out configured model variants, captures provider evidence,
verifies each, has a reviewer compare them, and asks which to keep.

The containment discipline is excellent and is the flow's best feature. The brief
requires `prototype_root` and `claim_limits` as schema sections. The purpose
string enumerates what Prototype does not claim: "deployment, branch previews,
screenshots, provider behavior, model behavior, or production readiness."
`verify-step` checks that reported files exist **under `prototype_root`**, so a
worker that wrote outside the sandbox is caught.

The checkpoint has three real choices with distinct meanings, including
`save-build-input`, which closes with a Build-ready prompt without running Build.
That is a genuinely good piece of flow design: it turns a throwaway into a spec.

## 3. Friction

**Five runs are still waiting for an operator choice, one of them since
2026-05-20.** All five reached `prototype-variant-checkpoint-step`, emitted
`checkpoint.requested`, and stopped. Their operator summaries are honest and clear:

```
⎿ Waiting for a checkpoint choice.
- Step: `prototype-variant-checkpoint-step`
- Choices: sonnet-low, sonnet-medium, sonnet-high
```

The problem is not the summary. The problem is that **nothing ever tells you they
are waiting.** They have no `result.json`, so they do not appear in outcome
tallies. `circuit reclaim` reports on worktrees, not on stalled runs, and returns
empty here. There is no surface anywhere that says "five runs are blocked on you."
Paid work sat in these for over two months.

This is the single largest unaddressed friction in the catalog and it is not
flow-specific, but Prototype is where it shows because Prototype is checkpoint-heavy.

**The variant fan-out kills the run when variants fail.** Twice in the corpus:

```
tournament collapsed: fanout step 'variant-fanout-step' had 1 parseable
survivor(s), need at least 2 (relay fanout branch 'codex-55-xhigh':
connector invocation failed ...)
```

`on_child_failure: 'continue-others'` and then the aggregate join requires
`required_count` bound to the `tournament_n` axis. So the flow carefully continues
past a dead branch and then fails because that branch is dead. Those two settings
contradict each other. One surviving variant is a worse comparison than three and
a much better outcome than nothing, especially when the survivor was built and
verified.

**Tournament mode requires config the user has not been told about.** 2026-05-20:

```
step 'variant-options-step' handler threw:
prototype.variant-options@v1 requires circuits.prototype.variant_models in Circuit config
```

The run aborted at step 3 because a config key was absent. This is knowable before
the run starts.

**No `low` depth.** `allowed_depths: ['medium', 'high']` on the flow whose entire
premise is speed over polish. The one flow where a user would most plausibly want
the cheapest possible pass forbids it.

**Nothing opens the prototype.** `verify-step` confirms the files exist. The
result links them. For an HTML prototype, which is what most of the corpus goals
are ("a single-file HTML viewer", "a versatile vanilla HTML and CSS UI"), the
user's next action is always to open it, and the flow stops one step short.

## 4. Confirmed bugs

**a. `continue-others` and `required_count` contradict each other in
`variant-fanout-step`.** Two corpus aborts. The step is configured to tolerate
child failure and then joins in a way that cannot.

**b. Five runs stalled at a checkpoint with no surface that reports them.**
Confirmed by inspection: five run directories with `checkpoint.requested` as the
last trace entry, no `result.json`, oldest 2026-05-20. `circuit reclaim` does not
cover this class.

**c. Missing `circuits.prototype.variant_models` aborts at step 3 rather than
before step 1.** One corpus abort.

**d. Inherited connector fragility.** Both fan-out collapses trace to
`codex-55-xhigh` connector invocation failures. See [README](README.md) finding 3.

## 5. What would make it superlative

**1. Surface stalled runs.** Anything: a line in `circuit doctor`, a `circuit
runs` listing, output on the next bare `circuit` invocation. Five abandoned runs
with paid work in them is a worse failure than an abort, because an abort at least
tells you it happened. This is the top item and it is catalog-wide, not
Prototype-specific.

**2. Close with the variants that survived.** Make the fan-out join tolerate
`n >= 1` and report how many of the requested variants came back. A one-variant
comparison honestly labeled beats an abort. This directly resolves the
contradiction in bug (a) and removes two of three Prototype aborts.

**3. Preflight the config.** Check `circuits.prototype.variant_models` at
intake, and fail before spending anything with a message naming the key and what
to put in it.

**4. Add `low` depth.** The flow's stated premise is speed over polish. Let a
user buy that.

**5. Open the artifact.** For a prototype whose files are HTML, offer the path in
a form the host can render, the way the checkpoint review page already works. The
last mile of a prototype is looking at it.

**6. Give a stalled checkpoint a timeout with a safe default.** The variant
checkpoint already has an `auto_resolution: {policy: 'highest-score'}`. A run that
has been waiting for a week could take it and close honestly, noting that the
choice was automatic. Better a defensible default than indefinite silence.

### The one-sentence version

Prototype is the best-contained flow we have and it has five runs quietly waiting
for an answer nobody knows they owe.
