# Script Ownership Inventory

This is the current ownership map for the `scripts/` tree. Use it to decide
where a script belongs before adding, moving, or renaming one.

Partition criterion: each top-level script directory is named for the behavior
that owns the scripts, not for file type or incidental implementation detail.

The migration map later in this file records the historical cleanup that
produced the current layout.

## Owner Groups

| Owner | Current paths | Responsibility |
| --- | --- | --- |
| Flow generation | `scripts/flows/*` | Emit generated flow surfaces, generated-surface maps, host command mirrors, skill mirrors, schematics, and block catalogs. |
| Plugin packaging | `scripts/plugins/*` | Build plugin runtime bundles, compare package trees, publish local or release plugin copies, refresh/sync installed host caches, and diagnose installed plugins. |
| Host smoke checks | `scripts/hosts/smoke/*` | Run live or preflight host handoff smoke checks. |
| Eval operations | `scripts/evals/*` | List evals, validate eval registry and fixtures, run dry-run matrices, score fix-vs-vanilla output, and share eval runner helpers. |
| Release checks | `scripts/release/*` | Emit release truth, check release parity and public claims, capture golden proof runs, and render release reports. |

## Before Inventory

Historical note: PR #16 combined the `.mjs` to `.ts` conversion with the
ownership/name/directory cleanup. There is no separate committed "TS-only,
old-layout" baseline in this repo. For that reason, the before inventory and
migration map use the PR base commit `1957e041`; the after inventory uses the
current `origin/main` state after fetching the merge.

Source: `git ls-tree -r --name-only 1957e041 scripts | sort`

```text
scripts/build-plugin-runtime.ts
scripts/doctor-installed-plugins.mjs
scripts/emit-flows.ts
scripts/emit-flows/host-renderers.ts
scripts/evals/check-evals.mjs
scripts/evals/check-fix-manifest.mjs
scripts/evals/check-registry.mjs
scripts/evals/check-results-hygiene.mjs
scripts/evals/fix-vs-vanilla/scoring.mjs
scripts/evals/lib/aggregation.mjs
scripts/evals/lib/json.mjs
scripts/evals/lib/metadata.mjs
scripts/evals/lib/process.mjs
scripts/evals/lib/providers.mjs
scripts/evals/list-evals.mjs
scripts/evals/run-fix-matrix.mjs
scripts/host-smoke/claude-handoff.mjs
scripts/host-smoke/codex-handoff.mjs
scripts/plugin-package-tree.d.mts
scripts/plugin-package-tree.mjs
scripts/publish-plugins.ts
scripts/release/audit-marketplace-safe-paths.mjs
scripts/release/audit-public-docs.mjs
scripts/release/capture-golden-run-proofs.ts
scripts/release/check-parity.mjs
scripts/release/check-proof-coverage.mjs
scripts/release/check-public-claims.mjs
scripts/release/check-release-ready.mjs
scripts/release/emit-current-capabilities.ts
scripts/release/lib.d.mts
scripts/release/lib.mjs
scripts/release/render-parity-matrix.mjs
scripts/release/render-readiness-report.mjs
scripts/sync-codex-plugin-cache.mjs
```

## After Inventory

Source: current checkout, after the script ownership cleanup plus installed-host
cache hardening.

```text
scripts/evals/check.ts
scripts/evals/fix-matrix.ts
scripts/evals/fix-vs-vanilla/scoring.ts
scripts/evals/list.ts
scripts/evals/shared/aggregation.ts
scripts/evals/shared/json.ts
scripts/evals/shared/metadata.ts
scripts/evals/shared/process.ts
scripts/evals/shared/providers.ts
scripts/evals/validate-fix-manifest.ts
scripts/evals/validate-registry.ts
scripts/evals/validate-result-hygiene.ts
scripts/flows/emit.ts
scripts/flows/host-renderers.ts
scripts/hosts/smoke/claude-handoff.ts
scripts/hosts/smoke/codex-handoff.ts
scripts/plugins/installed-doctor.ts
scripts/plugins/package-tree.ts
scripts/plugins/publish.ts
scripts/plugins/refresh-local.ts
scripts/plugins/sync-claude-cache.ts
scripts/plugins/runtime-bundle.ts
scripts/plugins/sync-codex-cache.ts
scripts/release/audit-marketplace-safe-paths.ts
scripts/release/audit-public-docs.ts
scripts/release/capture-golden-run-proofs.ts
scripts/release/check-parity.ts
scripts/release/check-proof-coverage.ts
scripts/release/check-public-claims.ts
scripts/release/check-release-ready.ts
scripts/release/emit-current-capabilities.ts
scripts/release/render-parity-matrix.ts
scripts/release/render-readiness-report.ts
scripts/release/shared.ts
```

## Migration Map

Source: `git diff --name-status 1957e041..origin/main -- scripts`

| Old path | New path | Owner | Notes |
| --- | --- | --- | --- |
| `scripts/emit-flows.ts` | `scripts/flows/emit.ts` | Flow generation | Keeps the published `emit-flows` npm command name stable. |
| `scripts/emit-flows/host-renderers.ts` | `scripts/flows/host-renderers.ts` | Flow generation | Helper stayed beside the flow emitter. |
| `scripts/build-plugin-runtime.ts` | `scripts/plugins/runtime-bundle.ts` | Plugin packaging | Keeps `build-plugin-runtime` and `check-plugin-runtime` npm command names. |
| `scripts/doctor-installed-plugins.mjs` | `scripts/plugins/installed-doctor.ts` | Plugin packaging | Installed-plugin diagnostics now live with other plugin operations. |
| `scripts/plugin-package-tree.mjs` | `scripts/plugins/package-tree.ts` | Plugin packaging | Shared package-tree comparison helper for publish and doctor flows. |
| `scripts/plugin-package-tree.d.mts` | none | Plugin packaging | Retired declaration file; `scripts/plugins/package-tree.ts` is typed source. No runtime script was deleted. |
| `scripts/publish-plugins.ts` | `scripts/plugins/publish.ts` | Plugin packaging | Keeps all `publish:plugins*` npm command names. |
| none | `scripts/plugins/refresh-local.ts` | Plugin packaging | Adds `plugins:refresh-local` as the one-command local dogfood refresh that rebuilds generated plugin output, clears Circuit-only caches, syncs both host caches, checks them, and runs installed doctors. |
| none | `scripts/plugins/sync-claude-cache.ts` | Plugin packaging | Adds deterministic `sync:claude-plugin-cache` and `check:claude-plugin-cache` commands for local Claude Code dogfooding. |
| `scripts/sync-codex-plugin-cache.mjs` | `scripts/plugins/sync-codex-cache.ts` | Plugin packaging | Keeps `sync:codex-plugin-cache` and `check:codex-plugin-cache` command names. |
| `scripts/host-smoke/claude-handoff.mjs` | `scripts/hosts/smoke/claude-handoff.ts` | Host smoke checks | Host smoke scripts now sit under the host owner. |
| `scripts/host-smoke/codex-handoff.mjs` | `scripts/hosts/smoke/codex-handoff.ts` | Host smoke checks | Host smoke scripts now sit under the host owner. |
| `scripts/evals/check-evals.mjs` | `scripts/evals/check.ts` | Eval operations | Keeps the `check-evals` npm command name. |
| `scripts/evals/check-registry.mjs` | `scripts/evals/validate-registry.ts` | Eval operations | Names the validation target. |
| `scripts/evals/check-fix-manifest.mjs` | `scripts/evals/validate-fix-manifest.ts` | Eval operations | Names the validation target. |
| `scripts/evals/check-results-hygiene.mjs` | `scripts/evals/validate-result-hygiene.ts` | Eval operations | Names the validation target. |
| `scripts/evals/list-evals.mjs` | `scripts/evals/list.ts` | Eval operations | Keeps the `evals:list` npm command name. |
| `scripts/evals/run-fix-matrix.mjs` | `scripts/evals/fix-matrix.ts` | Eval operations | Keeps the `evals:fix:matrix:dry-run` npm command name. |
| `scripts/evals/fix-vs-vanilla/scoring.mjs` | `scripts/evals/fix-vs-vanilla/scoring.ts` | Eval operations | Same owner-specific scoring helper. |
| `scripts/evals/lib/aggregation.mjs` | `scripts/evals/shared/aggregation.ts` | Eval operations | Shared eval helper. |
| `scripts/evals/lib/json.mjs` | `scripts/evals/shared/json.ts` | Eval operations | Shared eval helper. |
| `scripts/evals/lib/metadata.mjs` | `scripts/evals/shared/metadata.ts` | Eval operations | Shared eval helper. |
| `scripts/evals/lib/process.mjs` | `scripts/evals/shared/process.ts` | Eval operations | Shared eval helper. |
| `scripts/evals/lib/providers.mjs` | `scripts/evals/shared/providers.ts` | Eval operations | Shared eval helper. |
| `scripts/release/audit-marketplace-safe-paths.mjs` | `scripts/release/audit-marketplace-safe-paths.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/audit-public-docs.mjs` | `scripts/release/audit-public-docs.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/capture-golden-run-proofs.ts` | `scripts/release/capture-golden-run-proofs.ts` | Release checks | Retained path. |
| `scripts/release/check-parity.mjs` | `scripts/release/check-parity.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/check-proof-coverage.mjs` | `scripts/release/check-proof-coverage.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/check-public-claims.mjs` | `scripts/release/check-public-claims.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/check-release-ready.mjs` | `scripts/release/check-release-ready.ts` | Release checks | Same release check, converted to typed source. |
| `scripts/release/emit-current-capabilities.ts` | `scripts/release/emit-current-capabilities.ts` | Release checks | Retained path. |
| `scripts/release/lib.mjs` | `scripts/release/shared.ts` | Release checks | Shared release helper. |
| `scripts/release/lib.d.mts` | none | Release checks | Retired declaration file; `scripts/release/shared.ts` is typed source. No runtime script was deleted. |
| `scripts/release/render-parity-matrix.mjs` | `scripts/release/render-parity-matrix.ts` | Release checks | Same release renderer, converted to typed source. |
| `scripts/release/render-readiness-report.mjs` | `scripts/release/render-readiness-report.ts` | Release checks | Same release renderer, converted to typed source. |

## Reference Probes

Old path probe:

```bash
rg -n "scripts/(emit-flows|build-plugin-runtime|doctor-installed-plugins|plugin-package-tree|publish-plugins|sync-codex-plugin-cache|host-smoke|evals/(check-evals|check-registry|check-fix-manifest|check-results-hygiene|list-evals|run-fix-matrix|lib)|release/lib)" . -g '!node_modules/**' -g '!dist/**' -g '!docs/internal/archive/**' -g '!docs/release/proofs/runs/**' -g '!docs/reference/script-inventory.md'
```

Result: no matches outside this migration report.

Reference-surface probe:

```bash
rg -n "scripts/" docs/README.md AGENTS.md README.md UBIQUITOUS_LANGUAGE.md docs/generated-surfaces.md docs/contracts docs/flows docs/architecture tests package.json evals plugins src .github -g '!docs/internal/archive/**' -g '!docs/release/proofs/runs/**'
```

Result: remaining references point either to the new repo script paths or to
plugin-local runtime entrypoints such as `plugins/<host>/scripts/circuit.ts`.
