# Paper→site flow — build brief

> Status: **BUILT (v1 shipped to `main`, PR #90) AND run on a second paper.** Build
> brief written 2026-06-14; status updated 2026-06-16. The flow is the `explainer`
> flow on `main` (`src/flows/explainer/`, in the catalog and generated surfaces),
> the first **hand-authored, non-`build`-shaped** Circuit flow. v1 was then run on
> a second, unseen paper ("Attention Is All You Need") as the generalization test
> this brief calls for — see
> [`paper-to-site-2nd-run-findings.md`](paper-to-site-2nd-run-findings.md).
>
> **What the 2nd run taught:** the *editorial* spine generalized well (faithful,
> notation-preserving, house-style output on a paper it had never seen), but the
> *operational plumbing* did not. It surfaced concrete, still-open findings: a
> greenfield-scaffold gap (the flow assumes a Node project already exists), the
> headline **recovery-binding hard-abort bug** (`build-step` selects recovery route
> `stop` but the WorkContract declares no matching binding, so a child build abort
> hard-aborts the whole parent and re-spends the editorial fan-out), a build-child
> budget ceiling, faked digest/ideate steps that want to become real model-backed
> blocks, and verify-stage gaps (no automated fidelity or a11y check) — plus
> operator-noted craft gaps (responsive layout + animations). None are fixed on
> `main` yet; the recovery fix is in flight on `feat/paper-to-site-flow`. The
> open-findings list is tracked in [`north-star-status.md`](north-star-status.md).
>
> *(Original goal, kept for the record: "a runnable v1 to refine by testing on a
> second paper — not a perfect flow.")* Codifies the "research paper → public
> interactive site" pipeline the operator ran once by hand (on *Some Simple
> Economics of AGI* → the `the-gap` site) into a reusable flow, so future papers run
> with the operator steering at **two** genuine forks instead of hours of
> back-and-forth. Ground every step against the real artifacts in
> `~/Code/human-in-the-loop`.

## What this is (and why it's a good first non-build flow)

The operator's actual process is already an explicit pipeline (see
`human-in-the-loop/proposals/README.md`'s own header):

> 13-analyst digest → an unsummarizable outline → 18-lens ideation fleet (54 raw →
> 19 canonical) → 3-persona × 6-criteria tournament → adversarial pressure-test +
> hardening → [pick one] → build → ship.

It maps almost entirely onto capabilities Circuit already has (fan-out, the
tournament, review/adversarial, checkpoints, the build flow as a sub-run,
verification, isolation). It is **fan-out/editorial-shaped, not
gather→implement→verify-shaped** — so it's the right first flow to prove the
assembler/authoring path can produce a shape other than `build`'s.

## The flow shape

| # | Stage | Exec kind | Auto / **FORK** | Produces (contract) | Maps to today |
|---|---|---|---|---|---|
| 1 | **intake** | compose | auto | `explainer.intake@v1` (paper source + metadata + audience) | the `intake`/`frame` blocks |
| 2 | **digest** | fanout → compose | auto | `explainer.digest@v1` (fidelity-preserving "unsummarizable outline" + concept inventory) | fan-out (cf. pursue batch) + a synthesize step (gap — see workarounds) |
| 3 | **ideate** | fanout → compose | auto | `explainer.concepts@v1` (the ~19 canonical concepts) | fan-out + synthesize |
| 4 | **tournament** | fanout → aggregate | auto | `explainer.tournament@v1` (ranked finalists, per-criterion scores, judge rationales, kill-shots) | **explore/prototype tournament** (near-direct) |
| 5 | **harden** | relay (review) | auto | `explainer.finalists@v1` (adversarially hardened finalists) | the `review` block + adversarial verification |
| 6 | **① PICK** | checkpoint | **FORK** | `explainer.choice@v1` (chosen concept) | `human-decision` / checkpoint |
| 7 | **spec** | compose | auto | `explainer.spec@v1` (the design system: visual / motion / copy / fidelity-citations) | synthesize step (gap — workaround below) |
| 8 | **build** | sub-run | auto | `explainer.build@v1` (the built site) | **the `build` flow as a child run** |
| 9 | **verify** | verification | auto | `explainer.fidelity@v1` (renders + a11y + **fidelity-to-paper** verdict) | `run-verification` with custom checks |
| 10 | **② SIGN-OFF** | checkpoint | **FORK** | `explainer.signoff@v1` (approve → ship) | checkpoint (this is also the publish-permission gate) |
| 11 | **ship** | relay/compose | auto (post-sign-off) | `explainer.result@v1` (deployed site + evidence) | `close-with-evidence` + a gated deploy |

Two forks, both genuine: **PICK** (the strategy/taste call) and **SIGN-OFF** (the
fidelity gate, which doubles as the authorization to publish). Everything else
runs autonomously. The agent arrives at each fork with a strong proposal +
evidence, so steering is a quick approve/redirect, not a session.

## v1 scope — build this, fake that, defer that

- **Build now:** the full 11-step spine, the two checkpoints, the contracts
  (flow-scoped, registered with bodies — like the built-ins), and the **tool
  scoping** per step (PR #89 just landed this — see Equipment).
- **Fake until the synthesize block lands:** steps 2, 3, 7 (digest, ideate, spec)
  are "synthesize an artifact" — Circuit's one vocabulary gap. For v1, implement
  them as `compose`/`relay` steps driven by scoped instructions (the operator's
  existing files). This is exactly what the manual run did; it works, it's just
  not yet a first-class block.
- **Defer:** the **parallel decision inbox** (v1 = a single paper at top level
  that *parks* at each fork and resumes on the operator's choice — which works
  today); the first-class synthesize block; deploy automation beyond a gated
  command; "dozens in parallel."

## Equipment — scope each step (PR #89 + the operator's own files)

- **Tools (real now, #89):** scope analysis/editorial steps (digest, ideate,
  tournament, harden, spec) **read-only / no-write**; scope **build** to the
  write-capable implementer set. This is the tools axis in action.
- **Skills / house style (provide as scoped context for v1, firming into real
  skill injection):** the operator's codified files attach to their steps —
  `the-gap/spec/VISUAL_SYSTEM.md` + `MOTION_ARCHITECTURE.md` + `COPY_DECK.md` →
  **spec**; the 3 personas + 6 criteria → **tournament**; the "unsummarizable /
  preserve the notation" principle → **digest**; `FIDELITY_CITATIONS.md` →
  **verify**; `the-gap/AGENTS.md` → **build**. These are the scoped equipment that
  makes each step produce the operator's style without re-prompting.

## The two forks (checkpoint detail)

- **① PICK** — present the hardened finalists (the `proposals/0X-*.md` shape) **plus
  the AI's recommendation** (the manual run did exactly this — "my read: #2 THE
  GAP"); the operator chooses one. Checkpoint with the finalists as evidence.
- **② SIGN-OFF** — present the fidelity verdict (the kill-shots turned into passed
  checks — "does it teach the right driver?") + a live preview; the operator
  approves, which authorizes the deploy. This satisfies the publish-permission
  norm: nothing ships without this human gate.

## How to author it

Hand-author a new flow package (the supported "Adding a flow" playbook,
`docs/flows/authoring-model.md`) — do **not** route this through the JIT
assembler; it's a fixed flow. Model the pieces on what already exists:

- the **fan-out + tournament** on `explore`/`prototype` (their tournament is the
  3-judge × 6-criteria scoring, near-verbatim);
- the **fan-out digest/ideate** on `pursue`'s batch/fan-out;
- the **build** stage as a `sub-run` of the `build` flow;
- the **two checkpoints** on `goal`'s checkpoint blocks.

Register the `explainer.*@v1` contracts flow-scoped with bodies (as the built-ins
do — you author the bodies; you do not need the generic "stock the pantry"
work). Implement digest/ideate/spec as `compose`/`relay` synthesize steps until
the first-class block exists.

## Where it stretches Circuit (these are features, not blockers)

It's the first fan-out/editorial-shaped flow → it's the concrete driver for the
**synthesize-artifact block** and for proving the authoring path produces
non-`build` shapes. The **fidelity checks** (verify the site teaches the paper's
real model, per the kill-shots) push verification toward semantic/content checks.
Both are exactly the roadmap work this flow should motivate.

## Test plan (the operator's stated approach)

Build the v1, then **run it on a second paper** the operator selects. Watch what
recurs vs. what was one-off; tighten the scoped equipment (personas, house style)
and the two fork prompts against the second instance. Earn the flow's final shape
from the second run, exactly as the resolvers and the assembler were earned from
instances.

## Rails

- Real flow-authoring (a new package under `src/flows/`): follow the "Adding a
  flow" playbook; failing-test-first; flow-facts + catalog-completeness tests
  green; full `npm run verify` green; **never special-case the engine** (the flow
  rides the manifest, like every built-in); fresh PR; **hold merge** for the
  operator.
- Ground each step against the real artifacts in `~/Code/human-in-the-loop`
  (the outline, the tournament results, the proposals, the spec/) so the flow
  reproduces the operator's actual process, not a generic one.
- If a step genuinely needs a capability Circuit lacks (beyond the
  synthesize-via-compose workaround), STOP and report it as a vocabulary finding
  rather than special-casing.

## Deferred (logged, not blockers)

The parallel **decision inbox** (the surface that makes "dozens in parallel,
steer at forks" effortless — the one genuinely-new Circuit piece the full vision
needs); the first-class **synthesize block**; deploy automation; and scaling past
a single paper at a time.
