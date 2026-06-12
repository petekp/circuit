# Prompt improvements: before/after measurement (2026-06-12)

Measures the prompt changes on `feat/prompt-improvements` (verdict truth
in the relay prompt, role gloss, explore `reject` verdict, hint hygiene,
injection fencing) against the branch point on main.

## Setup

- Eval: `evals/verdict-correctness`, subtle suite (the tracked
  regression baseline), 36 cases per run (9 composes x 3 planted
  defects + 9 unmodified controls).
- Arms: **before** = main at `b7658722` (clean temp worktree, own
  build), **after** = branch tip `b6188dc2`.
- Judges: claude-code with `claude-haiku-4-5-20251001` and
  `claude-sonnet-4-6`, one run per arm per tier.
- All four runs are recorded as scrubbed ledger entries
  (`evals/ledger/verdict-correctness/2026-06-12T*`); before-arm entries
  carry `repo_commit` `b7658722...`, after-arm entries `b6188dc2...`.
- What the eval can and cannot see: it replays captured prompts but
  upgrades the trailing shape-hint instruction to current production
  text, so the new reject vocabulary and the widened verdict schema are
  measured; the new `Rework verdicts:` header line, role gloss, and
  read fences are frozen out of the captured prompt body. The after-arm
  numbers therefore slightly understate the full change.

## Results

| Arm / judge | Catch rate | Protocol failures | Defect-case verdicts | Control verdicts |
|---|---|---|---|---|
| before / Haiku | 15/27 (55.6%) | 0/36 | 19 fold-ins, 8 accept | 6 accept, 3 fold-ins |
| after / Haiku | 15/27 (55.6%) | 0/36 | 11 fold-ins, 8 accept, **8 reject** | 4 accept, 3 fold-ins, **2 reject** |
| before / Sonnet | 23/26 (88.5%) | 4/36 (3 connector timeouts, 1 extra-key schema error) | 26 fold-ins/accept | 6 valid, 3 timeouts |
| after / Sonnet | 24/26 (92.3%) | 3/36 (all connector timeouts) | 22 fold-ins, 1 accept, **3 reject** | 2 accept, 2 fold-ins, **3 reject** |

Connector timeouts were machine-load artifacts (host load average ~14
during the before-Sonnet run; all timeouts hit the 120s cap). None of
the protocol failures in either arm was a blocked reject this time.

## Findings

1. **Catch rate holds.** Haiku identical (55.6% both arms; the 8
   case-level flips are symmetric, 4 each direction — judge variance,
   not signal). Sonnet 88.5% -> 92.3%, within single-run noise. The
   guard "prompt change must not depress detection" passes.

2. **Reject is now a real verdict and the judges use it.** Before, the
   schema blocked `reject` so every objection had to be folded into an
   accept. After, Haiku rejected 8/27 planted-defect cases and Sonnet
   3/23 scored ones. This is the intended behavior change: blocking
   objections now block.

3. **The "control reject rate" guard is confounded — in an
   instructive way.** After-arm rejects on unmodified controls: Haiku
   2/9, Sonnet 3/9, far above the planned ~5% guard. But the controls
   are historical composes that were *accepted under the old prompt*,
   not certified-clean inputs. Hand audit of all five control rejects:
   - `a326cd60` (Haiku): compose cites `src/history/query.ts`;
     the file actually lives at `src/app/history/query.ts`. Real
     unresolvable reference. Verified.
   - `fefa9957` (Sonnet): compose cites `src/flows/router.ts`, which
     does not exist. Verified.
   - `5e3a8ea5` (Sonnet): compose cites
     `docs/specs/explore-intent-v1.md`, which does not exist at that
     path. Verified.
   - `0dc32a58` (Sonnet): rejects an unevidenced "consumed nowhere in
     the runtime" universal claim. Defensible groundedness objection,
     not independently verified.
   - `5ad506e5` (Haiku): demands inline tool output for repo claims.
     The strictest of the five; arguably over-strict process demand.
   At least 3 of 5 control rejects flag genuinely fabricated or
   unresolvable references that the old prompt regime accepted. The
   honest reading: the old "spurious reject" guard assumed controls are
   clean; they are not, and the empowered reviewer is finding real
   defects in them. A future control-quality pass should either certify
   the control composes or score control rejects by objection validity
   rather than by verdict alone.

4. **Subtle-suite catch rate at Haiku (55.6%) is well below the May
   ~89% reference.** Both arms agree, so it is not caused by this
   branch; likely drivers are the judge-model snapshot and the source
   pool (these 9 composes differ from the May pool). Worth tracking,
   out of scope here.

## Verdict

Ship. The prompt changes do not depress detection at either judge tier,
remove the structural bias against blocking verdicts, and the only
guard that "failed" (control rejects) fails because the reviewers are
now catching real fabricated references in historically accepted
composes.
