# The Circuit CLI, from first principles

Status: design note, awaiting redline. No code implied. Written 2026-07-12,
after a deep-research pass on the CLI/TUI ecosystem (clig.dev, 12-Factor CLI
Apps, the Heroku style guide, and the tools most regarded for onboarding and
terminal UX). Reconciled 2026-07-12 against an adversarial review and the
repo's real contracts. Nothing here ships before the v1 announcement.

## Why Circuit is not in the same category as the tools we studied

Every highly regarded CLI falls into one of two shapes. Request-response
tools take a command and print a result (gh, stripe, uv, prisma). Browsing
surfaces let you navigate live state (lazygit, k9s, btop). Circuit is
neither. Three structural facts set it apart, and the design should start
from them rather than from imitation.

1. **Three users, not two.** The classic split is human at a TTY versus
   script in CI. Circuit has a third user that is often primary: a host
   agent driving the CLI on the operator's behalf. The machine surface is
   not an export format. It is a load-bearing protocol.
2. **Runs are long-lived and stateful.** A run has a lifecycle: start,
   watch, detach, reattach, resume, inspect. This is closer to a deploy or
   a CI system than to a classic command. The lifecycle is the core object
   model.
3. **The repeatable process is the product; evidence is the truth floor.**
   The honesty floor means terminal output is not decoration around the
   work. Output architecture should follow from what the run folder can
   prove.

The current surface is a set of good individual commands with conventions
decided per command. Preview sits beside run. Config is a screen rather
than a loop. There is no runs surface and no watch/detach. That is the
local maximum: fixing it means deciding the system, not polishing the
commands.

## The constitution

Seven principles. Every later decision should trace to one of these.

1. **Three users, one contract.** Operator, driver, script. Every command
   works in all three modes: composed output on a TTY, versioned JSON off
   TTY, exit codes as the third rail. No mode has private capabilities.
   This generalizes the existing rule that the TUI has no logic.
2. **The terminal is a viewport; evidence is the truth.** Anything shown
   live can be re-rendered later from the run folder. Detach is free.
   `circuit report` and `circuit watch --replay` re-render at any time.
   Scrollback loss stops mattering.
3. **Never run before you have shown the shape.** Every run opens with a
   plan header: steps, relays, chosen connectors, power and process
   settings, time and spend band. The header renders the same readout as
   `circuit preview`, which stays a named command — it is the visible
   artifact of the multi-model story in the launch framing. Confirmation
   friction scales with spend.
4. **Every ending points forward.** Success, failure, and doctor all close
   with the next action, copy-pasteable. This is the single most validated
   pattern in the ecosystem research. It becomes a system-wide convention,
   not a per-command choice.
5. **The catalog is the interface.** Flows are verbs. `circuit fix "..."`
   mirrors `/fix` in the host chat. One mental model across both surfaces.
   A small fixed management namespace that flows can never shadow.
6. **Detect, propose, confirm.** Config is discovered (connectors, live
   model registers), proposed as a recommended set, accepted with one
   keystroke, and always inspectable with provenance: every effective
   value says where it came from.
7. **Honesty is rendered, not claimed.** No green check without a backing
   check. Readiness is graded on the chosen connector set. Spend is shown
   before and after. Relay quiet time is visible while a run is live.

## The grammar

```
circuit                     front door: status + start (TUI on TTY, text when piped)
circuit <flow> "goal"       built-in flows as verbs: fix, build, review, explore, prototype, converge
circuit run <flow> ...      the stable namespace: all flows, including yours (scripts, full flags)
circuit resume [id]         pick up the latest or named interrupted run
circuit watch [id]          attach to a live run (q detaches, never kills)
circuit preview <flow>      spend-free readout: connector, model, effort per relay
circuit report [id]         re-render any run's report

circuit flows               catalog; flows show fix = schematic + plan preview
circuit runs                recent runs; runs show / runs clean
circuit doctor              one command answers "is anything wrong, what do I do"
circuit config              effective config with provenance; config edit; config set
circuit generate / promote  encode a process: from intent, or from a transcript
circuit demo                replay a recorded run in the live UI; zero setup, zero spend
circuit help [topic]        examples first, including help <flow>
```

Notes.

- **Flows as verbs** is the strongest move available, scoped by the
  host-adapter contract: `circuit run <flow>` stays the stable namespace
  so user-defined flow names can never collide with future top-level
  commands (docs/contracts/host-adapter.md). Verbs are permanent aliases
  for the stable built-in catalog only. `/fix` in chat and `circuit fix`
  in the terminal being the same word is a coherence none of the studied
  tools can reach, because none of them have a catalog as their core
  object. `circuit <flow>` is sugar over `circuit run <flow> --goal ...`;
  the explicit form carries generated and user-defined flows and full flag
  parity. Unknown verbs get a typo suggestion.
- **Goals are optional where the flow has a natural zero-goal form**
  (review takes the current diff; resume takes the latest run).
- **Bare `circuit`** stays the front door: on a TTY the Ink screen, when
  piped a static status text. Its content becomes status plus start: last
  run, connector health, dial, and the three most likely next commands.

## The golden path, concretely

First run: detect, propose, confirm. The rustup shape, with the Nx lesson
applied (nothing consequential defaults to yes; the recommended set spends
nothing by itself).

```
  Welcome to Circuit.

  Found on this machine
    claude ✓ logged in · opus-4.8
    codex  ✓ logged in · gpt-5.4

  Recommended setup
    power: auto · process: medium · implement: claude · review: claude

  1) Proceed with recommended setup (default)
  2) Customize connector and dial choices
  3) Not now

  ✔ saved to .circuit/config.yaml

  Next steps
    1. circuit fix "<something small>"    try a first run
    2. circuit flows                      see what else it can do
    3. circuit config edit                change choices anytime
```

Starting a run: the plan header shows the shape before anything spends.

```
$ circuit fix "tooltip flickers on hover in settings"

  Fix · 7 steps · ~15-25 min · power auto · process medium
  reproduce → diagnose → implement → verify → review → report
  relays: claude (opus-4.8) ×4 · codex (gpt-5.4) ×1

  run 0712-1436-fix started · watching (q detaches, run continues)
```

Watching: aggregate progress plus a liveness meter. The relay inactivity
bound stops being a silent killer and becomes a visible gauge.

```
  Fix · tooltip flicker · step 3/7 implement            run 0712-1436-fix
  ✔ reproduce   test written, fails as expected (evidence: repro.md)
  ✔ diagnose    root cause: stale hover state on re-render
  ● implement   claude · last output 12s ago
  │  editing src/tooltip/hover.ts (2 files changed)
  ○ verify · review · report

  [q] detach   [enter] expand   [?] keys                  quiet 12s/180s
```

The keys line follows the TUI research: the interface teaches itself, `?`
shows what works here, and detach never kills.

Errors: one anatomy everywhere. Problem in plain words, exact fix, what to
run after, deep link. Forgiveness built in.

```
✗ can't start: codex is chosen for implement steps but isn't logged in

  fix   codex login
  then  circuit resume        (your intent is saved)
  docs  circuit.land/docs/connectors
```

Doctor: keeps the merged table, CHOSEN BY column, and chosen-set grading,
and always closes the loop.

```
  CHOSEN SET  1 problem

  ✗ codex   not logged in
    fix: codex login
    then: circuit doctor
```

Config: effective values with provenance. This single view answers "why is
it doing that", which is most config confusion.

```
$ circuit config
  power       auto        default
  process     medium      default
  implement   codex       project .circuit/config.yaml
  review      claude      default (register: reviewer)

  edit: circuit config edit · one value: circuit config set process high
```

`circuit config edit` becomes the detect-propose-confirm loop with pickers
per relay class, each choice showing its consequence ("Implement steps →
codex (gpt-5.4), used by Build and Fix") and validating against live
connector health on save. Precedence stays flags over env over project
over user over defaults, stated in help.

## The driver contract

The novel pillar. Circuit can set a bar nobody else is attempting because
nobody else has an agent as a first-class user.

- `--json` on every read command, schema-versioned.
- The event stream already exists: `--progress jsonl` emits the typed
  ProgressEvent contract (schema_version 1, ~18 event types from
  `run.started` through `checkpoint.waiting` to `run.completed`, in
  src/schemas/progress-event.ts). The work is extension, not invention:
  add a heartbeat event type and let `watch` attach to the same stream.
- **Heartbeat guarantee:** the engine emits a liveness event at least every
  N seconds, so a driver can always distinguish slow from dead. This
  inverts the relay-inactivity problem into a contract.
- Checkpoints as structured events plus the existing
  `circuit resume --checkpoint-choice <choice>`, so a driver can relay
  the decision to the human in chat and answer on their behalf.
- Exit codes as semantic API (already shipped) and a `circuit schema`
  command that prints the machine contracts.
- Idempotent resume: re-issuing a completed step is safe. The
  recovery-binding work already points here.
- No TTY prompts off TTY, ever. Anything interactive has a flag form.

## What stays, what changes

Already right, keep: evidence-first run folders; the exit-code contract;
doctor's chosen-set grading and CHOSEN BY; the TUI parity rule; the
CLI-boundary forgiveness pattern; generate and preview machinery; live
model registers as defaults rather than enums.

Reshape: the preview readout doubles as the universal pre-run plan header
(the named command stays); config becomes detect-propose-confirm with
provenance; next-step footers and the error anatomy become system
conventions; help regenerates examples-first from the catalog, including
per-flow help with expected duration and spend at the current power and
process settings.

New: built-in flows-as-verbs sugar; the runs surface; watch and detach
with aggregate progress and the quiet meter; the heartbeat event and watch
attachment on the existing progress stream; `circuit demo`; shell
completions with dynamic flow names.

## Sequencing

Standing rule holds: nothing before the announcement. After it, five
independently shippable waves.

1. **Conventions.** Next-step footers everywhere, the error anatomy, the
   config provenance view, examples-first help. Low risk, pure polish,
   touches no engine behavior.
2. **Runs surface.** `circuit runs`, `watch`, detach and reattach,
   aggregate progress, quiet meter.
3. **Grammar.** Built-in flows-as-verbs sugar, the config edit reshape
   (already queued as slice 2).
4. **Driver stream.** Heartbeat event, watch attachment on the progress
   stream, schema command.
5. **Reach.** `circuit demo` and shell completions.

## Open forks (operator's call)

1. **Flows as verbs**: built-ins only, per the host-adapter contract
   (`circuit run <flow>` stays the stable namespace for user-defined
   flows) — is the alias set worth having at all?
2. **Plan confirmation**: always confirm, confirm only above a spend or
   dial threshold, or confirm on first use of a flow?
3. **Bare `circuit`**: mission-control TUI, or a slimmer status page with
   the TUI behind `circuit config edit` and `circuit watch` only?
4. **`circuit demo`**: pull forward as a launch-marketing lever? It is the
   cheapest time-to-first-wow available and costs zero tokens to run.
