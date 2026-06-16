# Equipment scope — enforcement-mechanism decision + status

> Written 2026-06-15. Closes the build brief in
> [`equipment-scope-build-brief.md`](equipment-scope-build-brief.md) against the
> design in [`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md). Branch
> `feat/equipment-scope` (held PR — not merged).

## What shipped

The equipment-scope **mechanism** for the tools sub-axis: a step declares which
tools its worker gets, the engine provides that list as guidance, and at the
write tier — on a connector that can restrict tools — it enforces it. The
skills sub-axis already had its seat (`skill_slots`); this fills the tools seat.

Built as two increments, then an adversarial-review hardening pass:

1. **Declared + trusted.** `EquipmentScope` is a manifest field on the schematic
   step (`equipmentScope`), compiled to `equipment_scope` on the runtime step,
   read off the step by the engine — never from a catalog keyed by flow id, never
   an engine branch. The default (`tools: 'full', enforcement: 'trusted'`) is
   omitted from compiled output, so flows that declare nothing stay byte-stable.
   The relay prompt renders the declared tools as a guidance section.

2. **Enforced at the write tier.** `enforcement: 'enforced'` makes the scope a
   real boundary. The `fix` flow's implementer step (`fix-act`) is the proven
   slice: scoped enforced to `[Read, Grep, Glob, Edit, Write, Bash]`.

3. **Review hardening.** Three review lenses (architecture, security, tests).
   Architecture clean; security empirically re-verified (no crit/high). Findings
   closed: a fail-closed fix to the parse-time honesty guard, an integration
   test across the dispatch seam, a content assertion on the proven slice, and
   two coverage gaps. Details under "Review findings closed" below.

## The enforcement-mechanism decision

**The fork the brief flagged — *how* to restrict a worker to "only these tools"
at the write tier — has an obviously-correct answer, so no stop-and-report was
needed.**

The lever is the Claude Code CLI's `--tools` flag. It restricts which tools
*exist* in a spawned session, and it holds under `--permission-mode
bypassPermissions` (the mode the connector already dispatches in). This was
proven by probe and re-verified empirically by a review agent running the real
`claude` CLI (v2.1.177): a worker spawned without `Write`/`Bash` could not create
a file.

Why this and not an alternative:

- **`--tools` vs. permission prompts.** Permission prompts are a human-in-the-loop
  affordance; the relay runs headless. `--tools` removes the tool from the
  session entirely, which is the boundary we want — there is nothing to prompt
  for.
- **`--tools` vs. an MCP/allow-list wrapper.** The connector already closes the
  MCP and slash-command surfaces at the flag layer (`--strict-mcp-config`,
  `--disable-slash-commands`) and re-asserts them at parse time. `--tools` is the
  same shape of lever for the tool surface, so it composes with the existing
  dispatch model instead of introducing a new one.

Two mechanics the implementation had to respect, both encoded as tests:

- **`--tools` is variadic** and greedily consumes following argv elements, so it
  must lead the argv and be terminated by the next flag (`-p`), never sit adjacent
  to the trailing prompt. (`connector-schema-piping.test.ts`)
- **The flag is trusted but verified.** Parsing the session's `init.tools` against
  the requested allow-list is a parse-time safety net: a flag regression that
  silently widened the surface fails the relay instead of letting an over-equipped
  worker reach flow state. The guard now **fails closed** — a non-string tool
  entry counts as a leak rather than being narrowed away.
  (`parse-claude-code-stdout.test.ts`)

### Enforced-vs-trusted is explicit, declared, and honest

Enforcement is not assumed from the presence of a tool list — it is a declared
property (`enforcement: 'trusted' | 'enforced'`) resolved against the connector's
capability:

- A new connector capability, `tool_scope: 'none' | 'allow-list'`, says whether a
  connector *can* restrict tools. `claude-code` is `allow-list`; `codex` and
  `cursor-agent` are `none`; custom connectors are forbidden from claiming
  `allow-list` in V1.
- A pure, total resolver (`resolveEquipmentEnforcement`) maps declared scope +
  capability to the effective enforcement. Enforced on a capable connector →
  enforced, with the tool list. Enforced on an incapable connector →
  **downgraded** to trusted, with a finding; it is never displayed as enforced.
- The decision is recorded on `relay.started` as `equipment` evidence
  (`declared`, `effective`, `downgraded`, `enforced_tools`). A union-level schema
  rule keeps the trace honest: `effective: 'enforced'` iff `enforced_tools` is
  present; a trusted scope never carries a tool list; a downgrade is exactly
  declared-enforced resolving to effective-trusted; effective enforcement is only
  reachable from a declared-enforced scope.

This means the substrate cannot lie about a boundary it did not actually impose —
the central honesty property the design called for.

## The ratchet (offline proof)

`tests/contracts/equipment-scope-ratchet.test.ts` is a dependency-free gate over
the shipped corpus, scoring both sub-axes as monotonically-shrinking ceilings:

- **Skill-slot gaps** (relay steps with no `skill_slots`): ceiling **15**, down
  from the 19 the brief baselined — the `fix` flow's four relay steps now declare
  their seats.
- **Tool-scope gaps** (implementer relay steps with no `equipment_scope`): ceiling
  **5** — every shipped implementer step except `fix-act` is still unscoped.
- The `fix` flow is pinned fully scoped (0 of each), and its implementer step is
  pinned to `enforcement: 'enforced'` with its exact tool list, so a future edit
  that quietly weakened it fails before the summed ceilings would.

This is the cheap cousin of the offline flow-lab quality ratchet on
`exp/next-phase-flow-lab` (PR #88). When those branches converge, fold this gate
into that one rather than maintaining both.

## Review findings closed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Honesty guard narrowed non-string `init.tools` entries away before the membership check, so a non-string tool could pass silently | Fail closed — an unverifiable entry counts as a leak and is rendered in the violation message; failing test first |
| HIGH | No integration test drove the dispatch seam (decision → trace) | Runner-level tests through `executeProductionRelayAttempt`: enforced/capable records `enforced_tools`; enforced/incapable downgrades; declared-trusted reports not-enforced |
| MEDIUM | Ratchet proved `fix-act`'s scope only by gap count | Pin the implementer step to `enforcement: 'enforced'` and its exact tool list |
| LOW | Declared/effective consistency rule and single-tool argv path had no isolating test | Added both |

## Scope fence held

The auto-detection chooser ("which skills/tools for which work") stayed **out** —
that is the later resolver. This PR built the mechanism only: declare, provide,
enforce, and report honestly.

## What's left

- **Scope the other five implementer steps.** `build`, `explore`, `prototype`,
  `pursue`, and `runtime-proof` each have one unscoped implementer relay (the
  tool-scope ceiling of 5). Filling them drives the ratchet to 0 and is the
  natural next slice — but it is per-flow authoring judgment about the right tool
  set, not mechanism work.
- **Real-codebase enforcement test.** Enforcement is proven by probe + the parse
  guard + integration tests against the stubbed seam. A live end-to-end run that
  spawns a real restricted worker and confirms it cannot touch a denied tool
  would close the last gap between "the lever works" and "the flow uses the lever
  correctly end to end."
- **Codex / cursor-agent enforcement.** Both are `tool_scope: 'none'` today, so an
  enforced scope downgrades against them. If either grows a tool-restriction
  lever, wiring it is a capability flip plus a connector argv change — the
  resolver and trace already model the downgrade, so nothing above the connector
  changes.
- **The skills sub-axis enforcement.** `skill_slots` is declared and provided but
  not *enforced* the way tools now are. Whether skills even have an enforcement
  tier (vs. being inherently guidance) is an open design question, not a built gap.
- **Converge the ratchets.** Fold this gate into the offline flow-lab quality
  ratchet when PR #88 lands.
