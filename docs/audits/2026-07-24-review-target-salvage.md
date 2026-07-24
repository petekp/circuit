# Review target salvage (2026-07-24)

A ten-hour Codex session rebuilt how Review chooses the code it audits. The
work never landed: it sat uncommitted on `main`, the tree was not green, and
the session was aborted mid-flight. An audit that day found a sound kernel
inside a much larger delivery, and Pete's ruling was to salvage the kernel
rather than resume the thread or throw the work away.

This note records what was kept, what was cut, and what the salvage cost.

## What the rebuild got right

Review used to reason about "the diff" without ever pinning what that meant.
The kernel replaces that with a target the run commits to:

- One `ReviewTarget` per run: working tree, staged set, unstaged set, commit,
  or range. Nothing else.
- Symbolic refs resolve once to a pinned object ID, and every later read uses
  the pinned ID. The tree cannot shift under the review.
- Targets are exclusive. Commit evidence is the commit's diff, not the commit
  plus whatever else is lying around the working tree.
- A target that cannot be read fails closed before any model is paid.
- The reviewer is sealed: prompt-only context on both shipped connectors, with
  the `relay_uses_prompt_only_context` engine flag carrying the switch.

All of that survived.

## What the salvage decided

Five open questions were settled before execution and are now the behavior:

**Unrecognized goal wording defaults to the working tree.** The rebuilt parser
refused phrasings an operator would reasonably type. Refusing a run over goal
grammar is worse than reviewing the obvious thing and saying so, so an
unmatched goal now resolves to the working tree and names the assumption in
the intake report, the operator summary, and the result. Explicit but
malformed targets still fail closed.

**Untracked files are a warning, not a verdict.** Metadata-only untracked
evidence produces an evidence warning and a confidence limitation. It never
forces `ISSUES_FOUND` and never stops the run. `--include-untracked-content`
remains the opt-in for relaying their contents.

**Unsealed connectors run, loudly.** The two shipped connectors keep the seal.
A third-party connector that cannot prove prompt-only isolation runs Review
anyway and records the weaker guarantee on the trace, instead of being refused.

**Path subsets and exclusions still stop.** Review accepts a complete target or
supplied text. The stop message now says what to run instead.

**Pull-request targeting is gone.** There was no fetch story behind it, so the
host surfaces now say Circuit reads local evidence only and offer the local
equivalent: check the branch out, then review the working tree or a range.

## What was cut

- Pull-request target resolution, its parser forms, and the host instructions
  that promised it.
- A second full evidence collection. The start preflight was reading the entire
  target diff to answer "is this available?", and intake then read it again.
  The preflight is now parse-level only, which keeps both fail-fast boundaries
  (the CLI refuses before creating a run folder, the MCP host refuses before
  loading assets) and removes the class of bug where the two reads disagree.
- The orphaned `submodules` reader operation and the per-command config
  re-audit that ran on every Git invocation.
- Two duplicated tests that hand-wrote Git stdout and then asserted on it. The
  direct-Git twin runs the same classifier against output real Git produced.

## Gate order

Connector state-directory diagnosis now runs before target preflight. A
sandboxed session that cannot launch its connector at all should hear about the
sandbox, not about its Review target.
`tests/runner/run-preflight-refusal.test.ts` holds that order.

## Test shape

`tests/runner/review-runtime-wiring.test.ts` had grown to 4929 lines under one
describe, so any failure reported only "review wiring broke". It is now four
suites named for the question each answers, over a shared harness:

| Suite | Question |
| --- | --- |
| `review-runtime-wiring` | Does the registered compose writer produce a valid result, and does a verdict route to the right outcome? |
| `review-target-selection` | Which code is this run about? |
| `review-evidence-honesty` | When Review cannot see all of the selected code, does it say so? |
| `review-hostile-git` | Does Review refuse a repository that is lying to it? |

Same 101 cases before and after, minus the two duplicates above.

## Cost

Net hand-written lines against pre-marathon `main` (`1cbc8221`), excluding
generated output and captured proofs: about 10.6k, of which roughly 3.3k is
`src/` and 7k is tests. The salvage plan estimated 1.5k to 2.5k. The gap is
real and worth naming: the must-keep list (hostile-Git handling, fail-closed
targets, truncation honesty, the CLI and MCP boundaries) is most of the
kernel's size, and the tests that pin it are most of the test mass. Trimming
to the estimate would have meant deleting behavior the audit said to keep.
`src/flows/review/writers/intake.ts` at 1859 lines is the file to watch: the
goal parser and the direct-Git hardening each account for roughly 400 lines of
it, and both are candidates for extraction if the file grows again.

## Proof

Full `npm run verify` green on `pkp/review-target-salvage`. A live Review run
against a dirty tree with untracked files closes `CLEAN` and `complete` under
default policy, with the assumed target and the omitted untracked contents both
named in the report.

Unrelated: the golden proof runs for scenarios other than `review` carry a
stale manifest hash dating to `b53a28b6`. They were left untouched to keep this
change scoped.
