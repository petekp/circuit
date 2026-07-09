---
contract: prototype
status: ratified-v0.1
version: 0.1
schema_source: generated/flows/prototype/circuit.json (compiled flow) + src/flows/prototype/reports.ts
last_updated: 2026-07-09
depends_on: [flow, stage, step, connector]
report_ids:
  - prototype.brief
  - prototype.plan
  - prototype.artifact
  - prototype.verification
  - prototype.result
invariant_ids: []
property_ids: []
---

# Prototype Flow Contract

Prototype creates a disposable, project-local artifact so the operator can
inspect an idea before deciding whether it deserves Build.

## Boundary

Prototype may create files only under `prototype_root`. It must not edit
production application code, generated host plugin packages, release metadata,
or deployment configuration.

Prototype must not claim that anything was deployed, production-ready, provider
verified, model verified, branch-previewed, or user-tested unless a later slice
adds and proves that surface.

## Canonical stage set

Prototype uses:

`Frame -> Plan -> Act -> Verify -> Review -> Close`

Analyze is omitted in V1. If the operator needs research before an artifact,
Circuit should use Explore.

## V1 route contract

- `act-step` writes `prototype.artifact@v1`.
- A relay verdict of `accept` routes to verification.
- A structurally valid relay verdict of `blocked` routes to `close-step`.
- `verify-step` always prepends a Prototype-owned artifact integrity command.
- Verification failure routes to `close-step` with a `needs_attention` result.
- `prototype-checkpoint-step` asks whether to keep the prototype, save it as
  Build input, or discard it.
- `close-step` is the only producer of `prototype.result@v1`.

V1 does not revise the artifact, run Build, deploy, or create screenshots.
