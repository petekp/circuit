# Initial Public Release List

Date: 2026-05-19

This is the closed hand-authored release list for the first public Circuit
release. It complements the generated release truth surfaces:

- [docs/release/readiness-report.generated.md](readiness-report.generated.md)
- `generated/release/current-capabilities.json`
- [docs/release/proofs/index.yaml](proofs/index.yaml)
- [docs/release/claims/public-claims.yaml](claims/public-claims.yaml)

Local release infrastructure was green for publication:

- `npm run check-release-ready` passed with no automated release blockers.
- `npm run publish:plugins:release` passed and wrote
  `.circuit/release/plugin-publish-report.json`.

Those checks do not catch every public-facing wording mismatch. The list below
records the human release checks for the `0.1.0-alpha.6` plugin publication.

## Closeout

`0.1.0-alpha.6` was published as a plugin-only alpha. The publish report records
`status: published`, clean `main`, matching `HEAD`/`origin/main`, no warnings,
no errors, Claude tag `circuit--v0.1.0-alpha.6`, and Codex marketplace source
`petekp/circuit`.

## Closed Blockers

| ID | Item | Evidence | Required action | Verification |
| --- | --- | --- | --- | --- |
| REL-PUB-001 | Closed: Claude plugin manifest description names current command surfaces. | Current `plugins/claude/.claude-plugin/plugin.json` names `/circuit:run` and `/circuit:handoff`; built-in flows are routed through Run, and Create remains CLI-only. | No remaining release action. Keep future manifest wording aligned with generated command surfaces. | Confirm current `/circuit:` commands, then run `npm run publish:plugins:check`. |
| REL-PUB-002 | Closed: Explore flow prose matches the current Explore stage model. | `src/flows/explore/data.ts`, generated flow mirrors, and `generated/flows/explore/circuit.json` no longer describe a stale separate canonical Review stage. | No remaining release action. Edit the Explore flow package and regenerate if Explore semantics move again. | `npm run emit-flows`; `npm run check-flow-drift`; focused `rg` for the old stage sentence in Explore source and generated mirrors. |

## Closed Or Scoped Before Announcement

| ID | Item | Evidence | Next action | Verification |
| --- | --- | --- | --- | --- |
| REL-PUB-003 | Closed: release-note wording documents the approved Fix Lite intent exception. | [docs/release/parity/exceptions.yaml](parity/exceptions.yaml) tracks `EX-REL-004-FIX-INTENT-MODE`; [docs/release/0.1.0-alpha.6-notes.md](0.1.0-alpha.6-notes.md) explains bare `fix:` versus Lite. | Keep the release note wording if the router exception remains. | `npm run check-release-ready`; review release notes for the exact exception wording. |
| REL-PUB-004 | Closed by scoped host evidence: release copy stays scoped to deterministic package checks and post-release installed-host acceptance. | [docs/host-trial-checklist.md](../host-trial-checklist.md) remains the broader manual checklist. Publish evidence covers Claude temp install smoke, Codex marketplace add/upgrade, installed package doctors, and bundled runtime checks. | Run the full manual checklist only before claiming a broader host-experience study. | `npm run smoke:host:claude`; `npm run smoke:host:codex`; manual checklist notes with skipped prerequisites called out. |
| REL-PUB-005 | Closed: public host-support wording is scoped to plugin command/skill surfaces with model-mediated host affordances. | `generated/release/current-capabilities.json` and [docs/release/readiness-report.generated.md](readiness-report.generated.md) track host capability level. | Avoid native Codex App Server, Claude Agent SDK, or polished generic-shell progress claims in launch copy. | `rg -n "native|supported|generic shell|model-mediated|planned" README.md docs plugins/claude/.claude-plugin/plugin.json plugins/codex/.codex-plugin/plugin.json`; `npm run check-release-ready`. |
| REL-PUB-006 | Closed: golden proof refresh was required only where proof evidence changed. | [docs/release/proofs/README.md](proofs/README.md) says to regenerate proofs when command, summary, report, checkpoint, or scenario contracts change; all current scenarios in [docs/release/proofs/index.yaml](proofs/index.yaml) are `verified_current`. | Regenerate proofs when a future release diff changes behavior or checked-in proof evidence. | `npm run capture-proofs:golden-runs` when required; `npm run check-release-ready`; review touched proof files manually. |
| REL-PUB-007 | Closed: alpha.6 shipped as plugin-only with the root package private. | `package.json` is private `0.0.1`; host plugin manifests are `0.1.0-alpha.6`; the publish report records source, Claude, Codex, and Claude marketplace versions aligned at `0.1.0-alpha.6`. | Define a separate package release path before any npm package publication. | `npm run publish:plugins:check`; inspect `package.json`, `plugins/claude/.claude-plugin/plugin.json`, and `plugins/codex/.codex-plugin/plugin.json`. |

## Nice To Have

| ID | Item | Evidence | Next action |
| --- | --- | --- | --- |
| REL-PUB-008 | Produce a short external proof demo for the reliability claim. | The positioning-and-strategy note (recorded in [docs/ideas/deprioritized-ledger.md](../ideas/deprioritized-ledger.md)) says the strongest claim is externally unproven and recommends a same-task comparison demo. | Capture one focused Build/Fix/Review example showing the evidence trail and a concrete verification or review moment. |
| REL-PUB-009 | Add a tiny release-notes page that links the exact proof and check commands used for this alpha. | The release truth exists across generated reports, claims, proofs, and plugin publish output, but there is no single reader-facing release note yet. | Draft release notes after blockers are fixed, with links to proof scenarios and the final command transcript. |
| REL-PUB-010 | Refresh installed host caches after the final release diff, if using local dogfood installs. | [docs/contracts/host-adapter.md](../contracts/host-adapter.md) documents `npm run plugins:refresh-local`; local caches can drift. | Run the refresh command only for local dogfooding. Do not treat it as marketplace publication. |

## Gap-Audit Acceptance Additions

These are the extra proof points from the execution-plan gap review:

- `REL-PUB-001`: verify the manifest names current commands plus Pursue
  wording.
- `REL-PUB-004`: host-trial evidence must include setup evidence from
  [docs/host-trial-checklist.md](../host-trial-checklist.md): regenerated host
  output, installed host cache refresh when local dogfooding is used, Codex
  doctor from a normal temp repo, and confirmation that `circuit` on `PATH`
  points at the intended checkout. Smoke scripts may return `pass`, `fail`, or
  `skip`; skipped prerequisites must be named.
- `REL-PUB-006`: record the proof-refresh decision. If the release diff only
  changes manifest or command prose without changing command semantics, flow
  behavior, progress, summaries, reports, checkpoints, or scenarios, note that
  proof recapture is not required.
- `REL-PUB-009`: release notes must use
  [docs/release/claims/public-claims.yaml](claims/public-claims.yaml) as the public-claim checklist. Any
  claim they make needs either the listed source/proof backing or explicit
  non-shipping wording.
- `REL-PUB-010`: if a local installed-host trial is part of `REL-PUB-004`, run
  `npm run plugins:refresh-local` after the final generated diff and before that
  trial. Use the narrower Codex or Claude sync/check pair only when debugging a
  single host.
- Final `publish:plugins:check`: inspect the fresh
  `.circuit/release/plugin-publish-report.json` for `status`, version alignment,
  and warnings/errors instead of treating command success alone as sufficient.
  Inspect cache-target evidence from `plugins:refresh-local` when local
  installed-host dogfooding is part of the release pass.
- When a gate fails, the report entry carries `exit_code`, `signal`,
  `duration_ms`, and the tail of each output stream. The full untruncated
  output of every command that produced any is under `.circuit/release/logs/`.
  A `signal` value means the gate was killed rather than failing on its own,
  which is a machine problem, not a code problem: rerun before diagnosing.

## Not In Scope Or Deferred

| ID | Item | Why it is not in the initial release |
| --- | --- | --- |
| REL-PUB-011 | Native Codex App Server and Claude Agent SDK adapters. | These are not current roadmap items. Release truth should not list them as planned capabilities, and public copy should not imply they are pending support. |
| REL-PUB-013 | Broad smart-memory claims. | The positioning-and-strategy note (recorded in [docs/ideas/deprioritized-ledger.md](../ideas/deprioritized-ledger.md)) treats `circuit history` query/pull and cited run-start hints as real but bounded. Exact prior-failure recall is the strongest current case; broad recall quality still needs proof, so do not claim automatic project intelligence, broad semantic recall, or measured value improvement until release evidence proves it. |
| REL-PUB-014 | Keep-up-for-you update channel. | The positioning-and-strategy note (recorded in [docs/ideas/deprioritized-ledger.md](../ideas/deprioritized-ledger.md)) says the update-channel claim is not yet supported. Do not use launch copy that implies automatic methodology updates. |
| REL-PUB-015 | Public `/circuit:pursue` slash command. | Deferred from the initial release. Shipped in 0.1.0-alpha.7: Pursue now owns `src/flows/pursue/command.md`, and [docs/generated-surfaces.md](../generated-surfaces.md) and `src/commands/run.md` document the dedicated command surface. |

## Final Gate Used For Alpha.6

For public announcement and marketplace publication, the release gate was:

1. Clear both blocker items.
2. Re-run `npm run check-release-ready`.
3. Re-run `npm run publish:plugins:check`.
4. If any source command, generated host surface, proof, or release truth file changed, run the focused drift check named by that source owner.
5. Review final public copy against the not-in-scope/deferred list above.
6. Review the fresh plugin publish report for status, versions, and
   warnings/errors; review cache-target evidence when local Codex dogfooding is
   part of the release pass.

For alpha.6, the publish report records this gate as passed and the publication
as complete.
