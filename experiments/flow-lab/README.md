# The offline flow lab

A cheap, offline substrate for **generating assembled flows, inspecting their
shape, and ratcheting their quality** before anything touches a real codebase.
Everything here runs in memory, in milliseconds, for no model spend: the whole
`assemble -> compile` chain is pure (no fs / net / env), so the lab generates a
flow, scores it, and gates regressions without a live host.

It is the measurement substrate the decision-layer resolvers are trialled
through. See [`../../docs/ideas/next-phase-build-brief.md`](../../docs/ideas/next-phase-build-brief.md)
and [`../../docs/ideas/decision-layer-exploration.md`](../../docs/ideas/decision-layer-exploration.md).

## The pieces

| File | What it does |
|---|---|
| `generator.ts` | Builds `FlowSchematicAssemblySpec`s by mutating a known-good seed (build's spec) — a spread from rich-and-well-formed to deliberately-degenerate. |
| `harness.ts` | `tryAssemble` / `tryCompile`: wrap the throwing assembler and compiler in a Result so a bad shape becomes **data**, not a crash. |
| `quality.ts` | `collectFlowQualityIssues(schematic, compiled?)` — the pure scorer. Count of issues = score. Lower is better. |
| `types.ts` | The closed `QUALITY_CLASSES` alphabet, `QualityIssue`, and per-class tally helpers. |
| `index.ts` | `scoreSchematic` / `scoreSpec` — one-call scoring. |

## Score = count of deficiencies

`collectFlowQualityIssues` emits one `QualityIssue` per deficiency. The closed
alphabet of classes (keeping scores comparable across flows the way the closed
block alphabet keeps runs comparable):

- **Structure** — `single-step-flow`, `undeclared-missing-{act,verify,review}`,
  `partial-spine-without-rationale`. The `undeclared-missing-*` and
  `partial-*` classes are *guard* signals: they stay at zero on a well-formed
  flow (the assembler always records omits + rationale) and fire only on a
  hand-authored or mutated schematic that drops a canonical stage silently.
- **Equipment + evidence** — `work-step-without-skill-slots` (a relay worker
  given no declared equipment — the gap the equipment resolver closes),
  `empty-evidence-requirements`.
- **Seam hygiene** — `excess-contract-aliases` (one issue per alias beyond a
  generous budget; the widening smell the M8 gate guards against).
- **Runtime surface** — `no-primary-result-binding` (the compiled flow's
  terminal outcome binds to no result report).

## The ratchet

[`../../tests/contracts/flow-quality.test.ts`](../../tests/contracts/flow-quality.test.ts)
pins a `BASELINE: Record<QualityClass, number>` ceiling per class, summed across
the shipped flows, gated by `toBeLessThanOrEqual` so a number can only shrink.
A completeness assertion forces every quality class to be pinned. This is the
exact pattern of the catalog ratchet
([`schematic-catalog-check.test.ts`](../../tests/contracts/schematic-catalog-check.test.ts)):
lowering a ceiling is a reviewed edit to the literal.

The current baseline (the shipped flows' quality position):

```
work-step-without-skill-slots: 19   # no shipped flow declares skill_slots yet
excess-contract-aliases:       28   # build/goal/pursue/fix/explore alias heavily
no-primary-result-binding:      1   # runtime-proof has no result-binding close
everything else:                0
```

## Using it

```ts
import { scoreSchematic, scoreSpec, syntheticCorpus } from './index.js';

// Score a parsed schematic (compiles it in memory to check the runtime surface):
const { score, tally, issues } = scoreSchematic(someSchematic);

// Score a generated spec (assemble failures come back as data, not a throw):
for (const { name, spec } of syntheticCorpus()) {
  const result = scoreSpec(spec);
  // result.score is null when the spec failed to assemble.
}
```
