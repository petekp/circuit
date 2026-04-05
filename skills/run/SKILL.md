---
name: circuit:run
description: >
  Adaptive supergraph circuit. Triage classifies any task into the right
  workflow shape, then the runtime engine walks the selected path. Seven entry
  modes (default, quick, researched, adversarial, spec-review, ratchet, crucible)
  share one circuit.yaml. Steps on inactive paths are never visited.
trigger: >
  Use for /circuit, /circuit:run, or any task that needs structured execution.
  This is the default entry point for all circuit work.
---

# Circuit: Run

The primary Circuitry circuit. Routes any task to the right workflow shape via
lightweight triage, then executes using the supergraph declared in `circuit.yaml`.

## Invocation

```
/circuit <task>                  # Triage classifies
/circuit fix: <task>             # Quick + bug augmentation
/circuit decide: <task>          # Adversarial mode
/circuit develop: <task>         # Researched mode
/circuit repair: <task>          # Researched + bug augmentation
/circuit migrate: <task>         # Redirect to circuit:migrate
/circuit cleanup: <task>         # Redirect to circuit:cleanup
```

## Intent Hint Resolution

Before triage runs, check for intent hints in the task prefix.

| Prefix | Action |
|--------|--------|
| `fix:` | Entry mode `quick`, add bug augmentation. Skip triage classification. |
| `decide:` | Entry mode `adversarial`. Skip triage classification. |
| `develop:` | Entry mode `researched`. Skip triage classification. |
| `repair:` | Entry mode `researched`, add bug augmentation. Skip triage classification. |
| `migrate:` | Redirect to `circuit:migrate`. Terminate this run. |
| `cleanup:` | Redirect to `circuit:cleanup`. Terminate this run. |
| (none) | Run triage classification. |

**Companion circuit redirect:** When the prefix is `migrate:` or `cleanup:`, do NOT
run triage. Write `triage-result.md` with `redirect: circuit:migrate` (or cleanup),
emit a stop event, and tell the user:

```
This task needs the full [migrate|cleanup] workflow.

  /circuit:migrate <task description>
  /circuit:cleanup <task description>

Copy and run the command above.
```

## Triage (Step: triage)

Two-phase classification within a single step.

**Phase 1 -- Classify.** Read the task, match signal patterns against the mode
selection table below. Produce a candidate classification.

**Phase 2 -- Diagnostic probe.** Generate one targeted probe question that tests
the assumption most likely to be wrong. Present the classification AND probe
to the user for confirmation.

### Mode Selection Table

| Signal Pattern | Mode | Augmentations | Reference |
|---------------|------|---------------|-----------|
| Clear task, known approach, <6 files | quick | (check augmentation table) | `references/mode-quick.md` |
| Multi-domain OR external research needed OR no obvious path | researched | (check augmentation table) | `references/mode-researched.md` |
| Named alternatives OR "should we" OR architecture-level choice | adversarial | (check augmentation table) | `references/mode-adversarial.md` |
| Existing RFC/PRD/spec provided for review | spec-review | none | `references/mode-spec-review.md` |
| "Run overnight" OR "improve quality" OR "stability pass" | ratchet | autonomous | `references/workflow-ratchet.md` |
| "Pressure-test" OR "adversarial tournament" OR "explore N approaches" | crucible | none | `references/workflow-crucible.md` |
| Strong cleanup signals (>5 files dead code, multi-system scope) | redirect | n/a | Redirect to `circuit:cleanup` |
| Strong migration signals (framework swap, coexistence needed) | redirect | n/a | Redirect to `circuit:migrate` |

**Evaluation order:** autonomous signals > adversarial > researched > quick. Then check augmentations.

### Augmentation Table

| Augmentation | Trigger Signals | Effect on scope.md |
|-------------|----------------|-------------------|
| Bug | "broken", "not working", unexpected behavior, error codes | Add `## Regression Contract` section. Test-first discipline. |
| Migration | Migration signals when scope < full migrate circuit | Add `## Coexistence Plan` section. |
| Cleanup | Dead code signals when scope < full cleanup circuit | Add `## Removal Evidence` section. |
| Autonomous | "overnight", "while I sleep", unattended | Auto-resolve checkpoints (except tradeoff-decision). Write `deferred-review.md`. See `references/autonomous-gates.md`. |

**Stacking rules:**
- Augmentations compose. Bug + migration is valid.
- Maximum 2 augmentations per run. If 3+ signals detected, escalate to researched mode.
- When bug + another augmentation, regression contract is always Slice 0.

### Named Pattern Labels

Present the classification using a human-readable label, not the technical mode name.

| Label | Technical Mode |
|-------|---------------|
| Bug Fix (test-first) | quick + bug |
| Feature Build | quick |
| Investigation | researched |
| Architecture Decision | adversarial |
| Migration | researched + migration OR redirect |
| Cleanup | quick + cleanup OR redirect |
| Full Feature | researched |
| Overnight Quality | ratchet + autonomous |
| Spec Review | spec-review |
| Pressure Test | crucible |

### Triage Artifact

Write `artifacts/triage-result.md`:

```markdown
## Pattern
<named pattern label>

## Mode
<quick | researched | adversarial>

## Augmentations
<bug | migration | cleanup | autonomous | none>

## Reasoning
<why this classification>

## Probe
<one diagnostic question>

## Secondary Signal
<if mixed signals, note secondary concern and how it maps to scope>

## Capabilities Available
<auto-detected from installed skills>
```

Present the triage result and probe to the user. Include a brief plain-language
preview of what the selected workflow does, so the user knows what to expect:

| Pattern | Preview |
|---------|---------|
| Bug Fix (test-first) | "I'll scope the bug, write a failing test first, then fix and verify." |
| Feature Build | "I'll scope the change, show you the plan, then run implementation with independent review." |
| Investigation | "I'll research externally and audit the codebase in parallel, synthesize constraints, then scope and build." |
| Architecture Decision | "I'll gather evidence, generate distinct options, pressure-test each, and present a decision packet for your call." |
| Full Feature | "I'll research first, then scope, implement, and run a separate review session." |
| Overnight Quality | "I'll survey the codebase, calibrate a quality bar, then run improvement batches autonomously." |
| Spec Review | "I'll run three independent reviews from different angles, resolve caveats, then build." |
| Pressure Test | "I'll develop three competing proposals, have each attacked by an adversary, stress-test all three, and converge the strongest." |
| Cleanup | "I'll survey for dead code and stale artifacts, triage by confidence, then remove in risk-ordered batches." |
| Migration | "I'll inventory dependencies, plan coexistence, then migrate in verifiable batches." |

Wait for confirmation or override. If user overrides mode, update
`triage-result.md` and record the override.

### Mixed-Signal Tasks

When the task has signals spanning two modes (e.g., "add pagination + fix offset bug"):
1. Classify the dominant mode
2. Flag the secondary signal in triage-result.md
3. The scope step reads the secondary signal and creates a prerequisite slice (Slice 0)

## After Triage

Once mode is confirmed, load the corresponding reference file and follow its
step-by-step instructions. The reference file contains:
- Per-step artifact schemas
- Gate criteria
- Worker dispatch patterns
- Augmentation injection points

## Dispatch

All worker dispatch uses `dispatch.sh` with the `--role` flag:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${step_dir}/prompt.md \
  --output ${step_dir}/last-messages/last-message.txt \
  --role <implementer|reviewer|researcher>
```

Role resolution: `--role` flag > `circuit.config.yaml` roles > auto-detect.

When assembling prompt headers, include the canonical sections:
`### Files Changed`, `### Tests Run`, `### Completion Claim` to prevent
relay-protocol.md contamination.

## Domain Skill Selection

When a step references `<domain-skills>`, pick 1-2 skills matching the affected code.
Never exceed 3 total skills per dispatch.

## Artifact Chains by Mode

**Quick:** `triage-result.md` -> `scope.md` -> `scope-confirmed.md` -> `implementation-handoff.md` -> `done.md`

**Researched:** `triage-result.md` -> `external-digest.md` + `internal-digest.md` -> `constraints.md` -> `scope.md` -> `scope-confirmed.md` -> `implementation-handoff.md` -> `review-findings.md` -> `done.md`

**Adversarial:** `triage-result.md` -> digests -> `constraints.md` -> `options.md` -> `decision-packet.md` -> `adr.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md` -> `done.md`

**Spec-review:** `spec-brief.md` -> `draft-digest.md` -> 3 reviews -> `caveat-resolution.md` -> `amended-spec.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md` -> `done.md`

**Ratchet:** See `references/workflow-ratchet.md`

**Crucible:** See `references/workflow-crucible.md`

## Circuit Breakers

Escalate to the user when:
- A dispatch step fails twice (no valid output after 2 attempts)
- Seam proof returns `DESIGN INVALIDATED`
- Workers slice hits `impl_attempts > 3` or `impl_attempts + review_rejections > 5`
- Convergence fails after max attempts
- Ship review says `ISSUES FOUND` after 2 attempts

Include: counter values, failure output, options (adjust scope, skip slice, abort).

## Single-User Assumptions

- Named pattern labels assume familiarity with Circuitry vocabulary.
- `expected_capabilities` assumes the same config across machines.
- Capability auto-detection assumes one user manages skill installs.
- These assumptions are intentional. Circuitry is a single-user power tool.
