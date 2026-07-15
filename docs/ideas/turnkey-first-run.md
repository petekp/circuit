# Turnkey first run: setup that does the work for the user

Status: `current-proposal`. Design exploration from the 2026-07-13 operator
ruling (smart defaults, "Circuit needs to just work") and its same-night
addendum: consider an agentic setup process automatically kicked off on the
user's first Circuit invocation as the lead candidate, without overindexing
on it. Nothing here is built; the v1 launch freeze applies. Code citations
grounded against `src/` and `plugins/` on 2026-07-13; verify before
building. A 2026-07-14 operator review of the demonstrated journey (final
section) corrects one mechanism and adds rulings; it overrides the body
where they conflict.

This note owns the setup and first-run experience: when configuration
happens, who performs it, and how it is communicated.
[`model-roster-and-intensity.md`](model-roster-and-intensity.md) owns what
gets configured (the roster, the temperament table, casting). The
private friction log (docs/internal, 2026-07-14) supplies the observed
first-run failures this must fix.

## The ruling, restated as requirements

1. A first-time user should be able to say "build a prototype that does
   such and such" and have Circuit configure whatever runs first from the
   models available on their machine, effort levels included.
2. Circuit communicates what it configured and how to adjust it, after the
   fact. It does not ask first.
3. Pre-defined model archetypes ship with the product; the user never
   authors them.
4. An agentic setup process, possibly auto-started on first invocation, is
   the lead candidate mechanism, to be weighed against alternatives.

## What exists today (grounded)

The survey found more substrate than expected, and one hard gap.

- **No first-run detection of any kind.** No marker, no seen-state, no
  per-user state file. The nearest precedent is the Codex install nudge,
  which shows once per repo via a `.codex-install-nudged` marker in the
  project control plane (`src/cli/handoff-codex-hooks.ts:505-515`,
  fired from `src/cli/run.ts:1065-1072`).
- **Connector probes are a reusable library, not welded to doctor.**
  `probeBuiltinConnectors` in `src/connectors/health.ts:202-208` runs
  `<cli> --version` presence checks plus auth probes (codex, cursor-agent),
  pure classification, 10s timeout, well under a second on healthy
  installs. `src/cli/chosen-connectors.ts` resolves the connector set a
  plan would use, reusing the preview seam. Availability-aware behavior is
  cheap to add anywhere.
- **Config writing machinery already has the right shape.** `circuit
  config set` writes through the yaml Document API so comments survive,
  re-validates the whole document against the strict schema before any
  byte lands, and deletes the file when nothing user-set remains: "healthy
  defaults write no config" (`src/cli/config-command.ts:128-136,154-234`).
  The doctor smokes in both plugin wrappers already write a hermetic
  user-global config into a temp HOME, proving the write shape end to end.
- **A bounded one-off agent step outside a run already ships.** `circuit
  generate` wraps `relayClaudeCode` as a `RelayFn` with a pinned cheap
  selection (claude-haiku, low effort), runs a bounded multi-round
  schema-validated loop, and writes results to the custom-flow home with
  no run folder (`src/cli/generate.ts:59-72,189-195`). This is the working
  template for any agentic setup step.
- **The Claude plugin already runs things with zero user action.** Its
  `hooks/hooks.json` auto-loads at install: SessionStart injects a
  continuity brief, Stop/SessionEnd/PreCompact harvest the transcript
  (`plugins/claude/hooks/hooks.json`). The SessionStart hook stays silent
  when it has nothing to say (`plugins/claude/hooks/session-start.ts:167-169`).
  Codex has no auto-loaded hooks; its funnel is the once-per-repo nudge.
- **The communicate surface half-exists.** `circuit config show` renders
  absent layers honestly and marks effective values `source: 'default'`.
  `circuit preview <flow>` gives the spawn-free per-step readout. Neither
  is discoverable from the plugin surface: plugin users are taught exactly
  `{run, resume, handoff}`; doctor, preview, config, create, generate,
  checkpoints, runs are invisible (friction log F3; confirmed by the
  emit-layer `CLI_ONLY_COMMANDS` list in `scripts/flows/emit.ts:150-151`).
- **Bare `circuit` reads zero config by design** ("zero config reads and
  zero failure modes", `src/cli/front-door.ts:4-8`), so any unconfigured
  state detection must not live there.

## The approach space

**A. Static shipped defaults, no setup moment.** The roster note's
direction alone: temperament table plus availability casting, all
deterministic. Fast, free, reliable, fully auditable. Its ceiling: it
cannot answer project-specific questions. The friction log's worst finding
in this class (F2) is exactly such a question: which command proves this
project's work, in a repo that is not npm-shaped.

**B. Agentic setup at first invocation.** Three distinct shapes hide
inside this phrase:

- **B1, blocking wizard run by an agent.** First invocation pauses, an
  agent inspects and interviews, config is written, then the user's
  command runs. This is the shape the ruling's communicate-after posture
  argues against, and it puts an agent between the user and their first
  value: latency, spend, and a nondeterministic failure mode on first
  contact, for a tool whose brand is legible failure.
- **B2, setup as its own flow or command (`circuit setup`).** Dogfooding:
  evidence, trace, report. Right as an opt-in and as the remediation path,
  wrong as a forced gate.
- **B3, setup folded into the first real run.** The first flow's early
  relay steps already inspect the project agentically (Fix gathers
  context, Build analyzes). Let that run persist what it learned as a
  side effect: a machine profile and a project profile, written through
  the existing config/state machinery with provenance comments, narrated
  in the run report. The user's own goal authorized the spend; setup costs
  zero extra ceremony and zero extra latency.

**C. Just-in-time casting, nothing persisted.** Every run detects and
casts fresh; config materializes only when the user pins something.
"Config is a cache of overrides, not a prerequisite." This is not an
alternative to B; it is the substrate B writes onto, and it is what makes
fresh containers, CI, and second machines work identically.

**D. Host-assisted setup.** The plugin host session is already an agent;
run.md could instruct it to configure Circuit. Rejected as the mechanism:
host compliance is nondeterministic across hosts and versions, and Circuit
cannot audit what the host did. Kept as the narration channel: the host
should relay Circuit's own readout lines, not invent its own setup.

## Evaluation

| Criterion | A static | B1 wizard | B2 own flow | B3 in first run | C JIT only |
| --- | --- | --- | --- | --- | --- |
| Time to first value | instant | worst | delays if forced | instant | instant |
| Spend before value | zero | agent run | agent run | zero extra | zero |
| Reliability on first contact | highest | lowest | medium | high (run already supervised) | highest |
| Auditability | high | low | high (trace) | high (report + commented config) | high |
| Answers project-specific questions | no | yes | yes | yes | no |
| Covers plugin funnel | yes | awkward | needs teaching | yes (rides /circuit:run) | yes |
| Offline / credential-less | works | fails | fails | degrades honestly | works |

## Recommendation: one substrate, three moments

The agentic setup Pete described, decomposed so each part runs where it is
strongest. The user experience he specified is preserved exactly: say the
goal, Circuit configures itself from what is available, then explains what
it chose and how to change it. What changes is the mechanism mix:
deterministic where shipped knowledge suffices, agentic where judgment is
needed, and never a ceremony between the user and their first result.

**Substrate (from C): casting needs no config, ever.** At run start:
resolve the connector set the plan would use (`chosen-connectors.ts`
seam), probe it (`health.ts`, about a second), cast seats from the
temperament table times the healthy set times the power dial. This also
closes friction F4 (dead connector aborts mid-run today) as a byproduct,
and it means a fresh container behaves identically to a configured
laptop.

**Moment 1, first contact: instant, deterministic, communicated.**
A first-run marker in per-user state (new, small: `~/.config/circuit/`
state file, deliberately NOT config.yaml, preserving "healthy defaults
write no config"). On the first run invocation ever, the readout is
expanded: what was detected, what was cast per seat and why, the three
adjustment paths (`circuit config`, per-run flags, `circuit preview`).
On every later run, one line. In pipe mode, an envelope field (precedent:
`run-stdout-envelope.ts` carries history_recall the same way). On the
Claude host the SessionStart hook injects a one-time brief through the
same additionalContext channel the continuity brief uses. That channel
reaches the model, not the screen, so the host speaks the note in its own
voice and asks the auto-use consent question (see the 2026-07-14 feedback
section below), staying silent otherwise, exactly like the brief does
today.

**Moment 2, first run in a project: the agentic part, inside paid work
(B3).** The run's existing early relay steps learn the project anyway.
Persist the durable slice of it: verification commands discovered by
inspection (this is the friction log F2 fix wearing its positive face: a
Makefile or pytest setup is DETECTED, not demanded; an npm-init
placeholder script is recognized as "no command"), ecosystem facts worth
keeping. Written to project config with provenance comments through the
existing validated writer; narrated in the run report ("Circuit learned
this project verifies with `make test`; saved to .circuit/config.yaml").
The next run starts smarter. No setup moment ever happened.

**Moment 3, `circuit setup`: the explicit deep version (B2).** Opt-in, and
the remediation path when the substrate hits a wall (no healthy connector;
no verification command detectable even agentically). Shape: a bounded
one-off relay on the generate template (pinned cheap model, schema-validated
output, capped rounds) that inspects machine plus project and proposes
config the user confirms. Also the natural home for the guided version the
TUI front door could launch (`create` screen precedent:
`src/cli/interactive/state.ts:90-96`). Never auto-runs; auto-kickoff of
unrequested agent spend is the one part of the addendum this note argues
against, because B3 achieves the same magic with spend the user already
authorized.

**Narration (from D): the host relays, never invents.** run.md gains one
instruction: surface Circuit's readout lines verbatim when present. That
plus Moment 1 shrinks friction F3 the right way: users learn `preview`,
`config`, and `doctor` at the moment those commands are relevant, from
Circuit itself.

## Failure modes designed against

- **No healthy connector:** casting degrades to the doctor's remediation
  text pre-spend (F4's fix), never a mid-run abort.
- **Only one connector:** today's behavior is the floor; single-connector
  casting with power tiers, readout still explains.
- **Offline / credential-less (container battery):** substrate and Moment
  1 are fully deterministic and keep working; Moment 2 simply never
  happens; nothing blocks.
- **Ambiguous project (monorepo, no verify command):** Moment 2's relay
  steps report honestly; if the flow needs what is missing, the abort
  names `circuit setup` as the escape (aborts must read as "precondition
  unmet", not "run failed", per friction F2's timing finding).
- **Stale persisted profile:** profiles carry provenance and a
  detected-at stamp; runs re-verify cheaply at start (probe, script
  existence) and re-learn on drift rather than trusting blindly.

## Staged build plan (all post-announcement)

1. **Preflight + readout** (pairs with friction F4): probe the chosen
   connector set at run start; add the one-line cast readout and the
   envelope field. Smallest slice, makes every later choice visible.
2. **First-run marker + expanded first readout + host narration line**
   (Moment 1, and the F3 shrink).
3. **Temperament-staffed casting** (the roster note's build item; substrate
   complete after this).
4. **Project profile persistence from run reports** (Moment 2; includes
   the F2 verification-command detection, placeholder-script rejection).
5. **`circuit setup`** (Moment 3; generate-template relay, config proposal,
   TUI entry).

## Forks for the operator

1. **Auto-kickoff of an agent on first invocation:** this note recommends
   no (B3 gets the magic without unrequested spend); the explicit
   alternative is auto-running `circuit setup` once when the first
   invocation is a bare/exploratory command rather than a run. Cheap to
   revisit after Stage 2 ships and the readout exists.
2. **Where profiles live:** machine facts per-user, project facts in
   project config (leaning), or everything project-local.
3. **Cross-connector casting default-on** when two subscriptions are
   healthy: ruling implies yes; confirm the loud readout is enough
   mitigation for the spend surprise.
4. **Vocabulary:** casting / seats / temperament / roster need the
   ubiquitous-language decision before anything user-facing ships.

## What the field's evidence says

Full survey in
[`docs/learnings/first-run-setup-precedents.md`](../learnings/first-run-setup-precedents.md).
The load-bearing findings for this design:

- **Nobody ships install-time agentic config-writing.** Every agentic
  config-writer in the wild (the `/init` family, Copilot's Generate
  Instructions) is user-invoked and reviewable. The auto-kickoff variant
  is unclaimed territory; the adjacent evidence says hold the agentic
  step until the user is present and the output is reviewable. This is
  the external case for Moment 2's shape: the user IS present (they just
  gave a goal) and the output IS reviewable (it lands in the run report
  and a commented config file).
- **Generated config restating the discoverable is net-negative and
  rots** (the documented `/init` backlash). So Moment 2 persists
  decisions with their evidence ("verify: `make test`, detected from the
  Makefile"), never descriptions of the repo. Short, decision-shaped,
  stamped, cheaply re-verified at run start.
- **The praised machine-written config is Renovate's onboarding PR**:
  detected evidence, one decision per line, what to expect next, inert
  until accepted. `circuit setup` (Moment 3) should produce exactly that
  artifact shape, which also matches Circuit's standing
  proposals-never-auto-apply guardrail.
- **Receipts, not paragraphs**: git's init.defaultBranch hint is the
  model for Moment 1's steady-state line, with the change-command inline.
- **A repeated question is a bug; a blocked non-TTY prompt is a bug.**
  First-run state must be persisted and content-keyed; nothing in this
  design may prompt in pipe mode.

## 2026-07-14 operator review of the demonstrated journey

The recommendation above was demonstrated to the operator as an
eight-scene mock journey (session artifact, terminal frames with real
copy). His feedback corrects one mechanism and adds rulings. Where they
conflict with the body, this section wins.

1. **Correction: the session hook cannot show the user anything.**
   additionalContext reaches the model, not the screen. Anything the user
   sees at first contact is spoken by the host, because the injected brief
   instructed it to. Design change: the first-contact brief instructs the
   host to tell the user Circuit is installed and which agents were found
   healthy, to offer bringing Circuit in automatically when a task fits
   and ask for consent, and to name the exits up front (stop using
   Circuit, uninstall it). The consent answer persists in per-user state;
   the question never repeats. Auto-use announces itself on every handoff
   so the user always knows Circuit is involved.

2. **Ruling: the agent is the interface for plugin users.** Receipts and
   run-start summaries contain no CLI commands. Adjustments happen in
   conversation: the user says "use fable for research", the host asks the
   one follow-up that matters (effort level), then drives `circuit config`
   under the hood. Manual controls stay documented for power users, and
   first contact may point at them once. The run-end recap stays and stays
   succinct: which model did what, what was learned, no commands.

3. **Ruling: keep the in-run learning shape, tentatively.** Learning the
   project inside the first paid run (the B3 shape) stands, to avoid
   front-loading decisions. A pre-run learning pass remains an open
   variant if the in-run shape proves confusing in practice.

4. **Open problem: live run feedback.** Neither host gives Circuit a
   reliable way to show run internals while a run executes. The host can
   be asked to narrate progress, but compliance is hit or miss. The
   guaranteed surfaces are run start and run end; design copy may claim
   only those. A real live-feedback channel needs its own design note
   before the Stage 2 copy is finalized.

5. **Vocabulary: "cast" is rejected** (reads like theater roles), and
   "readout", "first run on this machine", and "nothing was written to
   disk" all read wrong as user-facing phrasing. User copy says "who does
   what" and "these are Circuit's defaults; nothing is locked in". The
   internal term for the mechanism still awaits the ubiquitous-language
   ruling.

6. **Confirmed: asking to configure shows the whole effective setup.**
   When the user asks how Circuit is set up, the host shows the full
   effective configuration with smart defaults included and offers
   changes, labeling defaults, learned facts, and the user's own choices
   apart, so "what did I decide versus what was decided for me" is always
   answerable. Underneath it is the same proposal machinery as `circuit
   setup`: evidence per decision, nothing applied until accepted, never
   run unasked.

### Second pass, same day

7. **Automatic or manual is a setting, not a yes/no consent.** The
   first-contact question offers two modes: automatic (the host brings
   Circuit in whenever a task fits) or manual (only when the user asks).
   Persisted in per-user state, switchable in a sentence, shown in the
   configuration review as a `mode` row.

8. **The handoff announcement is minimal.** "Running Circuit: Build" and
   nothing else. No preamble, no reminder of what the user chose or why.

9. **The expanded who-does-what shows before the first run of each
   flow**, because staffing differs by flow; every later run of that flow
   gets a compact labeled start line. Preference changes always state
   their scope in the confirmation: persisted for this project going
   forward, or one run only ("just this run").

10. **Every Circuit-voiced surface is structured.** Start lines,
    progress, receipts, walls, and the configuration review all use
    scannable labeled rows (result / who did what / learned; status /
    instead / later; status / why / fix), one consistent grammar across
    the journey. Prose paragraphs are for the assistant's own voice, not
    for Circuit's facts.

11. **Open design work: how defaults are derived per environment.** The
    temperament table covers the happy path (both major vendors present,
    flagship models). One vendor only, small models only, and unfamiliar
    model names all need an explicit decision procedure before the
    casting stage builds.

12. **Open work: first-contact delivery needs live testing.** Whether
    and when the host actually surfaces the injected first-contact brief
    as speech is unverified, and the timing and verbiage will need
    tuning against real host behavior.
