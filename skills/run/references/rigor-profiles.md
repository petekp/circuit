# Rigor Profiles

Rigor profiles are a shared vocabulary that controls budget, checkpoints, and review
depth. Each workflow supports the profiles that match its task shape. Every workflow
has a default rigor; the router or user can override.

## Profile Definitions

### Lite

**Budget:** 1 planning pass, 1 writer, no independent review.

**Checkpoints:** 0. Route and proceed.

**Review:** Self-verify only (re-run verification commands, check output).

**Phases skipped:** Analyze (unless workflow requires it), Review.

**When:** Clear task, known approach, < 6 files. The "just do it" path.

**Dispatch:** Single worker or inline (orchestrator does the work directly for
very small changes).

### Standard

**Budget:** 1 planning pass, 1 writer, 1 independent reviewer, 1 fix/review loop.

**Checkpoints:** 1 (scope confirmation via brief.md).

**Review:** Fresh-context dispatch with the workflow's `--circuit` and `--role reviewer`. Reviewer does not
modify source code.

**Phases:** All applicable phases for the workflow.

**When:** Default for most work. The balanced path.

**Dispatch:** Implementation via workers (implement -> review -> converge).

### Deep

**Budget:** Research phase (parallel evidence probes), 1 writer, 1 reviewer,
seam proof before implementation.

**Checkpoints:** 1-2 (scope confirmation + optional tradeoff decision).

**Review:** Fresh-context review + contract compliance audit.

**Additional phases:** Analyze phase always runs. Seam proof before Act.

**When:** Multi-domain, external research needed, no obvious path, or when the
router detects that a wrong decision here is expensive.

**Dispatch:** Parallel evidence workers, then implementation via workers.

### Tournament

**Budget:** 3 proposals (max), 1 adversarial round, 1 synthesis round,
1 pre-mortem. Bounded. Do not let it run forever.

**Ceiling:** 3 proposals, each reviewed once, 1 stress-test pass, 1 convergence
+ pre-mortem. Total: ~7 dispatch steps.

**Checkpoints:** 1 (tradeoff decision after decision packet).

**Review:** Built into the tournament structure (adversarial review, stress test,
pre-mortem).

**Additional artifacts:** decision.md (ADR format).

**When:** Architecture-level choices, expensive or irreversible decisions, "should
we X or Y" questions. Only for Explore workflow.

**Dispatch:**
1. 3 parallel diverge workers (different philosophical stances)
2. 3 parallel adversarial reviewers (one per proposal)
3. 3 parallel revision workers (strengthen based on review)
4. 3 parallel stress-test workers (attack vectors)
5. Orchestrator convergence + pre-mortem + final proposal

### Autonomous

**Budget:** Same as Standard or Deep, but all checkpoints auto-resolve except
tradeoff-decision.

**Checkpoints:** 0 (evidence-gated auto-approval).

**Review:** Independent audit + deferred review for ambiguous items.

**Auto-resolve rules:**
- Checkpoints with clear evidence: auto-continue.
- Checkpoints requiring human judgment: log to deferred.md (Sweep) or note in result.md (other workflows), continue.
- Tradeoff decisions: halt and write handoff.md.
- Critical path failures: halt and write partial result.md.

**Additional artifacts:** deferred.md (Sweep only; always present when Sweep runs Autonomous).

**When:** "Run overnight", "while I sleep", unattended quality passes.
Composable with Standard or Deep as the base budget.

**Stop conditions:**
- Sweep: 3 batches or fixed time budget, then stop.
- Build/Repair: completion or circuit breaker.
- Explore: analysis complete, handoff to user for decision.

## Router Rigor Selection

The router selects rigor based on signal patterns:

| Signal | Rigor |
|--------|-------|
| `fix:` prefix | Lite |
| Clear task, < 6 files, known approach | Lite |
| Default (no special signals) | Standard |
| `repair:` prefix, multi-domain, external research needed | Deep |
| `decide:` prefix, named alternatives, "should we" | Tournament |
| `overnight:`, "while I sleep", unattended | Autonomous |

User can override: `/circuit:build --rigor deep <task>`.

## Rigor Escalation

Workflows can escalate rigor mid-run:

- Build at Lite discovers complexity -> escalate to Standard (add Review phase).
- Build at Standard discovers architecture uncertainty -> transfer to Explore.
- Repair at Lite hits 3 hypotheses without repro -> escalate to Standard.
- Any workflow at any rigor hits circuit breaker -> escalate to user.
