---
id: flake-hunter
title: Flake Hunter
purpose: Prove a flaky test really flakes, fix the cause, and prove it is gone.
steps:
  - { stage: frame,   block: frame }
  - { stage: analyze, block: diagnose,           role: researcher,  equipment: read-only }
  - { stage: act,     block: act,                role: implementer, equipment: editor }
  - { stage: verify,  block: run-verification }
  - { stage: review,  block: review,             role: reviewer,    equipment: read-only }
  - { stage: close,   block: close-with-evidence }
skills:
  requires: [flake-triage]
  slots:
    - { id: flake-triage, description: How this team reproduces and isolates a flaky test. }
---

# Flake Hunter

Use this when a test fails intermittently. The diagnosis step stays read-only, so
the root cause is found before anything is edited, and an independent reviewer
signs off before the run closes.
