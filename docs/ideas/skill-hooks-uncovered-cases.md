# Skill Hooks: uncovered cases

Status: gap analysis, 2026-06-04. Companion to
[`skill-hooks-dispatch-spec.md`](./skill-hooks-dispatch-spec.md) (what slices
1-3 shipped and what was deferred),
[`skill-hooks-first-principles.md`](./skill-hooks-first-principles.md) (the
reframe), and the vocabulary contract
[`docs/specs/skill-hook-vocabulary-v1.md`](../specs/skill-hook-vocabulary-v1.md).

This note catalogs scenarios and interactions that the current Skill Hooks
design and code do not handle. It is not a roadmap. It is the evidence base a
later slice can pick from.

## What this is and how it was produced

A multi-agent sweep fanned out across nine facets of the "agent skills inside
Circuit" design space (detection and firing, skill resolution, injection
semantics, host parity, config ergonomics, interplay with checks and recovery,
safety and trust, observability, and real-world user journeys). Each candidate
gap was then put through an adversarial refutation pass: a second agent read the
cited code, tests, and docs and tried to prove the gap was already handled or
already deferred. Of 52 candidates, 37 survived and 15 were refuted. Both lists
are below, because knowing what is already handled is as useful as knowing what
is not.

Every finding carries the file:line evidence the sweep verified. Severity is the
refined post-verification value. Status is one of:

- **new** — a genuinely uncovered case written down nowhere before this note.
- **named deferral** — already named as a future slice in the dispatch spec or
  vocabulary spec. Listed for completeness; not a surprise.

## The shape of it (executive summary)

Three ideas hold most of the weight.

1. **The feature is invisible and silent end to end.** Even when a hook fires
   and injects correctly, no operator-facing output says so. A misconfigured or
   unavailable skill fails silently by default. The two worked examples in
   `docs/configuration.md` both point at hooks or flows that never fire. For a
   feature whose whole pitch is "the right expertise at the right time," the
   operator cannot see the right time happened, discover the feature exists, or
   debug why a worker behaved differently. This is the cluster to fix first, and
   it directly undercuts Circuit's observability-as-trust posture.

2. **Injecting a skill is not running a skill.** Circuit splices the `SKILL.md`
   body into one worker prompt. For a large share of real skills (multi-step
   harnesses, skills with bundled reference files, skills that need a target like
   "review this diff"), that does not reproduce what the skill does. Nothing
   classifies which skills are good hook candidates or warns when one is not.

3. **The reachable surface is much smaller than the vocabulary implies.** Today a
   hook can fire only for: a flat-slug skill installed under `~/.agents/skills`
   or `~/.claude/skills`, on a Build or Fix run, on the edit-files or
   verification-failed hooks. Plugin and marketplace skills (most of an
   operator's installed set) cannot resolve. Seven of eleven hooks have no
   producer. Fanout-branch work fires nothing.

Two safety knobs a careful operator would reach for (`skills.require_known` and
skill-body integrity pinning) are wired but dead. Cardinality is documented but
enforced nowhere, though its blast radius is the audit record, not behavior.

A correction worth stating up front: the obvious-looking blocker, the `SkillId`
slug regex rejecting namespaced ids like `vercel:deploy`, is **not** the
operative wall. Relaxing the regex would not help, because resolution goes
through a registry that only discovers flat-named `SKILL.md` directories in two
home roots. The registry's discovery scope is the real boundary. (See the
refuted list, item R1.)

---

## Dispositions (2026-06-04 implementation slice)

A focused slice resolved the legibility/correctness cluster. Each finding's
disposition below; detailed `**Resolution**` notes are inline on the resolved
findings.

**Resolved (with evidence):**

- **A1, A2, A3** — The operator summary now carries `skill_hook_activations`:
  every fired hook, the skill it injected, that skill's provenance (hook +
  `policy_ref`/source), and any configured-but-unavailable skill. Proven in
  `tests/runner/operator-summary-writer.test.ts` and an end-to-end actuation run.
- **A4** — Docs reconciled: `docs/configuration.md` shows only fireable hooks and
  marks the lifecycle family reserved; the stale `moments:` key is gone from
  `docs/yaml-validation.md`; the false "awaits an operator choice" comment at
  `graph-runner.ts` is corrected.
- **A8** — A dispatch crash is recorded as a `run.skill-hook-error` trace entry
  and surfaced as a `skill_hook_dispatch_failed` evidence warning (mirrors
  `html_render_failed`), no longer swallowed silently.
- **C1, C2, C5** — Flat-home-dir-only reach boundary documented + unavailable
  signal (A3) + registry boundary tests.
- **D5** — Live sub-bug fixed: the injection channel is re-seeded from recorded
  `run.skill-hook` events on resume.
- **E1** — Dead `require_known` removed.

**Accepted as recorded limitations (no change this slice, outside the deferred set):**

- **A7** — Persistent-injection legibility is improved by the new disclosure (the
  operator now sees what is injected); a cumulative "still active N steps later"
  view is a low-value follow-up.
- **C4** — Fanout-branch detection blindness is structural: dispatch runs only at
  the top-level step loop and branch checks/gaps live in branch-local files.
  Branch-trace propagation is a larger change.
- **D2** — `before:edit-files` injecting on an advisory prediction without a
  planned-vs-actual reconciliation is accepted v1 behavior; a reconciliation
  guard is a follow-up.
- **D3** — Slice-scope over-injection is low impact (advisory body; Build relay
  hints already scope work to the current slice).
- **D4** — The `after:verification-failed` loop is bounded by the recovery
  `max_attempts` budget; a hook-level circuit breaker is a follow-up.
- **E4** — `detection.disabled_patterns` has no runtime readers, but it is not
  advertised in any operator doc and has a working equivalent (`mode: mute`).
  Left in place because removing it is a *subtractive* change to the shipped
  `skill_hooks` config surface (unlike `require_known`, a PolicyEnvelope field);
  recorded as a known no-op rather than churned this slice.
- **F1** — Claude's native description-trigger lives in the orchestrator session
  outside Circuit's connector subprocess; Circuit cannot suppress it. Host-level
  limitation.
- **F2** — Forward-looking: a third host inherits injection only via the existing
  subprocess connectors; no host-package extension point is needed until then.

**Deferred (out of this slice's scope per the work Goal; each remains a named
future arm above):** B1-B5 (inject-is-not-run), A5/A6 (discovery & dry-run CLI),
C3/C6 (lifecycle family + recovery after-arm), D1 (cardinality enforcement), D6
(per-flow/stage policy scoping), E2/E3 (skill sha/version pinning).

---

## Confirmed uncovered cases

### Group A — Observability and discoverability

The strongest cluster. Most findings here are independent and converge on the
same problem: the operator has no window into the feature.

#### A1. `run.skill-hook` is surfaced in zero operator-facing outputs
- **Severity:** medium. **Status:** new.
- **Case:** A run injects a skill via an `auto` hook. The markdown operator
  summary, the HTML report, the run surface, the run envelope, and the terminal
  digest all say nothing. The only record is a `run.skill-hook` line in
  `trace.ndjson`, which the operator never reads.
- **Why:** The operator-summary writer consumes only `checkpoint.resolved` trace
  entries; there is no `readSkillHookEvents` equivalent. A repo-wide grep across
  the operator-summary, run-status, process-evidence, run-envelope, and HTML
  surfaces finds no skill-hook reference. Report-only slices 1-2 were
  deliberately "byte-identical to a no-dispatch run," but slice 3 then changed
  worker behavior through injection while keeping that same invisibility, with no
  compensating surface.
- **Evidence:** `src/shared/operator-summary-writer.ts:192-214` (reads only
  `checkpoint.resolved`), `:402-410` (existing `Worker access:` disclosure line,
  the in-pattern precedent), `src/runtime/run/graph-runner.ts:1016` (trace append
  is the only sink), `docs/ideas/skill-hooks-dispatch-spec.md:94`.
- **Fix direction:** Add an injected-skills disclosure line to the operator
  summary, mirroring the existing `Worker access:` line. Smallest high-leverage
  change in this note.
- **Resolution (2026-06-04):** Done as a structured field, `skill_hook_activations`
  on the operator summary (mirroring `auto_resolutions` rather than a single
  details line, so it carries full per-hook provenance and renders as its own
  "Skill hooks" section). Read from the `run.skill-hook` trace events by
  `readSkillHookSummary` in `src/shared/operator-summary-writer.ts`.

#### A2. `skills.loaded` cannot distinguish an injected skill from a declared one
- **Severity:** medium. **Status:** new.
- **Case:** A worker behaves differently because a hook silently injected a
  skill. The operator opens the trace, finds the step's `skills.loaded` entry,
  and sees the skill listed flatly next to the flow's declared skills. They
  cannot tell it was injected, which hook injected it, which `policy_ref`
  authorized it, or which signal matched.
- **Why:** Injected skills are appended to the same flat `loaded` array as
  selection and slot skills, slot-less. `LoadedSkillEvidence` is
  `{id, slot?, path, sha256, bytes}` with no origin/hook/injected field. Absence
  of `slot` is ambiguous, because a selection skill is also slot-less. The
  `run.skill-hook` event and the `skills.loaded` entry are never joined. Worse,
  `run.skill-hook` records the step id of the *triggering* step, but injection
  flows to the *next* implementer relay through the persistent channel, so even a
  step-id join would not align.
- **Evidence:** `src/schemas/trace-entry.ts:269-278` (no provenance field),
  `src/runtime/executors/relay.ts:525-533` (emits id/slot/path/sha256/bytes
  only), `src/shared/skill-loading.ts:93-99` (injected appended slot-less),
  `src/runtime/run/relay-guidance.ts:388-389`.
- **Resolution (2026-06-04):** The operator can now distinguish injected skills
  from declared ones at the run-summary level: each `skill_hook_activations` entry
  names the hook, the injected skill id, and the authorizing `policy_ref`/source.
  This resolves the operator-facing legibility gap. The lower-level
  `LoadedSkillEvidence` per-step join (adding an origin field to `skills.loaded`)
  is not needed for that and is left unchanged.

#### A3. A mistyped or unavailable skill fails silently by default
- **Severity:** medium. **Status:** new.
- **Case:** An operator configures `after:edit-files:.tsx -> auto -> [my-skill]`
  but the id is mistyped, lives in a plugin, or was renamed. With `strict:false`
  (the default), `buildRunSkillHookEvent` records it under `unavailable_skills`,
  injects nothing, and raises no decision. Across a whole run the operator
  believes a skill is augmenting every implementer step while nothing loads. The
  only trace is a buried `unavailable_skills` list.
- **Why:** A decision packet is raised only when `policy.strict && unavailable > 0`;
  `strict` defaults to false. The injection drop is deliberate and tested. The
  uncovered part is the absence of any *surfaced* signal that a non-strict hook
  is dead.
- **Evidence:** `src/skill-hooks/policy.ts:129-132`, `:118-126`,
  `src/schemas/skill-hook.ts:155` (strict defaults false), `:276`
  (`unavailable_skills` optional on the event).
- **Resolution (2026-06-04):** A non-strict hook whose skill is unavailable is no
  longer silent: the operator summary lists it under
  `skill_hook_activations[].unavailable_skills` (id + first-line reason), so a
  dead hook is visible without reading the trace. Proven by the A3 case in
  `tests/runner/operator-summary-writer.test.ts`.

#### A4. Both worked config examples point at hooks or flows that never fire
- **Severity:** medium. **Status:** new (the inert state of the lifecycle family
  is a named deferral, but the operator-facing example is not).
- **Case:** A user copies the documented `skill_hooks` example. One example wires
  `before:architecture-analysis: { mode: mute }`, a lifecycle hook with no
  producer that can never fire. The other, the flagship
  `after:edit-files:.tsx -> react-doctor`, only matches Fix, not Build (see C-/D
  findings). Either way the config validates cleanly and nothing tells the
  operator their rule is inert.
- **Why:** `docs/configuration.md` presents both as working, with identical
  framing and no marker distinguishing fireable from inert. The dispatcher only
  produces `after:verification-failed`, `after:evidence-gap`, and
  `before/after:edit-files`. `before:architecture-analysis` appears in `src/`
  only in the vocabulary table. A second operator doc repeats the inert example
  and is additionally stale (uses the retired `moments:` key). The internal
  dispatch spec records the lifecycle family as deferred, but that spec lives
  under `docs/ideas/`, which `documentation-surface.test.ts` excludes from the
  operator surface, so the operator never sees it.
- **Evidence:** `docs/configuration.md:130-142`, `src/skill-hooks/dispatch.ts:55-72,169-213`,
  `src/schemas/skill-hook.ts:13-18,105-132`, `docs/specs/yaml-validation.md:69`
  (stale repeat).
- **Fix direction:** Reconcile the docs. Lowest-cost, highest-embarrassment-
  avoidance item in this note.
- **Resolution (2026-06-04):** `docs/configuration.md` now has a "Hooks that fire
  today" table (edit-files on Fix `after` / Build `before`; verification hooks on
  Build/Fix) and a "Reserved hooks (not firing yet)" subsection naming the inert
  lifecycle family. The flagship example uses a fireable `after:edit-files:.tsx`
  rule annotated as Fix-only, and the `mute` example uses the fireable
  `after:verification-failed`. The stale `moments:` key in
  `docs/yaml-validation.md` is now `skill_hooks:`, and the false
  "awaits an operator choice" comment at `graph-runner.ts` is corrected.

#### A5. No CLI surface to discover skill ids or hook names
- **Severity:** medium. **Status:** new.
- **Case:** To write a policy an operator must know the exact skill id to type
  and which hook names are legal. There is no `circuit skills list`, no
  `circuit hooks list`, no `circuit config validate`. The full CLI vocabulary is
  run/resume/handoff/history/memory/create/runs/version.
- **Why:** `CLI_COMMAND_NAMES` enumerates every command and has no skills/hooks/
  config entry. `registry.list()` is never wired to any CLI command. The eleven
  legal hook names live only in `SKILL_HOOK_VOCABULARY`. The operator discovers
  both id and hook names only by reading source or `ls`-ing two home directories.
- **Evidence:** `src/cli/command-vocabulary.ts:9-18`,
  `src/shared/user-skill-registry.ts:33-35,150-152`, `src/schemas/skill-hook.ts:4-80`.
  A read-only `circuit skills` doctor is named as a future idea in
  `skill-hooks-alternatives-v1.md:672-674`, not in the dispatch-spec deferral list.

#### A6. No dry-run or explain for hooks
- **Severity:** low. **Status:** new.
- **Case:** Before committing a run, an operator wants to know which hooks their
  config will match, which skills would inject, and whether any configured skill
  is unavailable. There is no command or flag. The only way to learn is to run a
  real flow and inspect `trace.ndjson` afterward, which (per A1) is itself not
  surfaced.
- **Why:** No skill-hook CLI surface exists. The global `--dry-run` flag is
  explicitly rejected as unimplemented. The dispatcher is built to run inside the
  graph-runner post-step loop against live trace entries and report files; it has
  no standalone "given this config, what would fire" entry point.
- **Evidence:** `src/cli/circuit.ts:313-319` (`--dry-run` rejected),
  `src/skill-hooks/dispatch.ts:79-106,169-213`.

#### A7. A skill injected once is invisibly still active many steps later
- **Severity:** low. **Status:** new (the persistence is intended; its
  legibility is the gap).
- **Case:** `after:verification-failed` fires at step 3 and injects a skill. The
  channel never drains, so steps 4, 7, 11 (all implementer relays) keep loading
  it, even after the original failure is long resolved. There is no cumulative
  "currently active injections" view and no signal that step 11 is running under
  a step-3 injection.
- **Why:** The channel is deliberately persistent and pure-idempotent. Each step
  re-emits `skills.loaded` with no carry-over marker (see A2) and no link to the
  origin event. No cumulative active-injection renderer exists.
- **Evidence:** `src/skill-hooks/injection.ts:24-31,42-47`,
  `src/runtime/run/relay-guidance.ts:388-389`,
  `src/runtime/executors/relay.ts:525-533`.

#### A8. A dispatch failure is swallowed whole with no operator signal
- **Severity:** low. **Status:** new.
- **Case:** A report is malformed, a surface extractor throws, or
  `buildRunSkillHookEvent` rejects on an edge case. The whole dispatch block for
  that step throws into an empty catch, and every hook that should have fired for
  that step silently does not. No trace entry, no warning, no digest note. The
  operator cannot tell "no hook matched" from "dispatch crashed."
- **Why:** The graph-runner wraps `dispatchSkillHooks` plus the per-event
  append/inject loop in a single `try { } catch {}` with an empty body and a
  "non-critical; swallow so it cannot break a run" comment. The intent (never
  break a run) is sound, but the failure is fully silent, unlike
  `html_render_failed` which surfaces as an evidence warning.
- **Evidence:** `src/runtime/run/graph-runner.ts:998-1038` (empty catch),
  contrast `src/shared/operator-summary-writer.ts:341-345,447-450`,
  `src/skill-hooks/dispatch.ts:182-186` (inner per-report swallow).
- **Resolution (2026-06-04):** The empty catch now records a
  `run.skill-hook-error` trace entry (best-effort, never breaks the run); the
  operator-summary writer reads it and emits a `skill_hook_dispatch_failed`
  evidence warning, exactly the `html_render_failed` pattern this finding cites.
  Proven by the A8 case in `tests/runner/operator-summary-writer.test.ts`.

### Group B — Injecting a skill is not running a skill

The conceptual ceiling. These bound which skills are even good hook candidates,
and nothing today expresses or enforces that distinction.

#### B1. A multi-step harness skill's body does not make the harness run
- **Severity:** medium. **Status:** new.
- **Case:** An operator maps a hook to a self-driving harness skill
  (deep-research, exhaustive-systems-analysis, audit-and-migrate, dogfood).
  Circuit concatenates that body verbatim into one implementer relay prompt. The
  body assumes it owns its own tool loop, fans out subagents, and writes
  cross-session state files. A single bounded relay call cannot do any of that.
  The relay returns one JSON report against Circuit's response contract. The
  skill did not run; its instructions were pasted into a worker structurally
  unable to obey them.
- **Why:** The injection pipeline is purely textual and treats every skill as
  inert guidance. There is no skill-kind or capability classification anywhere;
  the registry discovers any directory with a `SKILL.md` by name and parses only
  name/description/trigger frontmatter. Measured bodies: audit-and-migrate
  24,579 bytes, deep-research 9,168 bytes, exhaustive-systems-analysis says
  "assign one bounded subsystem per subagent."
- **Evidence:** `src/shared/relay-support.ts:77-90`, `src/shared/skill-loading.ts:73-80`,
  `src/shared/user-skill-registry.ts:27-31,85-98`, `src/runtime/executors/relay.ts:557-596`.

#### B2. Only the `SKILL.md` body is injected; bundled resources are dropped
- **Severity:** low. **Status:** new.
- **Case:** A skill whose `SKILL.md` is a thin index pointing at
  `references/layer1.md` or `scripts/verify.sh` gets injected as that index only.
  The deep content never reliably reaches the worker.
- **Why:** `parseSkillMarkdown` returns only the post-frontmatter body. No code
  resolves sibling `references/`, `scripts/`, or `examples/` directories. Most
  installed skills are progressive-disclosure indexes (formal-verify, tdd,
  next-best-practices, skill-creator). Nuance: the prompt does render the
  absolute `Source:` path, and relay workers share the filesystem with read
  access, so a worker *can* read siblings itself. The residual gap is
  reliability: nothing instructs the worker to resolve relative references
  against `Source`, so deep-content delivery is opportunistic, and the recorded
  `skills.loaded` counts the skill as fully loaded when only its index was
  inlined.
- **Evidence:** `src/shared/user-skill-registry.ts:63-70`,
  `src/shared/skill-loading.ts:8-10,72-80`, `src/shared/relay-support.ts:75-91`.

#### B3. An injected skill receives no arguments or target context
- **Severity:** medium. **Status:** new.
- **Case:** An operator wires `after:edit-files:.tsx -> review-this-diff`, a
  skill whose job is to review a specific changed file. The body is spliced into
  the implementer prompt verbatim with no pointer to which files were touched, no
  diff, no slice id. The skill has nothing concrete to act on.
- **Why:** The channel carries only `SkillId` strings. `SkillHookSkillRef` is
  `{id, state, source, reason?}` with no argument or target field. The detected
  surface (the actual touched paths in `fix.change-set` `observed`, or the
  anticipated extensions) is computed by the dispatcher and then discarded after
  matching; it is never passed to the skill. The whole point of an edit-files
  hook (here is what changed) is exactly the context injection drops.
- **Evidence:** `src/skill-hooks/injection.ts:43-46`,
  `src/shared/skill-loading.ts:8-10,73-80`, `src/schemas/skill-hook.ts:243-260`,
  `src/skill-hooks/surface-sources.ts:24`.

#### B4. `after:edit-files` injection arrives after the edit it reacts to
- **Severity:** low. **Status:** new.
- **Case:** Even on Fix where `after:edit-files` fires, the operator's mental
  model is "review my just-finished edit with this skill." But injection only
  adds the skill to the channel that *subsequent* implementer relays read. The
  implementer that made the edit has already returned. So the skill influences
  nothing about the work that triggered it, at best a recovery retry.
- **Why:** The channel is mutated only at the post-step seam, after the relay
  executor returned. `planRelayGuidanceDecision` reads it only for the next
  implementer step, and injection is role-gated to implementer. On Fix the act
  step already completed and there is no later implementer unless verification
  fails. "Run as independent verifier" was the one actuation that would deliver a
  post-edit review pass, and it was not built.
- **Evidence:** `src/skill-hooks/injection.ts:29-31`,
  `src/runtime/run/graph-runner.ts:992-1034`,
  `src/runtime/run/relay-guidance.ts:388-389`,
  `docs/ideas/skill-hooks-alternatives-v1.md:99` (A5 independent-verifier, not shipped).

#### B5. A skill's own `allowed-tools` restriction is parsed then discarded
- **Severity:** low. **Status:** new.
- **Case:** A skill declares `allowed-tools: [Read, Grep]` expecting that
  contract to be honored when it runs. Circuit injects the body into a
  write-capable implementer relay with no enforcement. A read-only analysis skill
  can be injected into a write-capable relay.
- **Why:** `UserSkillFrontmatter` picks only name/description/trigger and
  passthroughs the rest into the void. `UserSkillEntry` has no allowed-tools,
  model, or license field. A grep for `allowed-tools` across `src/` returns zero
  hits; the field is never read or enforced. The Claude connector runs
  `--permission-mode bypassPermissions`. Role-gating to implementer is the only
  boundary, and it is coarser than what a skill author asked for.
- **Evidence:** `src/shared/user-skill-registry.ts:27-31,63-68`,
  `src/schemas/skill.ts:55-67`, `src/connectors/claude-code.ts:73-74`.

### Group C — Reach: which skills, flows, and moments can participate

#### C1. The registry is blind to plugin, marketplace, and project-local skills
- **Severity:** medium. **Status:** new.
- **Case:** A skill installed via a plugin or marketplace (where most namespaced
  skills live) can never resolve. The operator lists a skill they see in their
  session, the hook fires, and resolution throws "Circuit could not find skill"
  for a skill that demonstrably exists on disk. Under a strict policy this
  escalates to a `strict-skill-unavailable` decision and halts the flow over a
  skill that exists.
- **Why:** `createUserSkillRegistry` globs only `~/.agents/skills` and
  `~/.claude/skills`, takes the immediate subdirectory name as the id, and
  requires a sibling `SKILL.md`. The graph-runner constructs it with no roots
  override; there is no `skills.roots` config knob. Plugin skills live under
  `~/.claude/plugins/cache/.../skills/.../SKILL.md`, which is neither root. The
  schema's `host-observed` source and `observed`/`unplanned` states that could in
  principle surface a host-known skill are schema-only, never produced.
- **Evidence:** `src/shared/user-skill-registry.ts:33-35,79-99,153-164`,
  `src/runtime/run/graph-runner.ts:588`. Live subset note: flat-named plugin
  skills (skill-creator, vercel-firewall) pass the slug regex but still cannot
  resolve; `plugin:skill`-form ids are rejected even earlier at config-parse.
- **Resolution (2026-06-04):** Kept the flat-home-dir-only boundary; did **not**
  widen discovery this slice. Widening would require relaxing the flat `SkillId`
  to admit namespaced ids and walking host-specific plugin caches — a large,
  hard-to-revert change to the trust model. Instead: (a) the boundary is
  documented in `docs/configuration.md` (Local Skills) — Circuit discovers only
  flat `<root>/<id>/SKILL.md`, plugin/marketplace/namespaced skills are not
  discoverable; (b) a policy naming an unresolvable skill now produces a surfaced
  signal — the operator summary discloses it under
  `skill_hook_activations[].unavailable_skills` (see A3). Boundary locked by two
  new tests in `tests/runner/user-skill-registry.test.ts` (nested and namespaced
  directories are not discovered).

#### C2. Codex's own home (`~/.codex/skills`) is never searched
- **Severity:** low. **Status:** new (documented intended limitation with a
  built-in workaround).
- **Case:** An operator running Circuit under Codex keeps skills where Codex
  would put them (under `CODEX_HOME` / `~/.codex`). Circuit's registry never
  looks there, so none are discoverable on Codex. The same operator's
  `~/.claude/skills` *are* found even on Codex, the inverse of what you would
  expect.
- **Why:** `defaultUserSkillRoots` is a fixed two-element list with no host
  parameter. `hostKind` threads into connector resolution but never into registry
  root selection. The shipped Codex bundle carries the identical two roots.
- **Evidence:** `src/shared/user-skill-registry.ts:33-35`,
  `src/runtime/run/graph-runner.ts:588`, `src/shared/skill-loading.ts:54`,
  `plugins/codex/runtime/circuit.js:44782-44783`. Documented answer: contract
  SKILL-I8 (`docs/contracts/skill.md:148-154`) makes `~/.agents/skills` the
  host-neutral primary, so "put skills there" works on both hosts.
- **Resolution (2026-06-04):** Documented, no code change. `docs/configuration.md`
  (Local Skills) now states `~/.agents/skills` is host-neutral and searched under
  both Claude Code and Codex, so an operator running under Codex keeps shared
  skills there. This is the documented intended limitation, consistent with
  SKILL-I8.

#### C3. Seven of eleven hooks can never fire (the `before:*` lifecycle family)
- **Severity:** low. **Status:** named deferral.
- **Case:** `before:high-impact-alignment`, `before:architecture-analysis`,
  `before:plan-implementation`, `before:implementation`, `before:verification`,
  `before:close-run`, and `before:handoff` validate in a policy but no real
  moment can trigger them. These are the high-value "about to plan / implement /
  close / hand off" injection points the feature is pitched on.
- **Why:** `hookForEntry` maps only two trace signals; the edit-file dispatcher
  handles only the edit-files pair. Nothing maps the `stage-transition:*`,
  `command:*`, `run-envelope:*`, `goal-contract:*`, or `operator-flag:*` tokens
  these hooks declare. The spec marks the lifecycle family out of scope until a
  stage-transition producer exists.
- **Evidence:** `src/skill-hooks/dispatch.ts:55-72`, `src/schemas/skill-hook.ts:5-79`,
  `docs/ideas/skill-hooks-dispatch-spec.md:57,281-282,301-302`.

#### C4. Fanout-branch work fires no hooks, in either direction
- **Severity:** low. **Status:** new (the injection direction is documented; the
  detection blindness is not).
- **Case:** Prototype and Explore run their implementer work inside fanout
  branches. A branch can fail verification, leave an evidence gap, or write a
  change-set, but none of it fires a hook, because dispatch is called only from
  the top-level step loop. Prototype routes its *primary* implementer work
  through this fanout, so for Prototype skill hooks are inert on that work.
- **Why:** `dispatchSkillHooks` is called from exactly one site, after a
  top-level `step.completed`, scanning that step's trace slice. A fanout step's
  slice contains only `fanout.*` entries, a `fanout-aggregate@v1` report, and a
  `fanout_aggregate` check, none of which the dispatcher's detectors match.
  Branch-level checks, gaps, and change-sets are written to branch-local files,
  never appended to the parent trace. (The injection direction onto production
  branches *is* handled and documented; only the detection blindness is the gap.)
- **Evidence:** `src/runtime/run/graph-runner.ts:999-1014`,
  `src/runtime/fanout/branch-execution.ts:248-417`,
  `src/runtime/executors/fanout.ts:314-321`, `src/flows/prototype/schematic.json:197-225`.

#### C5. Deletes, renames, generated output, and extensionless files are invisible; non-Build/Fix flows have no surface
- **Severity:** low. **Status:** partly named deferral (flow coverage), partly
  new (operation-kind and extensionless-file blindness).
- **Case:** The v1 predicate is an extension suffix matched with `endsWith`. A
  delete of a `.tsx` file and an edit of one are indistinguishable; a rename reads
  as two unrelated edits; a generated-output write looks like a hand edit.
  Extensionless files (Dockerfile, Makefile, LICENSE, .gitignore) cannot be
  targeted. Pursue and Prototype have implementer relays that write code but
  declare no entry in the surface table, so no edit-files hook can ever fire on
  them; goal, review, and runtime-proof likewise.
- **Why:** `surfaceMatches` is purely lexical over a flat `string[]` of paths or
  extensions with no operation kind. `EDIT_FILE_SURFACE_SOURCES` has only two
  keys, `fix.change-set@v1` and `build.plan@v1`. A report schema absent from the
  table is skipped. The flow-coverage half is a named deferral (the relay
  self-report arm); the operation-kind and extensionless-file blindness are
  written down nowhere.
- **Evidence:** `src/skill-hooks/dispatch.ts:132,149-152,178-179`,
  `src/skill-hooks/surface-sources.ts:17-25,54-73`, `src/schemas/skill-hook.ts:98`,
  `src/flows/pursue/schematic.json:155-156`, `src/flows/prototype/schematic.json:139-140,224-225`.
- **Resolution (2026-06-04):** Boundary documented; no behavior change this slice.
  `docs/configuration.md` now shows a "Hooks that fire today" table (edit-files
  fires on Fix `after` / Build `before`; verification hooks on Build/Fix) so the
  reachable flow/timing surface is explicit. The operation-kind blindness
  (delete vs edit, rename, generated output) and extensionless-file targeting
  stay an accepted v1 limitation: the predicate is a lexical extension suffix by
  design. The flow-coverage half (relay self-report arm for Pursue/Prototype/
  goal/review/runtime-proof) remains a named deferral.

#### C6. `after:edit-files` is structurally blind to Build recovery-retry edits
- **Severity:** low. **Status:** named deferral (with a recovery-specific framing
  that is not written down).
- **Case:** When a Build act-step retry edits files in response to a verification
  failure, no `after:edit-files` signal exists for those actual touched files.
  Build's only edit-files surface is the plan's predicted extensions (before
  timing). A skill keyed to react to what the implementer actually just touched
  never fires on Build, the one flow that has both a slice loop and recovery.
- **Why:** Build's actual touched-files self-report (`build.implementation@v1`
  `changed_files`) is a relay report emitting `relay.completed`/`relay.result`,
  not a `step.report_written`, so the dispatcher never sees it. This is deferred
  arm #1 in the dispatch spec, but the spec frames it as "additive recall," never
  as "the after arm is blind to recovery edits on the one flow with recovery."
- **Evidence:** `src/skill-hooks/surface-sources.ts:54-73`,
  `src/skill-hooks/dispatch.ts:176-189`,
  `docs/ideas/skill-hooks-dispatch-spec.md:131-142`.

### Group D — Firing and injection correctness

#### D1. Cardinality is a label, enforced nowhere
- **Severity:** medium (audit-record impact), low (behavioral impact).
  **Status:** new. (Surfaced from two facets: detection-firing and
  circuit-mechanism-interplay.)
- **Case:** The vocabulary promises per-step "fires at most once per step,"
  per-stage "at most once per stage," per-run "at most once across the whole
  Run." Nothing dedups by cardinality. Under recovery (default `max_attempts` 2)
  a re-failing retry re-fires `after:verification-failed` and records a second
  event. Under Build's slice loop, act/verify re-enter per slice and the hook
  re-fires per slice. A `per-run` hook, once one ships with a producer, would
  fire on every step that produced its signal.
- **Why:** There is no fired-hook tracker. `cardinality` is only read to copy
  onto the event and validate the enum. The `event_id` is keyed on
  `entry.sequence`, which is run-global monotonic, so every retry and slice gets a
  fresh id and a new recorded event. Per-stage cannot be enforced anyway because
  the dispatcher is never told the stage (the live caller omits `stageId`, so
  every event has `stage_id` absent). Blast radius is the trace and audit
  record; the injection channel dedups by skill id, so behavior is not corrupted.
- **Evidence:** `src/skill-hooks/dispatch.ts:83-104,191-213`,
  `src/runtime/run/graph-runner.ts:1004-1009,1015-1035,821-828`,
  `src/schemas/skill-hook.ts:82-83,268`,
  `docs/specs/skill-hook-vocabulary-v1.md:104-114,219-220`. An existing test even
  proves the multi-fire: `tests/runner/skill-hook-dispatch.test.ts:481-494` shows
  one report producing three events in one step.

#### D2. `before:edit-files` injects on a prediction that is never reconciled against actual edits
- **Severity:** low. **Status:** new (the persistent-channel over-injection is
  accepted; reconciliation as a guard on this actuator is not).
- **Case:** Build's `before:edit-files` fires off the plan's
  `anticipated_file_extensions` and injects the configured skill into every later
  implementer relay for the rest of the run. If the plan predicts `.tsx` but
  implementation only touches `.py`, the skill is injected for files never
  touched (false positive, paid for the whole run). If the plan omits an
  extension the worker actually edits, no skill is injected (false negative). The
  worker is even told the prediction is advisory and may be exceeded.
- **Why:** Nothing compares the prediction to `build.implementation@v1`
  `changed_files`. The only planned-vs-actual check in the codebase lives inside
  Fix's change-set and is not connected to skill-hook injection.
- **Evidence:** `src/skill-hooks/surface-sources.ts:39-50,69-72`,
  `src/runtime/run/graph-runner.ts:1028-1034`,
  `src/runtime/run/relay-guidance.ts:388-389`, `src/flows/build/relay-hints.ts:26`,
  `src/skill-hooks/injection.ts:28`.

#### D3. A skill injected on one slice stays loaded for unrelated later slices
- **Severity:** low. **Status:** partly named deferral (cross-step persistence),
  partly new (the slice-scope-mismatch case).
- **Case:** In a multi-slice Build, an edit-files skill injected for a UI slice
  stays loaded for a later slice that only touches `.sql` or `.md`. The hook's
  own cardinality is per-step, but the actuation is run-scoped, so the per-step
  intent is silently widened to whole-run.
- **Why:** The channel is created once per run, never reset per slice, and never
  drains. The role gate stops cross-role leakage only, not cross-slice same-role.
  Correction to the obvious framing: on Build the firing is not actually
  per-slice. `build.plan@v1` is written once at plan time before the slice loop,
  and its extractor unions plan-level and all slices' anticipated extensions, so a
  single plan-time fire on a union surface matches every configured edit-files
  key and injects into all slices. Real-world impact is low: the leaked item is
  an advisory skill body (extra context, not wrong behavior), and Build's relay
  hints already tell the worker to implement only the current slice.
- **Evidence:** `src/skill-hooks/injection.ts:21-34,55-58`,
  `src/runtime/run/graph-runner.ts:584,1033`,
  `src/skill-hooks/surface-sources.ts:39-49,69-72`,
  `docs/ideas/skill-hooks-dispatch-spec.md:215-222,230-231`.

#### D4. The `after:verification-failed` feedback loop has no stop of its own
- **Severity:** low. **Status:** new.
- **Case:** `after:verification-failed` injects a skill into the recovery retry.
  That retry's output feeds the same verification check that triggered the hook.
  If the injected skill makes verification still fail, the hook re-fires on the
  second failure too, and because the channel never drains, a skill that is
  actively making things worse stays loaded for the rest of the run. There is no
  hook-level circuit breaker and no way to un-inject.
- **Why:** The only stop is the generic recovery budget (`max_attempts` default
  2). The channel is add-only with no removal API. The design accepts
  over-injection across steps but never considered that the injected skill
  participates in the very signal that triggered it.
- **Evidence:** `src/skill-hooks/dispatch.ts:55-62`,
  `src/runtime/run/graph-runner.ts:357-359,735-754`,
  `src/skill-hooks/injection.ts:24-29,40-60`.

#### D5. Injection is a hidden run input that breaks the (manifest, goal) replay model
- **Severity:** low. **Status:** new. (Contains a sharper, live sub-bug below.)
- **Case:** The set of injected skills for a step depends on which earlier steps
  fired hooks under the operator's config and which skills resolved on disk at
  run start. Replaying the same manifest with a different `skill_hooks` config, a
  different installed-skills set, or a re-ordered failure sequence yields a
  different prompt and different check outcomes, silently, because
  `manifest_hash` is unchanged. The run is no longer a pure function of
  (manifest, goal).
- **Why:** `assertRelayGuidanceMatchesPlan` only checks intra-run consistency, not
  an anchor to the manifest. `manifest_hash` is SHA-256 over flow-manifest bytes
  only and captures nothing about `skill_hooks` config, the installed-skills set,
  or failure timing.
- **Live sub-bug worth a test:** on checkpoint resume the channel is recreated
  **empty** and dispatch only runs for steps that re-execute, so injections that
  influenced earlier steps in the prior process are silently lost. The recorded
  `run.skill-hook` entries are never read back to seed the channel. A resumed run
  can feed a later step a different skill set, and different check outcomes, than
  a single-process run would.
- **Evidence:** `src/runtime/executors/relay.ts:291-339`,
  `src/runtime/run/relay-guidance.ts:388-403`,
  `src/runtime/run/graph-runner.ts:584-588,431-440`, `src/schemas/manifest.ts:64`.
- **Resolution (2026-06-04, live sub-bug fixed):** The graph-runner now re-seeds
  the injection channel from the recorded `run.skill-hook` events on resume
  (`seedSkillHookInjectionsFromTrace`, applied when `isResume`), mirroring the
  live actuator gate (auto + no decision packet + non-empty). A resumed
  implementer step now loads the same injected skills a single-process run would.
  Reproduced by `tests/runner/skill-hook-actuation.test.ts` ("re-seeds an
  injected skill from the trace ...") — the test fails without the seed and
  passes with it. The broader (manifest, goal) replay-purity concern stays a
  recorded deferral: `manifest_hash` still does not cover the `skill_hooks`
  config or installed-skills set, which is a larger replay-model change out of
  this slice's scope.

#### D6. Policy cannot be scoped per flow or per stage
- **Severity:** medium. **Status:** new.
- **Case:** "Inject tdd only on Build" or "load react-doctor only in the Act
  stage" is structurally unrepresentable. A policy rule applies to every flow and
  every stage in which the hook fires.
- **Why:** `SkillHookConfig.policy` is `z.record(SkillHookName, SkillHookPolicyRule)`;
  the key is just the hook name with no flow or stage dimension.
  `resolveSkillHookPolicy` keys the lookup solely on the hook name; `flowId` and
  `stageId` are stamped onto the output event for the trace, never read to filter
  the lookup. The per-circuit override object carries selection, skill_bindings,
  and variant_models, but not `skill_hooks`. The per-step `step.skill_hooks` seam
  is inert (zero readers).
- **Evidence:** `src/schemas/skill-hook.ts:207-213`,
  `src/skill-hooks/policy.ts:69-100,141-142`, `src/schemas/config.ts:171-178`,
  `src/skill-hooks/dispatch.ts:155-163`.

### Group E — Safety controls that are wired but dead

The deny path works (see refuted R10). These are the allow and verify paths.

#### E1. `skills.require_known` is composed but never enforced
- **Severity:** medium. **Status:** new.
- **Case:** A safety-conscious operator sets `skills.require_known: true` in their
  PolicyEnvelope expecting that only known skills may be injected (a natural
  mitigation for the "a repo config can name a skill" concern). The flag passes
  validation and composition but is never consulted at relay-plan time, so an
  unknown or repo-named skill injects exactly as if the flag were unset. The one
  knob that could flip the model from blocklist to allowlist is inert.
- **Why:** `composePolicyHardConstraints` folds `require_known` into the composed
  constraints, but `assertPolicyAllowsRelayPlan` reads only
  `constraints.skills.deny` and never `require_known`. An exhaustive grep across
  `src/`, tests, and both host bundles confirms zero enforcement readers, and
  there is no allowlist field anywhere to check against.
- **Evidence:** `src/policy/policy-envelope.ts:138,167,194`,
  `src/runtime/run/relay-guidance.ts:215-220`, `src/schemas/policy-envelope.ts:113,392`.
- **Resolution (2026-06-04, removed):** Fully removed. `require_known` had no
  allowlist to check against, so "enforcement" would have meant inventing a new
  known-skills allowlist feature — out of scope, and a knob that silently does
  nothing is the betrayal the finding names. Dropped the field from both
  `SkillRules` and `ComposedPolicyHardConstraints` and deleted `composeRequireKnown`
  and its fold in `src/policy/policy-envelope.ts`. The protective control stays
  the working `skills.deny` path (R10). Host bundles and the generated YAML
  config schema were re-emitted so the field is gone everywhere.

#### E2. Skill-body `sha256` is recorded but never pinned or verified
- **Severity:** medium. **Status:** new.
- **Case:** A skill is reviewed once, then its `SKILL.md` is later edited
  (locally, by another tool, or by a compromised dependency writing into
  `~/.claude/skills`). The next run injects the new body. Nothing detects the
  change from what was vetted; there is no expected-sha to pin against. The
  recorded sha is forensic-only.
- **Why:** `loadCandidate` computes and stores `sha256` and the loader copies it
  onto the loaded skill, but the only consumers are trace evidence. No policy or
  schema field can assert an expected sha. The codebase has a
  recompute-and-compare staleness pattern elsewhere (history query), so this is a
  deliberate non-application, not a missing capability.
- **Evidence:** `src/shared/user-skill-registry.ts:120,139-146`,
  `src/shared/skill-loading.ts:77`, `src/schemas/skill-hook.ts:150-213`.

#### E3. No version or content pin across a team
- **Severity:** low. **Status:** new. (Related to E2.)
- **Case:** A team policy says `react-doctor`. Member A has v1, Member B has a
  customized fork at the same directory name. Both runs report "react-doctor
  injected" and look identical in the trace's id field, but the workers received
  materially different instructions. No one can tell the two runs were not
  equivalent.
- **Why:** Policy references a bare `SkillId` slug with no version, expected sha,
  or source pin. Resolution is first-root-wins by directory name. The
  `triggered_skills` surface an operator reads carries only id/state/source/reason,
  not sha. There is no team-shareable lockfile binding id to content.
- **Evidence:** `src/schemas/skill-hook.ts:150-156,243-260`,
  `src/shared/user-skill-registry.ts:79-101,120-121`.

#### E4. `detection.disabled_patterns` is accepted by the schema and read by nothing
- **Severity:** low. **Status:** new (the doc-accuracy half), with a working
  alternative (per-hook `mode: mute`).
- **Case:** An operator sets `skill_hooks.detection.disabled_patterns` to mute a
  hook on certain patterns. The config parses successfully and has zero effect at
  runtime.
- **Why:** The field is validated and threaded through Config, but a repo-wide
  grep shows it is referenced only in the schema and config definitions; neither
  the dispatcher nor the policy layer ever reads it. The dispatcher's only opt-out
  is `policy.mode === 'none'` or a `mute` rule under `policy`. A working per-hook
  mute already exists as a one-line `mode: mute` rule, so the residue is a
  doc-accuracy nit, not a missing capability.
- **Evidence:** `src/schemas/skill-hook.ts:200-205`, `src/schemas/config.ts:217`,
  `src/skill-hooks/policy.ts:81-89`.

### Group F — Host parity

#### F1. Injected skills double-trigger on Claude but single-trigger on Codex
- **Severity:** low. **Status:** new.
- **Case:** The same `SKILL.md`, fired by the same hook, behaves differently per
  host. On Claude the skill's frontmatter `description` is also a live native
  trigger in the interactive orchestrator session, so a skill can be invoked twice
  (once natively, once via Circuit's injection into the relay worker). On Codex
  there is only Circuit's channel. For a side-effecting skill this is a real
  behavioral divergence, not just labeling.
- **Why:** Circuit cannot suppress the Claude host's native description-based
  triggering in the orchestrator session, which sits outside the connector
  subprocess. The relay subprocess itself is sealed on both hosts. Nothing in the
  skill-hooks code models or normalizes this host difference.
- **Evidence:** `docs/ideas/skill-hooks-alternatives-v1.md:280-285`,
  `src/connectors/claude-code.ts:49,52,71-85`, `src/connectors/codex.ts:31-32,107-108`,
  `docs/ideas/skill-hooks-first-principles.md:938-949`.

#### F2. No host-package extension point for skill-hook behavior (a third host inherits nothing)
- **Severity:** low. **Status:** new (forward-looking).
- **Case:** Compiled flow `circuit.json` files contain zero skill references on
  either host; skill hooks, slots, and bindings are evaluated purely at runtime
  from Config. So claude-vs-codex parity is satisfied trivially, for the wrong
  reason: there is no per-host skill surface at all. The corollary: a future third
  host (the contemplated OpenCode host) inherits injection only if it routes
  relays through one of the existing subprocess connectors. There is no
  host-package extension point that encodes skill-hook behavior, and the OpenCode
  idea doc discusses connector wiring at length but never mentions skill hooks.
- **Why:** The dispatcher is a config-gated engine capability with no flow-name
  branching; the surface table is keyed by report-schema id, all host-blind.
  `hostKind` flows only into connector resolution and never touches the injection
  decision.
- **Evidence:** `docs/ideas/skill-hooks-dispatch-spec.md:44-45`,
  `src/skill-hooks/surface-sources.ts:54-73`,
  `src/runtime/run/relay-guidance.ts:388-389`,
  `plugins/claude/runtime/circuit.js:27261-27262,37515`, `docs/ideas/opencode-as-host.md:29-30,158-177`.

---

## What is already handled (refuted candidates)

These were proposed and then knocked down. They are recorded so nobody
re-investigates them. Each is either already enforced in code, an honest design
intent, or a named deferral.

- **R1. "The `SkillId` slug regex is what locks out plugin skills."** Refuted.
  The regex does reject `vercel:deploy` and friends, but relaxing it would not
  help: resolution goes through a registry that only discovers flat-named
  `SKILL.md` directories in two home roots, and `resolve('vercel:deploy')` would
  throw regardless. The discovery scope is the real boundary (see C1), not the
  regex.
- **R2. "A review-checklist skill can never reach a reviewer."** Refuted as a
  gap. The role gate is a deliberate, tested trust boundary, and the legitimate
  need is served by step- or stage-scoped `selection.skills`, which is
  role-agnostic. Conditional injection into a reviewer gated on a hook is the only
  truly absent capability, and no doc expresses intent for it.
  (`src/shared/skill-loading.ts:83-85`, `src/schemas/selection-policy.ts:97-105`.)
- **R3. "`skills.loaded` reads as 'the skill ran'."** Refuted. The `planned` vs
  `observed` state split is exactly that distinction; injection stamps `planned`,
  never `observed`, and the schema forbids `observed` without `host-observed`
  source. The field is contractually "loaded," not "executed."
  (`src/skill-hooks/policy.ts:113-117`, `src/schemas/skill-hook.ts:215-258`.)
- **R4. "A large injected body makes Codex drop its output schema differently
  from Claude."** Refuted. The `--output-schema` decision is computed from the
  step's report schema, independent of injection; both implementer report schemas
  are already Codex-incompatible with or without a skill; and the Claude connector
  has the same structured-output subset restriction. (`src/runtime/executors/relay.ts:546-552`,
  `src/connectors/codex.ts:432`, `src/connectors/claude-code.ts:159-180`.)
- **R5. "The host-blind surface table is a latent parity trap."** Refuted. A flow
  emitting different report schemas per host is structurally unreachable: one
  schematic per flow, a host-blind compiler, byte-identical bundles mirrored to
  both host trees, and a drift gate (`emit.ts --check`) in `verify`. Report schema
  is host-invariant by construction.
- **R6. "No default skill mappings ship, so out of the box nothing fires."**
  Refuted as a gap. This is the deliberate operator-opt-in (copilot-not-autopilot)
  posture, documented in the vocabulary spec. The unproduced `default-mapping`
  enum is reserved forward-compat for the deferred skill-metadata subscription
  path. (The discoverability consequence is real and captured as A5/zero-config.)
- **R7. "A hook-name typo silently never matches."** Refuted. The policy record
  is keyed by `SkillHookName`, so a malformed key fails the whole config parse at
  load time with a path-attributed error, before any flow runs. Probed live:
  `after:edit-files:tsx` (missing dot) and `after:edit-file:.tsx` (singular) both
  fail `Config.safeParse`. (`src/shared/config-loader.ts:54-62,92-102`,
  `tests/contracts/skill-hook-policy-schema.test.ts:323-334`.)
- **R8. The strict-skill-unavailable decision packet is built nowhere.** Refuted
  as a gap; it is a named deferral. The behavior (inject nothing while a strict
  decision is pending, record the event, proceed) is the documented conservative
  reading of strict mode, with interactive resolution called out as a later
  slice. (`docs/ideas/skill-hooks-dispatch-spec.md:204-214,232-238,300-303`.)
  One real residual: the inline comment at `graph-runner.ts:1023` claims "the hook
  awaits an operator choice," which is false; that comment should be corrected.
- **R9. "Injection is dropped on the injected-connector fanout path."** Refuted.
  That path is a test-only compatibility arm; production fanout always takes the
  injecting arm. Every `relayConnector` assignment in the repo is under `tests/`.
  And the edit-file surfaces belong to Build/Fix, which have no fanout step.
- **R10. "Injection is deny-list-only and usually unbounded; a repo config can
  inject arbitrary skill content."** Refuted as framed. The PolicyEnvelope
  `skills.deny` list **is** enforced against injected skills (the run aborts at
  planning before the skill reaches the prompt), and the deny-list and the
  selection config can live in separate coexisting config layers, so the
  operator's protective deny wins over a repo's auto rule. Two passing tests
  exercise exactly this. The trust model is trusted-operator-local: skill ids come
  only from operator config, bodies only from operator dirs, with no path from
  goal text or a model decision. (`src/runtime/run/relay-guidance.ts:388-410,216-220`,
  `tests/runner/skill-hook-actuation.test.ts:347-379`,
  `tests/runner/config-loader.test.ts:520-562`.) The one real residual from this
  facet is E1 (`require_known` dead).
- **R11-R15.** Several restatements of R8 from other facets (strict packet unbuilt
  and unsurfaced), plus the `disabled_patterns` doc-accuracy nit (captured as E4).
  All resolve to "named deferral" or "documented intent with a working
  alternative."

---

## Recommended sequencing

The findings argue for a specific order, independent of the deferred arms already
on the roadmap.

1. **Reconcile the docs (A4).** Both documented examples are duds. Lowest cost,
   prevents every new user's first experience being silent failure. Also fold in
   the stale `moments:` key and the still-present `ask` mode in the vocab spec.
2. **A small observability slice (A1, A2).** Surface fired hooks and injection
   provenance in the operator summary, in-pattern with the existing
   `Worker access:` line. Highest-leverage net-new work, and it is the thing that
   makes every other gap noticeable instead of silent.
3. **Decide the reach story (C1).** Either widen the registry to discover plugin
   skills, or document loudly that hooks target flat home-dir skills only. Right
   now the mismatch between "skills I see in my session" and "skills a hook can
   load" is the most confusing part of the model.
4. **Fix the two dead safety knobs (E1, E2)** or remove them, so a careful
   operator is not silently betrayed.
5. **The deferred edit-files arms and lifecycle family (C3, C6)** stay lower value
   until the feature is visible enough that anyone notices them firing.

Correctness items D1, D4, D5 are real but low blast radius today; D5's
checkpoint-resume sub-bug deserves a failing test even if the broader replay
concern is deferred.
