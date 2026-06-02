# Documentation Map

Start here when you need repo truth without reading every historical note. Read
only the layer you need, then go deeper when the change touches that layer.

## Read First

1. [README.md](../README.md) - product shape, install paths, host roles, and
   first links.
2. [docs/repository-map.md](repository-map.md) - repo map, layer ownership,
   and layout rationale.
3. [docs/first-run.md](first-run.md) - doctor, safest Review, expected output,
   and run folder shape.
4. [docs/operator-guide.md](operator-guide.md) - commands, run flow,
   checkpoints, verification, and troubleshooting.
5. [docs/configuration.md](configuration.md) - starter config, local skills,
   Codex host/worker distinction, and connector routing.

## Agent And Contributor Setup

- [docs/agent-setup.md](agent-setup.md) - copy-paste setup instructions for
  coding agents.
- [AGENTS.md](../AGENTS.md) - repo operating rules for agents working in this
  checkout.
- [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md) - product vocabulary and
  terms to avoid.
- [src/README.md](../src/README.md) - source tree map from CLI, runtime,
  schemas, flows, generated outputs, and shared helpers.

## Change Flows Or Runtime

- [docs/architecture/runtime.md](architecture/runtime.md) and
  [docs/architecture/declarative-flow-architecture.md](architecture/declarative-flow-architecture.md)
  - current runtime and flow authoring architecture.
- [docs/architecture/run-process.md](architecture/run-process.md) - current
  Run decision timeline, including flow routing, axes, depth, relay selection,
  runtime evidence, checkpoint resume, and autonomous continuation.
- [docs/pivot/contract-guidance-proof-recovery/](pivot/contract-guidance-proof-recovery/)
  - consolidated reference point for the contract, guidance, proof, and
    recovery pivot.
- [docs/flows/authoring-model.md](flows/authoring-model.md),
  [docs/flows/blocks.md](flows/blocks.md), and the specific flow guide you are
  changing.
- [docs/contracts/](contracts/) - contract details when code, tests, or
  generated surfaces depend on an invariant.
- [docs/reference/script-inventory.md](reference/script-inventory.md) - current
  script ownership and historical migration map.

## Generated, Release, And Evidence

- [docs/generated-surfaces.md](generated-surfaces.md) - generated-file
  ownership and drift checks.
- [docs/flows/block-catalog.json](flows/block-catalog.json) - generated block
  catalog.
- [generated/](../generated/), [plugins/](../plugins/), and
  [docs/release/](release/) - generated truth, release truth, host package
  output, and checked-in proof evidence.
- [plugins/README.md](../plugins/README.md) - host package map for Claude Code
  and Codex generated mirrors.
- [docs/host-trial-checklist.md](host-trial-checklist.md) - release QA
  checklist for saying the host experience is ready for broader use.

When docs disagree, prefer code, tests, generated surfaces, and release checks
over dated plans or audits.

## Approved Active How-To Locations

Keep active runbooks, playbooks, and agent-facing how-to guidance in these
locations:

| Guidance | Source of truth |
| --- | --- |
| Repo agent operating rules | [AGENTS.md](../AGENTS.md) |
| Repository layer map and layout rationale | [docs/repository-map.md](repository-map.md) |
| Coding-agent setup prompt | [docs/agent-setup.md](agent-setup.md) |
| First install proof | [docs/first-run.md](first-run.md) |
| Operator commands and verification | [docs/operator-guide.md](operator-guide.md) |
| Run decision timeline | [docs/architecture/run-process.md](architecture/run-process.md) |
| Config and connector routing | [docs/configuration.md](configuration.md) |
| Flow and block authoring | [docs/flows/authoring-model.md](flows/authoring-model.md) and [docs/flows/blocks.md](flows/blocks.md) |
| Contract, guidance, proof, and recovery pivot | [docs/pivot/contract-guidance-proof-recovery/](pivot/contract-guidance-proof-recovery/) |
| Generated command, skill, schematic, manifest, and plugin output ownership | [docs/generated-surfaces.md](generated-surfaces.md) |
| Host package maps | [plugins/README.md](../plugins/README.md), [plugins/claude/README.md](../plugins/claude/README.md), and [plugins/codex/README.md](../plugins/codex/README.md) |
| Source tree and layer maps | [src/README.md](../src/README.md), [src/runtime/README.md](../src/runtime/README.md), [src/schemas/README.md](../src/schemas/README.md), [src/flows/README.md](../src/flows/README.md), [src/shared/README.md](../src/shared/README.md), and [src/types/README.md](../src/types/README.md) |
| Direct command source ownership | [src/commands/README.md](../src/commands/README.md) |
| Release proof lifecycle | [docs/release/proofs/README.md](release/proofs/README.md) |
| Host release QA checklist | [docs/host-trial-checklist.md](host-trial-checklist.md) |
| Current host rendering profile | [docs/specs/narration-display-profiles.md](specs/narration-display-profiles.md) with [docs/contracts/host-rendering.md](contracts/host-rendering.md) |

Historical plans, specs, audits, ideas, learnings, and checked-in proof runs are
not active instructions unless one of the sources above links to a live section.

## Document Classes

| Audience / role | Paths | Use as |
| --- | --- | --- |
| Operator entry | [README.md](../README.md), [docs/first-run.md](first-run.md), [docs/operator-guide.md](operator-guide.md), [docs/configuration.md](configuration.md) | Current user-facing setup and operation. |
| Agent setup | [docs/agent-setup.md](agent-setup.md), [AGENTS.md](../AGENTS.md) | Instructions for coding agents in this checkout. |
| Vocabulary | [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md) | Current product terms for product prose, docs, contracts, and flow authoring notes. |
| Contributor reference | [docs/repository-map.md](repository-map.md), [docs/architecture/](architecture/), [docs/contracts/](contracts/), [docs/flows/](flows/), [docs/reference/script-inventory.md](reference/script-inventory.md), [src/README.md](../src/README.md), [plugins/README.md](../plugins/README.md) | Current codebase, flow, block, contract, source tree, host package, and script ownership reference. |
| Generated/evidence | [docs/generated-surfaces.md](generated-surfaces.md), [docs/flows/block-catalog.json](flows/block-catalog.json), [generated/](../generated/), [docs/release/](release/), [plugins/](../plugins/) generated mirrors | Generated truth, release truth, or proof evidence. Generated mirrors are regenerated from source. |
| Release QA | [docs/host-trial-checklist.md](host-trial-checklist.md) | Checklist for validating host readiness before broader use. |
| Active pivot reference | [docs/pivot/contract-guidance-proof-recovery/](pivot/contract-guidance-proof-recovery/) | Consolidated reference for the contract, guidance, proof, and recovery pivot. Validate claims against code, tests, and generated surfaces before treating them as current behavior. |
| Working strategy | [docs/positioning-and-strategy.md](positioning-and-strategy.md) | Internal strategy context. Not polished external copy; validate claims against code and release evidence before reuse. |
| Audit records | [docs/audits/](audits/) | Source-backed cleanup and inventory reports. Use as evidence records, not active operating guidance. |
| Research note | [docs/ideas/](ideas/) and [docs/learnings/](learnings/) | Prior-art or product-shape material. Useful context, not current behavior. |
| Archived | Completed or historical files in [docs/specs/](specs/) and [docs/internal/archive/](internal/archive/) | Dated target specs, design records, and local-only historical notes. Do not treat as active instructions unless a current doc links to a live section. |

## Low-Noise Rules

- Keep current how-to guidance in the canonical docs above.
- Keep generated ownership in [docs/generated-surfaces.md](generated-surfaces.md);
  do not repeat it in every guide.
- Do not add a new active runbook or playbook outside the approved locations
  without updating this map.
- Move completed execution records that are not public release evidence into
  local-only [docs/internal/archive/](internal/archive/) after repo-wide
  reference probes.
- Keep speculative product ideas in [docs/ideas/](ideas/) and prior-art notes in
  [docs/learnings/](learnings/).
- Leave release proof runs in place unless a release check proves they are safe
  to move.
