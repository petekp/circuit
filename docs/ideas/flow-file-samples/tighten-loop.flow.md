---
id: tighten-loop
title: Tighten Loop
purpose: Diagnose the failure, make a change, run the checks, and retry the change until they pass.
steps:
  - { stage: frame,   block: frame }
  - { stage: analyze, block: diagnose,           role: researcher,  equipment: read-only }
  - { stage: act,     block: act,                role: implementer, equipment: editor }
  - { stage: verify,  block: run-verification,   loop_back_to: act }
  - { stage: close,   block: close-with-evidence }
---

# Tighten Loop

A minimal repair loop. A read-only diagnosis pins the cause, then the act step
makes the change. When verification fails, the run routes back to the act step
and tries again, bounded by the engine's retry cap. Good for a small,
self-contained change with a clear pass/fail check.
