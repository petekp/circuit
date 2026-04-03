# Mode: Researched

Unclear approach, needs investigation before implementation.

**Path:** triage -> evidence-probes -> constraints -> scope -> confirm -> implement -> review -> summarize

## Step: evidence-probes (dispatch)

Two parallel workers gather evidence.

```bash
mkdir -p "${RUN_ROOT}/phases/evidence-probes-ext/reports" "${RUN_ROOT}/phases/evidence-probes-ext/last-messages"
mkdir -p "${RUN_ROOT}/phases/evidence-probes-int/reports" "${RUN_ROOT}/phases/evidence-probes-int/last-messages"
```

**Worker A -- External Research** (`evidence-probes-ext/prompt-header.md`):
- Mission: Research external patterns, prior art, and approaches in similar systems
- Inputs: Full triage-result.md
- Output path: `evidence-probes-ext/external-digest.md`
- Output schema:
  ```markdown
  # Evidence Digest: External
  ## Facts (confirmed, high confidence)
  ## Inferences (derived, medium confidence)
  ## Unknowns (gaps that matter for decisions)
  ## Implications for This Feature
  ## Source Confidence
  ```
- Role: `--role researcher`

**Worker B -- Internal Analysis** (`evidence-probes-int/prompt-header.md`):
- Mission: Trace the internal system surface relevant to this task
- Inputs: Full triage-result.md
- Output path: `evidence-probes-int/internal-digest.md`
- Output schema: same as external digest
- Role: `--role researcher`

Compose and dispatch both, then promote:
```bash
cp evidence-probes-ext/external-digest.md ${RUN_ROOT}/artifacts/external-digest.md
cp evidence-probes-int/internal-digest.md ${RUN_ROOT}/artifacts/internal-digest.md
```

If a worker wrote only `reports/report.md`, synthesize the digest manually.

**Gate:** Both digest artifacts exist with non-empty Facts, Unknowns, Implications.

**Route:** emit `pass` -> constraints

## Step: constraints (synthesis)

Read external-digest.md and internal-digest.md. Write `artifacts/constraints.md`:

```markdown
# Constraints: <task>
## Hard Invariants (must not violate)
## Seams and Integration Points
## Contradictions Between Sources
## Open Questions (ranked by decision impact)
## Performance and Operational Constraints
```

Label every item: `[fact]`, `[inference]`, or `[assumption]`.

**Gate:** At least one hard invariant, at least one seam, ranked open questions.
Every item has a certainty label.

**CRITICAL ROUTING:** Read `triage-result.md` mode field.
- If mode is `researched` -> emit route `researched` (routes to scope)
- If mode is `adversarial` -> emit route `adversarial` (routes to options)

## Step: scope (synthesis)

Same as quick mode scope step. Read triage-result.md AND constraints.md.
The constraints provide additional context for scoping.

Write `artifacts/scope.md` with the same schema as quick mode. Include:
- Augmentation sections if applicable
- References to constraints that shaped the approach
- Evidence-backed approach rationale

**Gate:** Same as quick mode.

**Route:** emit `pass` -> confirm

## Step: confirm (checkpoint)

Same as quick mode. Present scope.md, get confirmation.

**Route:** confirm -> implement, amend -> scope

## Step: implement (dispatch via workers)

Same as quick mode implement step.

**Route:** emit `to_review` -> review (NOT to_summary)

## Step: review (dispatch)

Independent review of the implementation against scope and constraints.

```bash
mkdir -p "${RUN_ROOT}/phases/review/reports" "${RUN_ROOT}/phases/review/last-messages"
```

**Prompt header** (`review/prompt-header.md`):
- Mission: Audit implementation against scope-confirmed.md and constraints.md.
  Check for constraint violations, missing test coverage, scope drift.
  Do NOT modify source code -- diagnose only.
- Inputs: scope-confirmed.md, implementation-handoff.md, constraints.md
- Output path: `review/review-findings.md`
- Output schema:
  ```markdown
  # Review: <task>
  ## Constraint Compliance
  ## Findings
  ### Critical (must fix before ship)
  ### High (should fix)
  ### Low (acceptable debt)
  ## Verdict: SHIP-READY / ISSUES FOUND
  ```
- Role: `--role reviewer`

Promote: `cp review/review-findings.md ${RUN_ROOT}/artifacts/review-findings.md`

**Gate:** Verdict is SHIP-READY. If ISSUES FOUND with critical findings, address
them and re-run (max 2 attempts).

**Route:** emit `pass` -> summarize

## Step: summarize (synthesis)

Same as quick mode. Include review findings in Notes if relevant.

**Route:** emit `pass` -> @complete
