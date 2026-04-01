# Protocol: Parallel Evidence Probes

## Purpose

This protocol covers the parallel evidence gathering pattern: dispatching 2+
independent workers with distinct research mandates, each producing a
structured evidence digest. The workers run in parallel when the backend
supports it. The orchestrator verifies all outputs exist and promotes them to
the artifact chain.

Circuits that use this protocol: `develop` (Step 2), `harden-spec`
(Steps 3-5), `ratchet-quality` (Steps 2 and 6), `cleanup` (Step 2).

## Prerequisites

Before invoking this protocol, the circuit must have:

1. An **anchor artifact** that scopes what the probes should investigate.
   Examples: `intent-brief.md`, `spec-brief.md`, `draft-digest.md`,
   `mission-brief.md`, `cleanup-scope.md`.
2. A known `RUN_ROOT` for the current circuit run.
3. A defined set of 2+ independent research mandates, each with a distinct
   investigation angle.

## Worker Setup

### Per-Worker Directory Scaffolding

Create a separate directory for each worker to avoid file collisions:

```bash
STEP_ROOT="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${STEP_ROOT}/<worker-id>/reports" "${STEP_ROOT}/<worker-id>/last-messages"
```

Examples of worker id schemes:
- `develop` Step 2: `step-2a` (external), `step-2b` (internal)
- `harden-spec` Steps 3-5: `step-3`, `step-4`, `step-5` (each is a separate
  dispatch step that runs in parallel with the others)
- `ratchet-quality` Step 2: `baseline`, `quality`, `backlog`
- `cleanup` Step 2: `dead-code`, `stale-docs`, `orphaned-artifacts`,
  `vestigial-comments`, `redundant-abstractions`

### Per-Worker Prompt Headers

Each worker gets a self-contained prompt header (no `--template` for evidence
probes in circuits that follow the self-contained header pattern). The header
uses the canonical header schema:

```markdown
# Step N: <Worker Title>

## Mission
[Distinct research mandate for this worker]

## Inputs
[Full text of the anchor artifact]

## Output
- **Path:** `${STEP_ROOT}/<worker-id>/<output-artifact>.md`
- **Schema:** [Evidence digest schema or worker-specific schema]

## Success Criteria
[What qualifies as a complete probe for this angle]

## Report Instructions
Write your primary output to the path above. Also write a standard report to
`reports/report.md` with these exact section headings:

### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

Each worker's mission, output path, and output schema are independent. Workers
do not read each other's output.

## Evidence Digest Schema

The standard evidence digest format used by `develop` Step 2:

```markdown
# Evidence Digest: <topic>
## Facts (confirmed, high confidence)
## Inferences (derived, medium confidence)
## Unknowns (gaps that matter for decisions)
## Implications for This Feature
## Source Confidence
```

Not all circuits use this exact schema. Circuit-specific variants:

| Circuit | Workers | Output schema |
|---------|---------|--------------|
| `develop` | External research, internal system surface | Evidence digest (above) |
| `harden-spec` | Implementer review, systems review, comparative review | Per-review schemas (buildability, boundaries, comparisons) |
| `ratchet-quality` Step 2 | Baseline, quality calibration, backlog | Domain-specific schemas with stable ids (`BA-*`, `QB-*`, etc.) |
| `ratchet-quality` Step 6 | Inside-out, outside-in | System shape / external exemplars schemas |
| `cleanup` Step 2 | 5 category workers | Findings table with confidence and uncertainty columns |

The common thread: every probe output must distinguish confirmed facts from
inferences and flag unknowns explicitly. Confidence labels or certainty
markers are required.

## Dispatch Pattern

### Compose Each Worker's Prompt

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${STEP_ROOT}/<worker-id>/prompt-header.md \
  --skills <worker-specific-skills> \
  --root ${STEP_ROOT}/<worker-id> \
  --out ${STEP_ROOT}/<worker-id>/prompt.md
```

Each worker may use different skills based on its mandate:
- External research probes: `deep-research`
- Internal system analysis: domain skills (e.g., `rust`, `swift-apps`)
- Architecture probes: `architecture-exploration`, `clean-architecture`
- Code analysis probes: `dead-code-sweep`, `exhaustive-systems-analysis`

### Dispatch Workers

**Codex backend (parallel):** Workers dispatch truly in parallel using `&`
and `wait`:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${STEP_ROOT}/worker-a/prompt.md \
  --output ${STEP_ROOT}/worker-a/last-messages/last-message.txt &

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${STEP_ROOT}/worker-b/prompt.md \
  --output ${STEP_ROOT}/worker-b/last-messages/last-message.txt &

wait
```

**Agent backend (sequential):** Dispatch workers as separate sequential Agent
calls, or as multiple Agent tool calls in one orchestrator response if the
tool supports it:

```
Agent(task=<worker-a prompt>, isolation="worktree")
Agent(task=<worker-b prompt>, isolation="worktree")
```

The output format and gate are identical regardless of backend.

## Verification

After all workers complete, verify every expected output exists:

```bash
test -f ${STEP_ROOT}/<worker-a>/<output-a>.md
test -f ${STEP_ROOT}/<worker-b>/<output-b>.md
# ... for each worker
```

### Fallback Synthesis

If a worker wrote `reports/report.md` but did not write its primary artifact
at the specified output path, the orchestrator reads the report and
synthesizes the digest artifact manually using the expected schema.

### Promote to Artifacts

Copy verified outputs to the canonical artifact location:

```bash
cp ${STEP_ROOT}/<worker-a>/<output-a>.md ${RUN_ROOT}/artifacts/<output-a>.md
cp ${STEP_ROOT}/<worker-b>/<output-b>.md ${RUN_ROOT}/artifacts/<output-b>.md
```

## Gate

All probe outputs must exist and satisfy their content requirements:

1. Every expected digest file exists at its artifact path
2. Each digest contains the required schema sections (non-empty)
3. Facts, unknowns, and implications (or circuit-specific equivalents) are
   present
4. Confidence labels or certainty markers are present

The step is complete only when **all** workers have produced valid output.
If some workers succeeded and others failed, do not advance -- re-run only
the failed workers.

### Resume Behavior

On resume, inspect each worker's output separately. Re-run only workers whose
output is missing or fails its gate check. Do not restart all workers if some
already completed successfully.
