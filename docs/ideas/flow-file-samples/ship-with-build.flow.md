---
id: ship-with-build
title: Ship with Build
purpose: Frame the work into a goal contract, delegate the change to the Build flow, then review it.
steps:
  - { stage: frame,  block: clarify, role: researcher }
  - { stage: frame,  block: goal }
  - { stage: act,    kind: sub-run, flow: build, goal: "implement the framed change", depth: medium }
  - { stage: review, block: review, role: reviewer, equipment: read-only }
  - { stage: close,  block: close-with-evidence }
---

# Ship with Build

A supervisor flow: it clarifies the request, frames it into a goal contract,
runs the whole Build flow as a single delegated step, and has the result
reviewed before closing. The child Build run keeps its own stages, checks, and
run folder, and hands its result back to this flow. The `sub-run` step needs no
block id of its own — the parser expands it to the `goal-child-run` leaf — but it
does need an upstream goal contract, which is why the flow frames with `goal`
(clarified first, so the contract has a precise task to bind).
