# Autonomous Mode

When the autonomous augmentation is active, the system runs unattended.
Checkpoints auto-resolve, evidence thresholds are stricter, and a
deferred-review.md artifact captures anything requiring human judgment.

## Checkpoint Auto-Resolution

All checkpoints auto-resolve EXCEPT `tradeoff-decision`.

| Checkpoint | Auto-resolve behavior |
|------------|----------------------|
| confirm (scope confirmation) | Accept scope as-is unless scope.md contains warnings |
| ratchet-confirm | Accept plan unless critical warnings present |
| crucible-frame | Synthesize problem-brief from task, do not ask user |
| caveat-resolution | Accept all non-contradictory caveats, defer contradictions |
| **tradeoff-decision** | **HALT.** Write `deferred-review.md` and stop. |

**tradeoff-decision exception:** This is the one checkpoint where product judgment
must override the LLM. When autonomous + adversarial are both active:
1. Run all steps up to tradeoff-decision normally
2. At tradeoff-decision, halt with status `waiting_checkpoint`
3. Write `artifacts/deferred-review.md`:
   ```markdown
   # Deferred Review
   ## Checkpoint
   tradeoff-decision
   ## Reason
   Architecture decision requiring human judgment.
   ## Decision Packet
   See artifacts/decision-packet.md
   ## What Happens Next
   Review the decision packet, provide your tradeoff selection,
   then the run continues autonomously.
   ```
4. The user reviews on return, provides selection, run resumes

## Evidence Quality Thresholds

Autonomous mode requires stricter evidence since there is no human to catch gaps.

| Step | Autonomous threshold |
|------|---------------------|
| evidence-probes | Both digests must have at least 3 Facts and 2 Unknowns |
| constraints | At least 2 hard invariants, at least 2 seams |
| options | At least 3 genuinely distinct options |
| scope | No unresolved ambiguity (would normally prompt user) |

If a threshold is not met, the step retries once with explicit instructions
to dig deeper. If still not met after retry, write the gap to deferred-review.md
and proceed with what is available.

## Deferred Review Artifact

`artifacts/deferred-review.md` accumulates throughout the run. Every auto-resolved
checkpoint and every evidence gap gets an entry:

```markdown
# Deferred Review

## Auto-Resolved Checkpoints
- [confirm] Accepted scope as-is. No warnings detected.
- [ratchet-confirm] Accepted plan. No critical warnings.

## Evidence Gaps
- [evidence-probes] External digest has only 1 Unknown (threshold: 2).
  Proceeded with available evidence.

## Pending Human Decisions
- [tradeoff-decision] Halted. See decision-packet.md.

## Items Requiring Review
<anything that needed human judgment but was deferred>
```

## Ratchet in Autonomous Mode

Ratchet runs are the primary use case for autonomous mode ("run overnight").
All ratchet checkpoints auto-resolve. The injection ledger and deferred-review.md
capture everything the user needs to review on return.

Ratchet-specific autonomous behaviors:
- ratchet-confirm: auto-resolve unless plan has explicit STOP warnings
- Batch verification gates: enforce strictly (no auto-passing failed verifications)
- Injection check: must be clean or deferred to human review
- Final audit: verdicts of ISSUES FOUND are logged to deferred-review.md

## Crucible in Autonomous Mode

Crucible can run autonomously when invoked with ratchet signals or explicit
"overnight" intent. The problem-brief is synthesized from the task without
user interaction. All other steps run normally since crucible has no
additional checkpoints.

## Circuit Breaker (Autonomous)

In autonomous mode, circuit breakers that would normally escalate to the user
instead:
1. Write the failure to `deferred-review.md`
2. If the failure is in a non-critical path (e.g., one of three parallel workers),
   continue with available results
3. If the failure is in a critical path (implement, prove-seam), halt the run
   with status `blocked` and record the reason in deferred-review.md
