# Paper-to-site flow: second-run findings

Date: 2026-06-17
Flow: `explainer`
Paper under test: "Attention Is All You Need" (Vaswani et al., 2017)
First paper (the one the flow was built from): "The Gap" → `~/Code/human-in-the-loop/the-gap`
Output of this run: `~/Code/attention-is-all-you-need` (fresh location, never overwrote the-gap)

This is the flow's first real generalization test: run it on a paper it was not
built from, record what recurs versus what was tuned to the first paper, and let
that set the next priorities. Everything below is from the run, not from guesses.
Run folders are under `~/Code/attention-is-all-you-need/.circuit/runs/`.

## Headline

The flow's editorial work generalized well. The flow's operational plumbing did
not. The content the relays produced for a brand-new paper was faithful,
preserved notation, kept the house style, and taught the paper's real driver. But
the flow could not run end to end on its own. It needed hand-holding three times,
and one structural defect turned every stumble into a full re-run.

Plain version: the part that is hard to get right (teaching the paper correctly)
worked. The part that should be mechanical (assemble a site in a fresh folder and
recover from a failed build) is where it broke.

## What the run produced

A built, faithful, local-only site at `~/Code/attention-is-all-you-need`:

- Teaches the paper's actual thesis: path length. RNNs connect two positions
  through O(n) sequential steps; self-attention connects every position to every
  other in O(1). The reveal beat states it in the paper's own framing, "not
  attention as understanding, but attention as parallelization" (Section 4).
- Preserves notation. The sinusoidal positional-encoding formula renders verbatim:
  `PE(pos, 2i) = sin(pos / 10000^(2i/d_model))` (Section 3.5).
- Cites real sections: Section 3.2 (attention), Section 3.5 (positional encoding),
  Section 4 (path-length / complexity, Table 1), Figure 1 (architecture).
- Names the honest caveat: self-attention is permutation-invariant, and positional
  encoding is the repair. It does not pretend attention is free.
- Builds clean (`next build` passes) and serves at HTTP 200, 86 KB, with a no-JS
  SSR article fallback under the interactive scroll-stage.

The hardening relay's own verdict file
(`aiayn3/reports/relay/hardening.result.json`) records `teaches_right_driver: true`
with zero banned-phrase findings.

## What recurred (general to the flow) versus what was one-off (tuned to the-gap)

### Recurring, and general

1. **Editorial quality holds on an unseen paper.** The digest → ideate → tournament
   → harden spine produced faithful, notation-preserving, house-style output for a
   paper the flow had never seen. This is the strongest signal of the run and the
   reason to keep investing in the flow. Evidence: the served HTML, the hardening
   verdict, the verbatim PE formula, the section citations above.

2. **The build flow's verification contract is a hard requirement.** The build
   sub-run's verification resolver (`src/shared/verification-resolver.ts`,
   `firstGeneralScript`, line 88) iterates `['verify', 'test', 'check']` and aborts
   if the target `package.json` declares none of them. This will bite any target,
   not just this one.

3. **A child abort hard-aborts the whole parent.** See the headline defect below.
   This is structural, not paper-specific.

4. **The single-shot act relay has a 10-minute ceiling.** The build child runs at
   depth `medium` with no slice decomposition, so the whole site is one act relay
   against a 600000 ms connector timeout. A full interactive site plus self-verify
   does not fit. General to any non-trivial build target.

### One-off, tuned to the first paper

5. **The flow assumes a Node project already exists.** the-gap was already a
   scaffolded Next.js app, so the flow never needed a scaffold step. On a fresh
   folder, the build aborted immediately with no `package.json`. The flow is not
   greenfield-capable.

6. **The visual system carried over cleanly, which is the good kind of reuse.** The
   dark-instrument design language from the-gap's `VISUAL_SYSTEM.md` adapted to
   Transformer semantics without strain (amber for sequential/slow, cyan for
   parallel/fast, violet for positional encoding). This is reusable equipment, not
   one-off coupling.

## Where the flow needed hand-holding

Three aborts, each requiring an operator to step in. The operator chose Option A
(scaffold a faithful baseline and hand-finish) at each gate.

| # | What broke | Root cause | Operator fix |
|---|---|---|---|
| 1 | Build aborted, no `package.json` | No scaffold step; flow assumes a Node project exists | Scaffolded a faithful Next.js 16 baseline (commit `9b68220`) |
| 2 | Build aborted, missing `verify`/`test`/`check` | House-style baseline ships `dev`/`build`/`start`/`lint` only; resolver needs one of the three | Added `"verify": "next build"` (commit `026ccdc`) |
| 3 | Build act-relay timed out at 600 s | Single-shot relay cannot build a full site plus self-verify in 10 minutes | Assessed ~95%-complete faithful output, hand-finished the cut-off tail (one syntax fix, wired `page.tsx`); `next build` then passed (commit `1fcd3b6`) |

## The headline defect: child abort hard-aborts the parent

When the build sub-run (child) aborts, the explainer's `build-step` selects
recovery route `stop`, but the `WorkContract` declares no matching recovery
binding, so the entire parent run hard-aborts instead of degrading. Verbatim from
`aiayn3/reports/operator-summary.json`:

> Abort reason: step 'build-step' selected recovery route 'stop' after failed_check
> but the WorkContract does not declare a matching recovery binding

This fired on all three runs. Its consequence is the real cost driver: an aborted
run is terminal and not resumable, so each retry re-spends the full upstream
editorial fan-out. There is no checkpoint between "editorial work is done" and
"build succeeded," so a build failure throws away expensive, already-correct
editorial output.

This was deliberately not fixed in this run. Fixing it is engine re-work that was
not authorized for the generalization test. It is the number-one finding instead.

## Cost

Reported relay spend, from the `receipt.spend.total_cost_usd_reported` field in
each run's `operator-summary.json`:

| Run | Depth | Worker runs | Reported spend |
|---|---|---|---|
| `aiayn` | high | 4 | $2.6385 |
| `aiayn2` | high | 4 | $1.6148 |
| `aiayn3` | high | 4 | $1.9596 |
| **Total** | | | **$6.2129** |

The timed-out build child recorded no usage. The full editorial fan-out ran three
times only because aborts are not resumable. A single clean run would have cost
roughly one third of this. No runaway; spend was reported and the run parked as
instructed.

## Which faked synthesize steps want to become real first-class blocks

The digest, ideate, and spec steps run as `compose` (deterministic, no model).
On this run the digest produced a hollow scaffold with placeholders, and the
downstream tournament relays re-derived the paper's content from scratch. The real
paper understanding happens in the relays, not in the steps named for it.

Candidates to promote from faked compose to real model-backed blocks:

- **A real digest block** that reads the paper (the PDF or its text) and produces an
  actual structured understanding, rather than a scaffold the relays must redo.
- **A real ideate block** that proposes concepts grounded in the digest, rather than
  a template the tournament fills in.

If the digest were real, the tournament relays would refine an understanding
instead of building one, which should cut cost and tighten fidelity.

## Where fidelity and notation strained

Less than expected. The notation held: the PE formula rendered correctly and the
section citations were accurate. The honest caveat survived to the final site. The
only editorial simplification is the toy six-token example ("the cat sat on a
mat"), which is appropriate for an explainer.

The strain was operational, not editorial. The flow's stated verification of
"renders, a11y, and fidelity-to-paper" is not what actually runs:

- **Renders / builds:** covered. The verify step (`src/flows/explainer/data.ts`
  line 409, `block: run-verification`) runs the target's verify script.
- **Fidelity-to-paper:** not an automated check. It is carried by the hardening
  relay's `teaches_right_driver` verdict plus the human SIGN-OFF gate.
- **Accessibility:** not checked at all. There is no a11y check in the flow.

## What is genuinely missing

Prioritized by the friction and cost this run actually surfaced. Real usage set
this order, not a guess.

- **P0. Graceful child-abort recovery.** Make the explainer's `build-step` declare a
  recovery binding so a failed build degrades (parks or reports) instead of
  hard-aborting the parent. Failing-test-first. This is the single biggest cost and
  friction win.
- **P0. Resumable runs, or a checkpoint after editorial.** Persist the editorial
  output so a build failure does not re-spend the fan-out. Even a manual resume from
  the validated spec would have saved two-thirds of this run's cost.
- **P1. A scaffold step (or a declared greenfield precondition).** Let the flow
  target a fresh location, or fail early and legibly with "no Node project here"
  instead of aborting deep in the build.
- **P1. Reconcile the build-flow verify contract with the house-style equipment.**
  Either ship a `verify` script in the house-style baseline, or teach the resolver
  to accept the baseline's scripts. Right now the equipment and the contract
  disagree.
- **P1. Budget the build child for a real site.** Either decompose the site build
  into slices (the build flow already supports slice corridors) or raise the act
  relay timeout for this child. One 10-minute shot is not enough.
- **P2. Promote digest and ideate to real model-backed blocks** (see above).
- **P2. Add real fidelity and a11y checks to the verify stage** so the flow's stated
  verification matches what runs, rather than leaning on the human gate.
- **P3. Stop the intake step leaking the arXiv URL into the subject and titles.**

## Status at capture

- Phase 1 readiness: complete (flow assembled, all steps wired, READY with no src/
  fix required).
- Phase 2a (PICK): complete. Operator picked Concept 3, the engineer lens.
- Phase 2b (build to SIGN-OFF): complete. Site built, faithful, builds clean,
  previewable at `http://localhost:3000`.
- SIGN-OFF: held by the operator. Not authorized for publish. Site stays local-only.
  The proposed deploy target was a new, separate Vercel project, never the-gap's.
- Phase 2c (ship): not run. Gated on an explicit publish go that was not given.
