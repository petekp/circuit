/**
 * circuit-pr-review
 *
 * A PR review workflow tailored to the Circuit codebase. It is NOT a generic
 * reviewer: every dimension below encodes a rule that is specific to how this
 * repo is built - the catalog/engine boundary, the generated-surface drift
 * model, dual-host (Claude Code + Codex) parity, zod schema/contract
 * discipline, the strict-TS + hook-identity runtime rules, the test taxonomy,
 * the ubiquitous-language prose rules, and the release-surface ledgers.
 *
 * Shape: Scope -> Review (gated by touched surfaces) -> Verify (adversarial,
 * per finding) -> Prove (run the focused proofs that map to what changed) ->
 * Report (severity-ranked, with the exact remaining commands to run).
 *
 * Invoke:
 *   Workflow({ name: 'circuit-pr-review' })                  // current branch vs main
 *   Workflow({ name: 'circuit-pr-review', args: 123 })       // GitHub PR #123
 *   Workflow({ name: 'circuit-pr-review', args: { pr: 123, base: 'main', skipProve: false } })
 *
 * Returns { scope, findings, proofs, verdict, savedPath, report } - the report
 * field is the human-facing markdown the caller should surface, and the run also
 * writes that markdown to .circuit/reviews/<branch-or-pr>.md (savedPath). The
 * .circuit/ dir is gitignored, so saved reviews never dirty git status.
 */

export const meta = {
  name: 'circuit-pr-review',
  description: 'Circuit-tailored PR review: catalog boundary, generated-surface drift, dual-host parity, schema/contract discipline, runtime/hook rules, tests, prose, release ledgers - adversarially verified and proven with focused checks.',
  whenToUse: 'Reviewing a Circuit branch or GitHub PR. Pass a PR number as args to review a PR, or nothing to review the current branch against main. Pass { skipProve: true } to skip running focused proofs.',
  phases: [
    { title: 'Scope', detail: 'classify the diff against Circuit surfaces' },
    { title: 'Review', detail: 'gated Circuit-specific review dimensions' },
    { title: 'Verify', detail: 'adversarial verification of each finding' },
    { title: 'Prove', detail: 'run the focused proofs mapped to touched surfaces' },
    { title: 'Report', detail: 'severity-ranked report + remaining gate commands' },
  ],
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseConfig(a) {
  const cfg = { prNumber: null, base: 'main', skipProve: false }
  if (a === undefined || a === null) return cfg
  if (typeof a === 'number') return { ...cfg, prNumber: String(a) }
  if (typeof a === 'string') {
    const t = a.trim()
    if (/^#?\d+$/.test(t)) return { ...cfg, prNumber: t.replace('#', '') }
    return { ...cfg, base: t }
  }
  if (typeof a === 'object') {
    return {
      prNumber: a.pr != null ? String(a.pr).replace('#', '') : null,
      base: typeof a.base === 'string' && a.base.length ? a.base : 'main',
      skipProve: a.skipProve === true,
    }
  }
  return cfg
}

const cfg = parseConfig(args)

// ---------------------------------------------------------------------------
// Shared Circuit knowledge: the authored-vs-generated map. Hand-editing any
// generated path is a near-automatic blocker; this list is the source of truth
// the Scope and generated-drift dimensions reason against.
// ---------------------------------------------------------------------------
const AUTHORED_SOURCES = [
  'src/flows/<id>/data.ts (the FlowData value)',
  'src/flows/<id>/flow.ts (defineFlowData adapter)',
  'src/flows/<id>/command.md (flow-owned command source, when paths.command is set)',
  'src/flows/<id>/contract.md, reports.ts, relay-hints.ts, writers/**',
  'src/flows/catalog.ts (single source of truth the engine derives from)',
  'src/commands/<id>.md (direct + CLI-only command sources)',
  'src/schemas/flow-block-definitions.ts (block catalog source)',
  'src/**/*.ts engine/runtime/cli/schema code, tests/**, scripts/**',
  'docs/release/parity/*.yaml, docs/release/claims/*.yaml, docs/release/proofs/index.yaml (release ledgers)',
]

const GENERATED_NEVER_HAND_EDIT = [
  'src/flows/<id>/schematic.json',
  'generated/flows/**/*.json (compiled flow manifests + *.work-contract.v0.json)',
  'generated/release/current-capabilities.json',
  'plugins/claude/commands/**.md',
  'plugins/claude/skills/**/*.json',
  'plugins/codex/commands/**.md',
  'plugins/codex/flows/**/*.json',
  'plugins/codex/skills/**/SKILL.md',
  'plugins/claude/runtime/circuit.js, plugins/codex/runtime/circuit.js (esbuild bundles)',
  'docs/generated-surfaces.md, docs/flows/block-catalog.json',
  'docs/release/parity-matrix.generated.md, docs/release/*.generated.md',
]

const REGEN_RULE = 'Edit source under src/ -> run `npm run build && npm run emit-flows` -> verify with `npm run check-flow-drift`. Generated output must only change as a downstream consequence of a source change in the same PR.'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'baseRef', 'headLabel', 'diffCommand', 'nameOnlyCommand', 'changedFiles', 'surfaces', 'directGeneratedEdits', 'diffStat', 'summary'],
  properties: {
    mode: { type: 'string', enum: ['branch', 'pr'] },
    prNumber: { type: 'string' },
    baseRef: { type: 'string', description: 'resolved base ref, e.g. the merge-base commit or origin/main' },
    headLabel: { type: 'string', description: 'human label for what is under review (branch name or PR head)' },
    diffCommand: { type: 'string', description: 'exact shell command a reviewer agent can run to get the full unified diff' },
    nameOnlyCommand: { type: 'string', description: 'exact shell command to list changed file paths' },
    changedFiles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'status'],
        properties: { path: { type: 'string' }, status: { type: 'string', description: 'A/M/D/R' } },
      },
    },
    surfaces: {
      type: 'object', additionalProperties: false,
      description: 'which Circuit surfaces the diff touches (true = touched)',
      required: ['flows', 'catalog', 'runtime', 'cli', 'hooks', 'history', 'schemas', 'contracts', 'runEnvelopeStatusEvidence', 'commands', 'prose', 'generated', 'plugins', 'release', 'router', 'connectors', 'tests', 'evals', 'publicDocs'],
      properties: {
        flows: { type: 'boolean', description: 'src/flows/<id>/** (a flow package)' },
        catalog: { type: 'boolean', description: 'src/flows/catalog.ts or catalog-derivations.ts' },
        runtime: { type: 'boolean', description: 'src/runtime/**' },
        cli: { type: 'boolean', description: 'src/cli/**, bin/circuit' },
        hooks: { type: 'boolean', description: 'plugins/*/hooks/**' },
        history: { type: 'boolean', description: 'src/history/**' },
        schemas: { type: 'boolean', description: 'src/schemas/**' },
        contracts: { type: 'boolean', description: 'docs/contracts/**, tests/contracts/**' },
        runEnvelopeStatusEvidence: { type: 'boolean', description: 'src/run-envelope/**, src/run-status/**, src/process-evidence/**' },
        commands: { type: 'boolean', description: 'src/commands/**, src/flows/<id>/command.md' },
        prose: { type: 'boolean', description: 'product-facing prose: command.md, contract.md, docs/*.md, README.md' },
        generated: { type: 'boolean', description: 'any generated output path (see directGeneratedEdits)' },
        plugins: { type: 'boolean', description: 'plugins/** (any host package file)' },
        release: { type: 'boolean', description: 'scripts/release/**, docs/release/**, generated/release/**' },
        router: { type: 'boolean', description: 'src/flows/router.ts' },
        connectors: { type: 'boolean', description: 'src/connectors/**' },
        tests: { type: 'boolean', description: 'tests/**' },
        evals: { type: 'boolean', description: 'evals/**, scripts/evals/**' },
        publicDocs: { type: 'boolean', description: 'README.md, docs/contracts/**, docs/configuration.md' },
      },
    },
    directGeneratedEdits: {
      type: 'array',
      description: 'changed files that are GENERATED outputs and appear to be hand-edited (or changed without a matching source change). Each is a likely blocker.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'expectedSource'],
        properties: { path: { type: 'string' }, expectedSource: { type: 'string', description: 'the src/ file that should have driven this change, or "none found in diff"' } },
      },
    },
    diffStat: { type: 'string', description: 'raw git diff --stat / shortstat text' },
    summary: { type: 'string', description: 'one-paragraph plain-English description of what the PR does' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'file', 'evidence', 'why', 'suggestedFix', 'confidence'],
        properties: {
          title: { type: 'string', description: 'short imperative description of the problem' },
          severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low', 'nit'] },
          file: { type: 'string', description: 'path:line if known, else path' },
          evidence: { type: 'string', description: 'the exact code/prose snippet or diff hunk that shows the problem' },
          why: { type: 'string', description: 'which Circuit invariant/rule this violates and the concrete consequence' },
          suggestedFix: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'adjustedSeverity'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    reasoning: { type: 'string', description: 'what you checked in the actual files and why the finding holds or does not' },
    adjustedSeverity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low', 'nit'] },
  },
}

const PROVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proofsRun', 'overall'],
  properties: {
    proofsRun: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['command', 'status', 'summary'],
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'skipped', 'error'] },
          summary: { type: 'string', description: 'the key output lines: what passed, or the first real failure with file/line' },
        },
      },
    },
    overall: { type: 'string', description: 'one line: do the focused proofs pass for what changed?' },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'markdown', 'savedPath'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve-with-nits', 'request-changes', 'blocked'] },
    markdown: { type: 'string', description: 'the full human-facing review report in GitHub-flavored markdown' },
    savedPath: { type: 'string', description: 'the repo-relative path the report markdown was written to' },
  },
}

// ---------------------------------------------------------------------------
// Review dimensions. Each carries Circuit-specific knowledge and a gate that
// decides whether the diff is relevant to it. Bug + test dimensions are always
// on for any code change.
// ---------------------------------------------------------------------------
const anyCode = (s) => s.flows || s.catalog || s.runtime || s.cli || s.hooks || s.history || s.schemas || s.runEnvelopeStatusEvidence || s.commands || s.router || s.connectors || s.tests || s.evals

const DIMENSIONS = [
  {
    key: 'correctness',
    title: 'Correctness & logic bugs',
    gate: (s) => anyCode(s),
    knowledge: `General correctness review of the changed TypeScript. This repo runs strict TS
(tsconfig: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitReturns,
noFallthroughCasesInSwitch) and biome (noNonNullAssertion: error, noExplicitAny: error,
useConst: error, noUnusedVariables/Imports: error). So beyond ordinary logic bugs, flag:
- bare array/record index access used without a guard (noUncheckedIndexedAccess makes the value possibly-undefined; using it as defined is a bug),
- non-null assertions (!) and 'as unknown as T' casts that paper over the strict rules,
- optional properties set to undefined in object literals (exactOptionalPropertyTypes will reject; and it hides intent),
- off-by-one / wrong-branch / inverted-condition logic, especially hash comparisons in checkpoint resume (=== vs !==) and sequence validation in trace projection,
- missing await, unhandled promise rejection, swallowed errors.
Focus on logic that is wrong, not style biome already catches.`,
  },
  {
    key: 'flow-catalog-boundary',
    title: 'Flow / catalog engine boundary',
    gate: (s) => s.flows || s.catalog || s.runtime || s.router,
    knowledge: `THE load-bearing architectural invariant: the engine (src/runtime/**) derives everything
from src/flows/catalog.ts. Flows must never require engine edits.
Blockers / high:
- src/runtime/** imports anything from a per-flow package (e.g. import from '../flows/fix/...'). Runtime may only import catalog.ts, types.ts, catalog-derivations.ts, registries/*.
- engine code branching on a specific flow id (flow.id === 'fix' / 'build' etc.). The only sanctioned flow-specific engine switch is CompiledFlowPackage.engineFlags (currently bindsExecutionDepthToRelaySelection). A new flag must name what the engine DOES, not which flow is running.
- a new flow package under src/flows/<id>/ that is not registered in flowDefinitions[] in catalog.ts (engine cannot see it).
- FlowData not wrapped by defineFlowData() in flow.ts (adapter is mandatory).
- paths.command set in data.ts but no src/flows/<id>/command.md on disk (dangling reference; emit breaks).
- a relay report listed in data.ts whose zod schema is missing from reports.ts, or a writer declaring a resultSchemaName that no flow's reports reference (dead registry entry / schema-name collision throws at module load).
- visibility:'internal' flow that has host mirrors under plugins/ (internal flows emit only to generated/flows/**).
Proofs that adjudicate: tests/runner/flow-facts.test.ts, tests/contracts/catalog-completeness.test.ts, tests/contracts/engine-flow-boundary.test.ts, check-flow-drift.`,
  },
  {
    key: 'generated-drift',
    title: 'Generated-surface drift',
    gate: (s) => s.generated || s.plugins || s.flows || s.commands || (s.schemas /* block-definitions */),
    knowledge: `Circuit generates a large surface from a small set of authored sources. Rule: ${REGEN_RULE}
AUTHORED (edit these): ${AUTHORED_SOURCES.join('; ')}.
GENERATED (never hand-edit): ${GENERATED_NEVER_HAND_EDIT.join('; ')}.
Blockers / high:
- a generated path changed by hand, or changed without a corresponding authored-source change in the same diff (drift).
- an authored source (data.ts/flow.ts/command.md/src/commands/*.md/flow-block-definitions.ts) changed but its generated outputs (schematic.json, generated/flows/**, plugins/**/*.json, command + SKILL mirrors, runtime bundles) NOT regenerated -> check-flow-drift will fail.
- $ARGUMENTS, argument-hint, /circuit:, or a '## Authority' footer leaking into plugins/codex/skills/*/SKILL.md (the Codex renderer must strip these).
- stale files: host mirrors for an internal flow (e.g. plugins/*/...runtime-proof/), per-mode siblings (e.g. an old tournament.json after collapse), command/skill files for a removed command.
- a compiled flow JSON without its sibling *.work-contract.v0.json projection.
- plugins/*/runtime/circuit.js changed without a build-plugin-runtime regeneration (or older than dist/cli/circuit.js).
Cross-check every flagged generated path against docs/generated-surfaces.md (the canonical source->output map). The proof is 'npm run check-flow-drift' (build + emit --check + check-plugin-runtime).`,
  },
  {
    key: 'dual-host-parity',
    title: 'Dual-host parity (Claude Code + Codex)',
    gate: (s) => s.flows || s.commands || s.plugins || s.release || s.connectors,
    knowledge: `Circuit ships two host packages that must expose identical public capability. Public flows
(build, fix, explore, review, prototype, pursue, goal) and the run/handoff commands must exist and behave
the same on both hosts. Claude uses plugins/claude/skills/<id>/*.json; Codex uses plugins/codex/flows/<id>/*.json
PLUS plugins/codex/skills/<id>/SKILL.md wrappers; both get plugins/<host>/commands/<id>.md.
Blockers / high:
- a flow/mode/command added or changed for one host but not the other (e.g. new plugins/claude/skills/<id>/lite.json with no plugins/codex/flows/<id>/lite.json, or vice versa).
- command docs in plugins/claude/commands/<id>.md vs plugins/codex/commands/<id>.md diverging beyond the intended shell-invocation wording.
- host-specific flow behavior creeping into flow definitions (grep src/flows for 'claude-code'/'codex' branching - flows must be host-agnostic; host specifics belong only in hooks/connectors).
- the Codex plugin cache not synced: a plugins/codex/** change without acknowledging 'npm run sync:codex-plugin-cache' (the cache at ~/.codex is hash-verified by check:codex-plugin-cache).
- a parity-matrix gap (status partial/missing in docs/release/parity-matrix.generated.md) with no matching exception (with readiness_ref) in docs/release/parity/exceptions.yaml.
Proofs: check:codex-plugin-cache, check-flow-drift, check-parity (via check-release-infra), tests/flow-runtime-smoke, the host smoke scripts.`,
  },
  {
    key: 'schema-contract',
    title: 'Schema & contract discipline',
    gate: (s) => s.schemas || s.contracts || s.runEnvelopeStatusEvidence,
    knowledge: `Schemas are zod (v4), strict (.strict() roots reject surplus keys), versioned with literal strings
(run.envelope@v0 etc.), and enforced by ~61 contract tests. Run records carry a dual-outcome guarantee
(surface_output.outcome must equal record.outcome) and superRefine guards (claim-to-gate, checkpoint-attempt
pairing, outcome-gated result_ref). Per AGENTS.md rule 6, contract/migration changes are exactly the kind of
hard-to-revert decision that warrants explicit Codex review - call that out when you see one.
Blockers / high (these are breaking unless dual-version support is added, and existing on-disk run records must still parse):
- a field made required (added without .optional(), or .optional() removed) on a schema that is read from disk,
- a schema/api version literal bumped without keeping the prior version in the discriminated union,
- an enum variant removed/renamed (RunEnvelopeOutcome, ProcessEvidenceOutcome, engine_state, RefKind, ...),
- .strict() relaxed to .passthrough()/.strip(), or .min(1) constraints dropped,
- a new RefKind that is content-bearing not added to ContentRefKinds (sha256 enforcement gap),
- a superRefine guard added/changed in run-envelope.ts or process-evidence.ts without a contract test covering the new behavior,
- a new schema module not re-exported from src/schemas/index.ts (schemas-barrel test) or lacking a tests/contracts/*.test.ts.
Proof: targeted vitest over tests/contracts/ (name the specific files).`,
  },
  {
    key: 'runtime-hooks',
    title: 'Runtime, CLI & host-hook rules',
    gate: (s) => s.runtime || s.cli || s.hooks || s.history || s.connectors,
    knowledge: `Circuit-specific runtime rules:
- AGENTS.md rule 7 (BLOCKER if violated): host hook scripts (plugins/*/hooks/*.ts) must read the host's stdin JSON
  for workspace identity and pass an explicit --project-root. process.cwd() is NOT the project authority inside a hook.
  Spot: process.cwd() in a hook file, or a hook spawning the CLI without an explicit project root derived from stdin.cwd.
- RunContext is the immutable runtime authority (runId, runDir, projectRoot explicit). The graph runner owns step
  advancement / trace writes / recovery routes / checkpoint waiting / terminal close and must stay flow-agnostic.
- Relay executor must resolve the connector kind (claude-code/codex/cursor-agent/custom) over all branches and validate
  the response against the zod-derived JSON schema before use; acceptance criteria evaluated after the relay.
- Checkpoint resume must reload flow bytes from the run folder (not from generated/) and compare the manifest snapshot
  hash correctly (=== ). Trace projection (run-status) must validate sequence contiguity and tolerate damaged state.
- Evidence policy flag (includeUntrackedFileContent) must thread CLI -> compiled-flow-runner -> graph-runner -> executors.
Proofs: tests/runner/{cli-router,cli-runtime,runtime-smoke,history-cli}.test.ts, tests/runtime, tests/flow-runtime-smoke.`,
  },
  {
    key: 'tests',
    title: 'Test coverage & layering',
    gate: (s) => anyCode(s),
    knowledge: `Project rules (AGENTS.md): fixing a bug => a failing test FIRST; changing behavior => the test changes with it.
verify is the canonical gate. Pick the right layer:
- flow authoring -> tests/runner/flow-facts.test.ts + tests/contracts/catalog-completeness.test.ts + check-flow-drift
- runtime path -> tests/runtime/ + tests/flow-runtime-smoke/
- schema/contract -> tests/contracts/
- generated host package -> check-flow-drift; release surface -> check-release-infra; evals -> check-evals.
Flag: a behavior change in src/ with no new/changed test; a bug fix with no reproducing test; a test placed in a
slow layer when a fast one fits (cli-router.test.ts is the known slow outlier - excluded from test:fast - adding to it
needs a real reason); a deleted/skipped contract or catalog-completeness test; an evals/registry.json change without check-evals.
You are judging test ADEQUACY for what changed, not re-reviewing the code logic (that is the correctness dimension).`,
  },
  {
    key: 'prose',
    title: 'Product prose & ubiquitous language',
    gate: (s) => s.prose || s.commands || s.publicDocs,
    knowledge: `Product-facing prose (src/commands/*.md, src/flows/*/command.md, src/flows/*/contract.md, docs/*.md, README.md,
host command/SKILL mirrors) must follow AGENTS.md rule 3, CONTEXT.md, and UBIQUITOUS_LANGUAGE.md:
- Use canonical vocabulary only: flow, schematic, block, stage, step, route, relay, check, trace, report, evidence, run folder, checkpoint, rigor (lite/standard/deep), depth, mode. Forbidden aliases: workflow, pipeline, phase, lane, task, job, artifact, event log, executor (use role/connector), adapter (use connector), tool (when meaning skill).
- Plain English: short sentences, one idea each. NO em dashes (use a period or colon). No marketing slop / AI-isms (unleash, seamless, paradigm, synergy, leveraging, cutting-edge, state-of-the-art, magic, vibe coding, "AI coding"). No project-internal jargon or codename ids without describing what they are.
- No review-result-class language in operator-facing output: do not say passed/failed/concern for human outcomes; use complete/stopped/escalated or concrete description.
- Keep runtime terms (CompiledFlow, relay step, relay transcript, acceptance criteria, trace entry) out of operator prose unless it is a contract/troubleshooting surface; wrap serialized field names in backticks.
- No prose/schematic drift: a stage/step/route a doc describes must match the schematic.json / contract.md it documents; do not invent runtime policy in prose.
Cite the exact offending line. Em dashes, forbidden aliases, and result-class language are concrete and high-signal.`,
  },
  {
    key: 'release-surface',
    title: 'Release surface & ledgers',
    gate: (s) => s.release || s.catalog || s.router || s.connectors || s.publicDocs,
    knowledge: `The release surface is ledger-driven and gated by check-release-infra / check-release-ready.
- Every public claim in docs/release/claims/public-claims.yaml must be backed (capability_id / proof_id / test_path / script_check) and verified_current.
- Every implemented capability in generated/release/current-capabilities.json must exist in the runtime; new capabilities (flow, mode, utility, connector, command, host, route outcome) must be re-emitted (npm run emit-release) and reflected in the matrix.
- Every parity gap / unbacked claim / proof gap that is not closed must be tracked by an exception in docs/release/parity/exceptions.yaml WITH a readiness_ref.
- Required proof categories (doing-work, deciding, continuity, customization, first-run, failure, plan-execution) must each have a verified_current scenario (with its required_files present under docs/release/proofs/runs/) or an exception.
- Any fileURLToPath() in src/ must carry a 'Marketplace-safe by ...' annotation (audit-marketplace-safe-paths) - plugin bundles relocate files vs the source tree.
- README.md / docs/contracts/ wording is audited (audit-public-docs); new claims need a backing or a tracked exception.
Flag changes that add public claims/capabilities/docs without the matching ledger update or proof, or that introduce an untracked gap. Proof: npm run check-release-infra (and check-release-ready before shipping).`,
  },
]

// ---------------------------------------------------------------------------
// Phase 1 - Scope
// ---------------------------------------------------------------------------
phase('Scope')

const scopePrompt = `You are scoping a Circuit pull request for review. Work READ-ONLY (git/gh/grep/read only; do not modify the tree).

${cfg.prNumber
  ? `Target: GitHub PR #${cfg.prNumber}. Use the gh CLI. Get metadata with \`gh pr view ${cfg.prNumber} --json title,body,baseRefName,headRefName,additions,deletions,files\`. Get the patch with \`gh pr diff ${cfg.prNumber}\` and the file list with \`gh pr diff ${cfg.prNumber} --name-only\`. Set mode='pr', prNumber='${cfg.prNumber}', baseRef to the PR base, headLabel to the PR head branch, diffCommand to \`gh pr diff ${cfg.prNumber}\`, nameOnlyCommand to \`gh pr diff ${cfg.prNumber} --name-only\`.`
  : `Target: the current branch vs '${cfg.base}'. Resolve the base ref: prefer \`git merge-base origin/${cfg.base} HEAD\` if origin exists, else \`git merge-base ${cfg.base} HEAD\`. Set mode='branch', baseRef to that resolved ref (a commit sha is fine), headLabel to the current branch name (\`git rev-parse --abbrev-ref HEAD\`), diffCommand to \`git diff <baseRef>...HEAD\`, nameOnlyCommand to \`git diff --name-only <baseRef>...HEAD\`. Capture diffStat from \`git diff --stat <baseRef>...HEAD\`.`}

Then classify the changed files against Circuit's surfaces (see the 'surfaces' schema for exact globs). A file can light up several surfaces.

Critically, build directGeneratedEdits: for EACH changed file that is a GENERATED output, record it and the authored source that should have driven it. Generated outputs that must never be hand-edited:
${GENERATED_NEVER_HAND_EDIT.map((p) => `  - ${p}`).join('\n')}
Authored sources are:
${AUTHORED_SOURCES.map((p) => `  - ${p}`).join('\n')}
A generated file in the diff is fine ONLY if its driving source changed in the same diff (it is a regeneration). If a generated file changed with no matching source change, list it in directGeneratedEdits with expectedSource (or 'none found in diff'). Use docs/generated-surfaces.md to map sources to outputs precisely.

Write a one-paragraph plain-English summary of what the PR does. Return the structured scope.`

const scope = await agent(scopePrompt, { schema: SCOPE_SCHEMA, label: 'scope', phase: 'Scope' })

if (!scope) {
  return { error: 'scope step was skipped; nothing to review' }
}

const active = DIMENSIONS.filter((d) => d.gate(scope.surfaces))
const touched = Object.entries(scope.surfaces).filter(([, v]) => v).map(([k]) => k)
log(`Scope: ${scope.changedFiles.length} files, surfaces [${touched.join(', ') || 'none'}]. Running ${active.length} dimensions: ${active.map((d) => d.key).join(', ')}.`)
if (scope.directGeneratedEdits.length) {
  log(`⚠ ${scope.directGeneratedEdits.length} generated path(s) changed without a clear source driver - flagged for the drift dimension.`)
}

// ---------------------------------------------------------------------------
// Phase 2+3 - Review (gated) then adversarial Verify, pipelined per dimension
// ---------------------------------------------------------------------------
const sharedContext = `PR under review: ${scope.headLabel} (base ${scope.baseRef}).
Summary: ${scope.summary}
Get the full diff with: ${scope.diffCommand}
List changed files with: ${scope.nameOnlyCommand}
Changed files:
${scope.changedFiles.map((f) => `  ${f.status} ${f.path}`).join('\n')}
${scope.directGeneratedEdits.length ? `\nGenerated files changed without a clear source driver:\n${scope.directGeneratedEdits.map((g) => `  - ${g.path} (expected source: ${g.expectedSource})`).join('\n')}` : ''}

Work READ-ONLY. Run the diff command, read the actual files for context, and ground every finding in a real snippet. Only report problems you can see in THIS diff. Prefer a few high-confidence findings over a long speculative list. Assign severity honestly: blocker = merge must not happen, high = must fix before merge, medium = should fix, low = minor, nit = optional polish.`

function verifierCount(sev) {
  if (sev === 'blocker' || sev === 'high') return 2
  if (sev === 'medium') return 1
  return 0 // low / nit pass through unverified
}

async function verifyFindings(findings, dim) {
  if (!findings || !findings.length) return []
  const annotated = await parallel(
    findings.map((f) => async () => {
      const n = verifierCount(f.severity)
      if (n === 0) return { ...f, dimension: dim.key, verdict: 'unverified', verifyReasoning: 'low/nit: not independently verified', confirmedSeverity: f.severity }
      const lenses = n === 2 ? ['correctness', 'Circuit-convention'] : ['correctness']
      const votes = await parallel(
        lenses.map((lens) => () =>
          agent(
            `You are an adversarial verifier for a Circuit PR review, using the ${lens} lens. Your job is to REFUTE this finding if you reasonably can. Default to 'refuted' if you cannot independently confirm it from the actual repo state.

Finding (dimension: ${dim.key}):
- title: ${f.title}
- severity: ${f.severity}
- file: ${f.file}
- evidence: ${f.evidence}
- why it matters: ${f.why}
- suggested fix: ${f.suggestedFix}

Context: ${sharedContext}

Independently check the claim: run \`${scope.diffCommand}\` (focus on ${f.file}), Read the file(s), and for Circuit-convention claims cross-check the relevant rule (docs/generated-surfaces.md for drift, AGENTS.md for boundary/hook/prose rules, UBIQUITOUS_LANGUAGE.md for vocabulary, the schema file + its contract test for schema claims). Decide: confirmed (the problem is real and the severity is right), refuted (not a real problem, or already handled elsewhere, or the diff does not actually do this), or uncertain. Adjust severity if the finding is real but mis-sized.`,
            { schema: VERDICT_SCHEMA, label: `verify:${dim.key}:${(f.file || '').split('/').pop()}:${lens}`, phase: 'Verify' },
          ),
        ),
      )
      const real = votes.filter(Boolean)
      const confirmedCount = real.filter((v) => v.verdict === 'confirmed').length
      const refutedCount = real.filter((v) => v.verdict === 'refuted').length
      // survives if at least one verifier confirms and confirmers >= refuters
      const verdict = confirmedCount > 0 && confirmedCount >= refutedCount ? 'confirmed' : (refutedCount > confirmedCount ? 'refuted' : 'uncertain')
      const sev = real.find((v) => v.verdict === 'confirmed')?.adjustedSeverity || f.severity
      return {
        ...f,
        dimension: dim.key,
        verdict,
        verifyReasoning: real.map((v) => `[${v.verdict}] ${v.reasoning}`).join(' | '),
        confirmedSeverity: sev,
      }
    }),
  )
  return annotated.filter(Boolean)
}

const reviewed = await pipeline(
  active,
  (dim) =>
    agent(
      `${dim.knowledge}

${sharedContext}

Review the diff strictly for the "${dim.title}" dimension. Report only findings that fall under this dimension; other dimensions are handled by separate reviewers.`,
      { schema: FINDINGS_SCHEMA, label: `review:${dim.key}`, phase: 'Review' },
    ).then((res) => ({ dim, findings: res?.findings ?? [] })),
  (res) => verifyFindings(res.findings, res.dim),
)

const allFindings = reviewed.filter(Boolean).flat()
const surviving = allFindings.filter((f) => f.verdict === 'confirmed' || f.verdict === 'uncertain' || f.verdict === 'unverified')
const dropped = allFindings.filter((f) => f.verdict === 'refuted')
log(`Review: ${allFindings.length} findings raised, ${dropped.length} refuted by verifiers, ${surviving.length} kept.`)

// ---------------------------------------------------------------------------
// Phase 4 - Prove: run the focused proofs mapped to touched surfaces
// ---------------------------------------------------------------------------
let proofs = null
if (cfg.skipProve) {
  log('Prove: skipped (skipProve=true).')
} else {
  phase('Prove')
  const provePrompt = `You are running the FOCUSED verification proofs for a Circuit PR, to ground the review in real pass/fail signal. Run only the minimal set that maps to what changed. Run commands from the repo root. These are read-only check variants (they may rebuild dist/, which is fine). Run them SERIALLY (some invoke npm run build and write dist/). Capture the real result; for failures, include the first genuine error with file/line.

Touched surfaces: ${touched.join(', ')}.

Mapping (run a command only if its trigger surface was touched):
- flows / catalog / generated / plugins / commands changed -> \`npm run check-flow-drift\` (build + emit --check + check-plugin-runtime). Highest-value drift signal.
- schemas / contracts / run-envelope|status|process-evidence changed -> \`npx vitest run tests/contracts\` (or the specific *.test.ts files for the changed schemas).
- runtime / cli / hooks / history changed -> \`npx vitest run tests/runtime tests/flow-runtime-smoke\`. Add \`npx vitest run tests/runner/cli-runtime.test.ts\` for CLI wiring (avoid the slow cli-router subprocess test unless routing changed).
- release / catalog / router / connectors / publicDocs changed -> \`npm run check-release-infra\`.
- evals changed -> \`npm run check-evals\`.
If nothing maps, run \`npm run check && npm run lint\` as a baseline and say so.
Do NOT run the full \`npm run verify\` (too heavy for a review pass); that is the author's canonical gate and the report will recommend it. Cap total proof runtime to a few targeted commands. Return what you ran and the outcomes.`
  proofs = await agent(provePrompt, { schema: PROVE_SCHEMA, label: 'prove', phase: 'Prove' })
  if (proofs) log(`Prove: ${proofs.overall}`)
}

// ---------------------------------------------------------------------------
// Phase 5 - Report
// ---------------------------------------------------------------------------
phase('Report')

// Where the report is persisted. .circuit/ is gitignored evidence, so this
// never dirties git status. Slug = pr-<n> for a PR, else the sanitized branch.
const reviewSlug = cfg.prNumber ? `pr-${cfg.prNumber}` : (scope.headLabel || 'branch').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
const reviewPath = `.circuit/reviews/${reviewSlug}.md`

const reportPrompt = `You are writing the final Circuit PR review report. Synthesize the verified findings and the focused-proof results into a clear, severity-ranked report in GitHub-flavored markdown. Follow Circuit's own prose rules (plain English, short sentences, NO em dashes, no marketing language).

PR: ${scope.headLabel} (base ${scope.baseRef})
What it does: ${scope.summary}
Surfaces touched: ${touched.join(', ') || 'none'}
Dimensions run: ${active.map((d) => d.key).join(', ')}

Verified findings (JSON):
${JSON.stringify(surviving.map((f) => ({ dimension: f.dimension, title: f.title, severity: f.confirmedSeverity, file: f.file, why: f.why, suggestedFix: f.suggestedFix, verdict: f.verdict, evidence: f.evidence })), null, 2)}

Refuted (do NOT include as findings; mention only as a one-line count): ${dropped.length}

Focused proofs:
${proofs ? JSON.stringify(proofs, null, 2) : 'skipped'}

Write markdown with these sections:
1. **Verdict** - one of approve / approve-with-nits / request-changes / blocked, with a one-sentence rationale. Use 'blocked' if any confirmed blocker exists or a focused proof failed; 'request-changes' for confirmed high/medium issues; 'approve-with-nits' for only low/nit; 'approve' if clean.
2. **Summary** - 2-3 sentences on what the PR does and the headline risk, if any.
3. **Findings** - grouped by severity (Blockers, High, Medium, Low, Nits), each as: file:line - title; why (the Circuit rule it touches); suggested fix. Skip empty groups. Note '(unverified)' for low/nit that were not adversarially checked.
4. **Proof results** - a short table of command -> pass/fail and the key line.
5. **Remaining gate** - the exact commands the author must run before merge, chosen for what changed: always end with the canonical \`npm run verify\`, and list the focused proofs (check-flow-drift, vitest tests/contracts, vitest tests/runtime tests/flow-runtime-smoke, check-release-infra, check-evals, sync:codex-plugin-cache) that apply. If a schema/contract or migration change is present, note that AGENTS.md rule 6 makes this a candidate for explicit /codex review.
6. **Not reviewed** - surfaces NOT touched (so not reviewed) and any proofs skipped, so the reader knows the coverage boundary.

Set verdict to the matching enum value and put the whole report in markdown.

After composing the markdown, PERSIST it: create the directory '.circuit/reviews/' if needed and Write the report to the repo-relative path '${reviewPath}'. Prepend a single HTML-comment header line of the form:
<!-- circuit-pr-review | ${scope.headLabel} | base ${scope.baseRef} | verdict <your-verdict> -->
Then set savedPath to '${reviewPath}'. The 'markdown' field you return must be the same report text (without needing the header).`

const report = await agent(reportPrompt, { schema: REPORT_SCHEMA, label: 'report', phase: 'Report' })
if (report?.savedPath) log(`Report saved to ${report.savedPath}`)

return {
  scope: { headLabel: scope.headLabel, baseRef: scope.baseRef, surfaces: touched, files: scope.changedFiles.length },
  findings: surviving,
  refutedCount: dropped.length,
  proofs,
  verdict: report?.verdict ?? 'unknown',
  savedPath: report?.savedPath ?? null,
  report: report?.markdown ?? '(report generation was skipped)',
}
