# Pre-release punch list

Status: active. Started 2026-07-10. Operator-reported issues to resolve
before the first public release. This list carries the raw items as Pete
reports them; the curated launch blockers stay in
[`v1-launch-plan.md`](v1-launch-plan.md). Check items off with the commit
that resolves them. Some items also apply to the docs site and landing
page repo (`~/Code/circuit-land`); those say so inline.

## Items

### 1. Try combining `--tournament` and `--tournament-n`

Reported 2026-07-10. Two separate params may not be necessary.

Today: `--tournament` is a boolean that turns on option fan-out, and
`--tournament-n <2|3|4>` sets the option count. `--tournament-n` without
`--tournament` is an error (`src/cli/run.ts`, the guard near the axis
parsing). The likely combined shape is one flag with an optional count,
for example `--tournament [2|3|4]` with a default when the count is
omitted.

Touchpoints: `src/cli/run.ts` (parsing and the requires-guard),
`src/cli/circuit.ts` (usage strings), `src/cli/run-flag-vocabulary.ts`
(flag vocabulary), checkpoint-resume flag echo (`--depth/--tournament/...`
message), axis schemas under `src/schemas/`, and any generated host
surfaces that document run flags.

- [x] Decide the combined shape and default count
- [x] Implement, migrate usage strings and vocabulary, update tests

### 2. Raise the CLI to equal focus with the plugins

Reported 2026-07-10. Applies to this repo AND the docs site and landing
page (`~/Code/circuit-land`).

Reduce the overall emphasis on Circuit as "a plugin for Claude Code and
Codex" and raise the CLI to the same level of focus. Pete's framing: the
plugins are merely a bridge that teaches an agent to use the CLI. The CLI
is the product core; the plugins are how a host agent learns to drive it.

This is an identity-level framing shift, not a value-pillar change. The
settled messaging ladder in
[`v1-launch-plan.md`](v1-launch-plan.md) (encode-process lead, multi-model
co-pillar, evidence floor) stands; what changes is the product noun.

Known places that say plugin-first today:

- `AGENTS.md` line 5: "a Claude Code and Codex plugin that runs
  configurable developer flows"
- `docs/release/v1-launch-plan.md` "What v1 is": "a Claude Code and Codex
  plugin that runs typed developer flows"
- `README.md` (headline area and install funnel)
- `docs/positioning.md` (the authority for public claims; audit its
  product-identity language)
- circuit-land: landing page copy and the docs site pages that introduce
  Circuit

Honest tension to preserve, not paper over: distribution and the operator
surface (slash commands, skills) ARE the plugins today, and the first-run
funnel installs through plugin marketplaces. The shift is identity and
emphasis (CLI engine first), not a claim that the plugins are optional for
the current first-run path. Related support for the CLI-first frame:
`alternative-to-chat.md` ("the whole engine is one CLI") and
[`../ideas/cloud-routines-and-intake.md`](../ideas/cloud-routines-and-intake.md)
(unattended sessions drive the CLI directly).

- [x] Sweep this repo's identity statements (README, AGENTS.md, launch
      plan, positioning.md) to CLI-first framing
- [ ] Same sweep in circuit-land (landing + docs site)
- [x] Check generated host surfaces and command help text for plugin-first
      phrasing

### 3. Fully revamp the docs-site "How Circuit works" page

Reported 2026-07-10. circuit-land item:
`~/Code/circuit-land/content/docs/concepts/how-it-works.mdx` (109 lines).

Pete's verdict: very unhelpful overall, and it barely touches what makes
Circuit unique beyond a typical workflow engine. Full revamp, not a touch-up.

The current structure confirms it. The sections are Stages and steps,
Every step is a micro-harness, Typed inputs and outputs, Routes, and The
run folder. Except for the micro-harness section, that is a generic
workflow-engine mechanics tour; stages, steps, typed IO, and routes could
describe any pipeline tool.

What the revamp should center (source from `docs/positioning.md`, the
claim registry, and the launch plan's framing ladder; do not invent new
claims):

- The evidence gate: a step cannot advance or close without the evidence
  its checks require, and a worker cannot talk its way past it.
- The honesty machinery: the until-loop ledger that makes "succeeded"
  unreachable without proof, honest downgrades, exit codes that mirror
  the closed outcome.
- One dial, per-role model allocation: frontier models on strategic
  steps, cheap models on execution, visible via `circuit preview`.
- Encode your process: the page should tell the graduation story (chat is
  where a process gets figured out; a flow is where it goes to run), not
  just enumerate engine nouns.
- The run folder as the readable, auditable record someone who was not
  watching can trust.

Interacts with item 2: the rewrite should present the CLI as the engine
and the plugins as the bridge, matching the CLI-first framing sweep.

- [ ] Rewrite the page around the differentiators, with the mechanics tour
      demoted to supporting detail
- [ ] Cross-check every claim against positioning.md before publishing

### 4. "Depth" and "power" are not semantically distinguishable

Reported 2026-07-10. The two dial names need clearer language.

Today: `--depth <low|medium|high>` controls care level (how much process
a run spends), and `--power <auto|low|medium|high>` sets the model tier
(which models the roles get). The words do not carry that split. Both
connote "more quality", both run the same low/medium/high ladder, and a
new user cannot guess which one to turn up. The docs help text
(`src/cli/circuit.ts`, axes line) has to explain both every time, which
is the symptom.

Direction, not a decision: name what each dial actually moves. Depth is
process thoroughness (candidates in the rigor/care/thoroughness family);
power is model strength and spend (candidates in the models/tier/spend
family). Pick names where neither reads as a synonym of the other.
Decide once, then rename without aliases: pre-public-release is the free
window for a breaking rename and the standing bias is no
backwards-compat shims.

Blast radius: `src/schemas/depth.ts` and `src/schemas/power.ts`, the
selection module (`src/selection/power-tiers.ts`, `power-inference.ts`,
`relay-selection.ts`, `selection-resolver.ts`), CLI usage strings and the
flag vocabulary, config keys, `circuit preview` output, generated host
surfaces, at least eight docs-site pages in circuit-land (selection,
config-file, quickstart, cli/run, several concept pages), and the landing
page's dial section. Cross-repo item.

Interacts with item 1: both touch the run-flag surface (usage strings,
vocabulary, tests). Batch the flag migrations into one pass.

- [ ] Choose the two names (operator decision)
- [ ] Rename across engine, CLI, config, preview, and generated surfaces
- [ ] Sweep circuit-land docs and the landing dial section

### 5. Emphasize "Archetype" for model-role assignment

Reported 2026-07-10. Use "archetype" as the product word for assigning a
particular model a particular role: "Opus as your Researcher archetype."

Current standing: archetype is already the internal engine name (the
resolver at `src/flows/resolvers/archetype.ts`, the generate/create path,
flow assembly specs), but it appears nowhere in `UBIQUITOUS_LANGUAGE.md`
and nowhere in the circuit-land docs site. So this is a promotion of
existing internal vocabulary to product vocabulary, not a rename.

Where it should surface:

- `UBIQUITOUS_LANGUAGE.md`: add archetype to the canonical vocabulary
  with a crisp definition (the role-shaped slot in a flow that a model
  fills; the dial decides which model fills which archetype).
- `circuit preview` and selection readouts: the per-step display is the
  natural place to say which archetype each relay runs as.
- positioning.md claim 3 (one dial allocates models by role, per step):
  the archetype word makes this claim tellable in one sentence.
- circuit-land: the selection/configuration docs and the landing dial
  section. The docs currently explain role-aware allocation without a
  noun for the role slot.

Interacts with item 4 (the clearer dial language should be phrased in
archetype terms: the model dial sets which models fill your archetypes)
and item 3 (the how-it-works rewrite should use it). Cross-repo item.

- [ ] Add archetype to UBIQUITOUS_LANGUAGE.md
- [ ] Surface it in preview/selection readouts where roles appear
- [ ] Sweep positioning.md and circuit-land to use it consistently

### 6. Rename the `circuit inbox` command

Reported 2026-07-10. "Inbox" does not sound right in Circuit's context.

What the command is: the surface that discovers and lists runs paused at
checkpoints awaiting an operator decision (`src/cli/inbox.ts`,
`src/app/inbox/discover.ts`, `src/app/inbox/render.ts`).

Naming criterion: name the contents (paused runs waiting on you), and
prefer existing ubiquitous language over a new metaphor. Candidates to
weigh, not a decision: `circuit checkpoints` (most literal, already
canonical vocabulary), `circuit pending`, `circuit waiting`,
`circuit decisions`. "Inbox" reads as email; none of the run contents
are messages.

Blast radius: the command itself and its module names, the command list
and vocabulary (`src/cli/circuit.ts`, `src/cli/command-vocabulary.ts`),
the interactive front door (`src/cli/front-door.ts`), `resume-input.ts`
and `run.ts` references, launch-plan prose ("checkpoints and the inbox"),
generated host surfaces that mention the command, and circuit-land
(`content/docs/cli/inbox.mdx`, the CLI overview, and the nav
`meta.json`). Rename clean, no alias, per the standing no-back-compat
bias. Cross-repo item.

- [ ] Choose the new name (operator decision)
- [ ] Rename command, modules, vocabulary, front door, and prose
- [ ] Rename the circuit-land CLI page and nav entry

### 7. Skills are poorly explained; demonstrate auto-injection

Reported 2026-07-10. Mostly a circuit-land item.

The Skills functionality is poorly explained and documented. The docs
must demonstrate the headline capability: your favorite skills
auto-injected into the appropriate step, triggered by things like file
extension.

Current state: the one docs page
(`~/Code/circuit-land/content/docs/configuration/skills.mdx`, 81 lines)
is a config-key reference (where it lives, bindings, policy, hooks). It
documents the keys without ever showing what the feature does for you.
Skills also only live under configuration/ in the nav; there is no
concepts-level treatment.

The mechanism is real and already shaped for the demo:

- Slot bindings: bind local skills into flow slots (the equipment
  resolver injects house-style skills per step).
- Skill hooks: event plus predicate triggers, including parameterized
  extension matching such as `after:edit-files:.tsx`
  (`src/schemas/skill-hook.ts`; contract at
  `docs/contracts/skill-hooks.md`).

Revamp direction: lead with the capability, not the keys. One worked
example carried through the page: an operator has a favorite skill (say
a SwiftUI review skill), one config block wires it to `.swift` edits,
and it fires inside the implementer step of any flow that touches Swift
files, with the trace showing it triggered. The config reference follows
the story. Link the contract for the exact dispatch rules.

Interacts with item 3: the how-it-works rewrite should mention skill
injection as part of the micro-harness story and link here.

- [ ] Rewrite the skills page capability-first with the worked
      file-extension demo
- [ ] Decide whether skills earn a concepts page alongside the config
      reference
- [ ] Show the trace evidence that an injected skill actually fired

### 8. No good explanation of "block" or "micro-harness"

Reported 2026-07-10. circuit-land item, with vocabulary roots here.

Neither concept has a real explanation in the docs. "Block" gets one
glossary line ("a reusable kind of work that can appear in a schematic")
and no concepts treatment; the block catalog
(`docs/flows/block-catalog.json`, the graded set behind every flow) is
not surfaced to users at all. "Micro-harness" exists only as an 18-line
section inside the how-it-works page that item 3 already marks for a
full revamp, plus a passing mention in that page's description.

Context that raises the stakes: the operator has separately flagged
wanting to introduce and OWN the micro-harness term (it is novel, and it
names the actual differentiator: every step runs as its own small
harness with a role, model, effort, tool allowlist, and a mechanical
check). A term we intend to own needs a canonical, linkable home, not a
subsection.

Direction:

- A concepts-level explanation of blocks: the reusable unit of work a
  flow composes, what a block declares (contracts, checks, role), and
  how the same block appears across flows. Ground it in two or three
  real blocks from the catalog rather than abstract definitions.
- A canonical micro-harness explanation that earns the term: what is in
  the harness (role, model, effort, tools, skills, check), why fresh
  scoped context per step beats one long chat, and what the trace shows
  when a step runs. This is the page other pages link to when they say
  micro-harness.
- Expand the glossary entries to match.

Interacts with item 3 (how-it-works links here instead of carrying the
weight), item 5 (archetype is the role facet of the micro-harness), and
item 7 (skills inject into the micro-harness).

- [ ] Write the block explanation grounded in real catalog blocks
- [ ] Write the canonical micro-harness page
- [ ] Update glossary and cross-links from concepts pages

### 9. Checkpoints docs skip the rich HTML decision artifacts

Reported 2026-07-10. circuit-land item with the capability rooted here.

The checkpoints page
(`~/Code/circuit-land/content/docs/concepts/checkpoints.mdx`, 60 lines)
completely glazes over the fact that a checkpoint can render a rich HTML
artifact to facilitate the human decision. The page never uses the word
HTML; its one "artifact" mention is the keep/save/discard option list.

What actually ships: the operator-summary HTML system
(`src/app/operator-summary/writer.ts`, styled on the vendored
shadcn/Base UI design system) writes a structured, readable page for the
operator at decision time. The docs describe checkpoints as a pause with
options, which undersells the experience of opening a rendered page that
lays out the evidence and choices.

Direction: the page should show, not mention, the artifact. What gets
rendered, at which checkpoints, where it lands in the run folder, and a
real example (screenshot or linked sample page). The strongest demo is a
tournament checkpoint: N variants compared side by side on a rendered
page, operator picks one. That also gives item 1's tournament flags a
place in the docs story.

Interacts with item 3 (this is differentiator material for the
how-it-works rewrite) and item 8 (the run folder as the readable record).

- [ ] Rewrite the checkpoints page around the decision experience,
      including the rendered HTML artifact with a real example
- [ ] Document which checkpoint kinds produce pages and where they land
- [ ] Consider a tournament-checkpoint walkthrough as the flagship demo

### 10. Simple command-line installation experience and instructions

Reported 2026-07-10. The practical leg of item 2: CLI-first framing is
not credible while the only install path is a plugin marketplace.

Current state: install is plugin-marketplace only
(`/plugin install circuit@circuit`), and the README explicitly says you
do not need a `circuit` binary because the plugin is self-contained. The
package cannot be published as-is: `package.json` is `private: true`,
has no `files` allowlist or `publishConfig`, and the npm name `circuit`
is TAKEN by an unrelated package (v1.2.0 on the registry).

DECIDED 2026-07-10: publish to npm as `@petekp/circuit` (name confirmed
free on the registry; the bin stays `circuit`). Scoped packages publish
restricted by default, so the pipeline needs `--access public`.

Remaining decision (operator call):

- What the installed CLI includes relative to the host plugins (the
  plugin runtime bundles are separate build artifacts; the build-order
  gotcha applies: `npm run build` before `build-plugin-runtime`).

Work once decided:

- Packaging: files allowlist, bin wiring, publish pipeline, and a
  seventh version surface added to the release gates
  (`check-release-infra` currently machine-writes and gates six).
- Instructions: README install section rewritten with the CLI path
  first-class next to the plugin path; circuit-land installation page
  and quickstart likewise. Note the codex first-run funnel reads the
  published `--ref` from the README at run time, so install-instruction
  edits are load-bearing for the container-lab gate.
- First-run sanity: `circuit doctor` should be the advertised
  post-install check; the CLI spawns the `claude` binary for worker
  steps, so instructions must state that prerequisite plainly.

Cross-repo item (README here, installation and quickstart pages in
circuit-land).

- [x] Choose channel and package name: npm, `@petekp/circuit` (2026-07-10)
- [ ] Package and gate the publish surface (`--access public`)
- [ ] Rewrite install instructions in README and circuit-land with the
      CLI path first-class (`npm install -g @petekp/circuit`)
