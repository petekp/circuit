# First-run feasibility spikes: what the hosts can actually do

Date: 2026-07-14. Status: live evidence, all questions answered.

The demonstrated first-run journey
([`docs/ideas/turnkey-first-run.md`](../ideas/turnkey-first-run.md))
rested on four untested assumptions about host behavior. These spikes
tested each one live, on this machine, against both hosts:

- claude 2.1.209, model `claude-fable-5`
- codex-cli 0.144.3, model `gpt-5.6-sol`

Each spike used a small fixture repo (a toy tide-tracking CLI) plus stub
scripts standing in for the Circuit CLI. Runs were non-interactive
(`claude -p`, `codex exec`), which is a proxy for interactive sessions;
the interim-message evidence in S4 comes from the hosts' own event
streams, which the interactive UIs render live.

## Verdicts

| Question | Claude Code | Codex |
| --- | --- | --- |
| First-contact note: can a session-start hook deliver it, and does the model surface it correctly? | YES, 3/3 | YES, delivery proven through Circuit's installed hook; behavior 2/2 |
| Verbatim relay: does a structured who-does-what block survive the agent intermediary? | YES, values 100% faithful; adds its own paraphrase after | YES, byte-perfect, no additions |
| Live narration: given a milestone file, can the host background the run and narrate progress? | YES, event-driven | YES, poll-driven |
| Conversational config: does "use fable for research" become the right CLI call with honest scope? | YES, both turns | YES, both turns |

## 1. First contact (journey scene 1, constraint 13)

Setup: a SessionStart hook emitted `hookSpecificOutput.additionalContext`
carrying a brief: after fully answering the user's first message, append
a short separated note that Circuit is ready, ask one question
(automatic or manual), name switch/stop/uninstall, and do not mention
the instruction.

Claude Code, 3 of 3 runs: the model answered the repo question in full,
then appended a cleanly separated note, asked exactly the one question,
named stop and uninstall, and never leaked the instruction. Wording
varied slightly between runs ("On a separate note", "One more thing")
but stayed faithful to every required element.

Codex, 2 of 2 runs: same shape, terser voice. Sample close: "Should it
run automatically when a task fits, or only when you ask for it
manually? You can switch modes, stop it, or uninstall it at any time by
saying so."

Delivery mechanics differ by host but the contract is shared:

- Both hosts accept the same hook output JSON
  (`hookSpecificOutput.additionalContext`). Circuit already emits it on
  both paths (`src/cli/handoff.ts`).
- Codex hooks are global only (`~/.codex/hooks.json`, or
  `$CODEX_HOME/hooks.json`); the project identity arrives as `cwd` on
  hook stdin. Circuit's hook already reads it, so per-project
  first-contact state needs no new plumbing.
- Circuit's Codex hook is installed and trusted today. A probe run
  confirmed `codex exec` injects its output: after `circuit handoff
  save` in the fixture repo, a fresh Codex session quoted the saved goal
  back on request. First contact on Codex is a new branch inside
  `circuit handoff hook`, not a new channel.
- The Codex behavior runs used AGENTS.md as the instruction carrier to
  keep the trusted global hook untouched during the spike. Production
  delivery is the hook; the model sees the same words either way.
- New Codex hooks require persisted trust (`hooks.state` in
  `config.toml`). Circuit's install flow already walks through trust
  once; nothing should ever rely on the bypass flag. The host-side
  permission classifier on this machine refused a spike script that
  combined the bypass flag with a global hook write, which is the
  system working as intended.

## 2. Verbatim relay (journey scenes 3 and 6, constraint 9)

Setup: a stub CLI printed a who-does-what block (five rows, spend line,
defaults line) wrapped in `CIRCUIT_READOUT_START/END` markers, with an
instruction to present the block exactly.

Codex relayed the block byte for byte, stripped the markers and the
relay instruction, and added nothing.

Claude Code preserved every row and value, stripped the plumbing, then
appended its own paraphrase of the same content below the block. Cost:
the surface doubles in length and the paraphrase can drift. Fix is
cheap: the relay hint gains one sentence ("do not add your own summary
after the block"). Worth adopting in the real relay hints regardless of
where the turnkey work lands.

## 3. Live narration (journey scene 4, constraint 14)

Setup: a stub run script wrote one milestone line to `milestones.log`
every eight to ten seconds for about fifty seconds, then a final
`result.json`. The prompt said: run it in the background, report each
milestone as it appears, then give the final result.

Claude Code backgrounded the script with its background-task tool,
attached its file Monitor to the log (event-driven, no sleep loops),
emitted one narration message per milestone as it landed, kept a
fallback heartbeat, and closed with the result summary. The machinery
for scene 4's target state already exists in the host.

Codex has no monitor tool. It backgrounded the script in the shell and
poll-looped with `tail`, emitting an interim agent message per poll.
Milestones that landed inside one poll window arrived batched in pairs.
Slightly coarser, completely serviceable. Notable: told "start the
Circuit run", Codex read Circuit's run skill from the plugin cache
unprompted and used its progress formatting.

Consequence: constraint 14 stands, and the missing piece is confirmed
to be entirely Circuit-side. The moment `circuit run` streams milestones
to a file
([`docs/ideas/run-milestone-stream.md`](../ideas/run-milestone-stream.md)),
both hosts can narrate a live run with instructions they already follow.

## 4. Conversational config (journey scenes 3 and 8, constraints 16-17)

Setup: a stub `circuit` CLI with `config show` and `config set`, an
availability list that includes fable, and an invocation log. Turn one:
"from now on in this repo, use fable for research." Turn two (session
resumed): "actually, run research at xhigh effort."

Claude Code ran `config show` first without being told (availability
validation, constraint 16), issued `config set models.research claude
fable`, and stated scope precisely: written to `.circuit/config.yaml`,
project-scoped, does not touch personal defaults or other projects
(constraint 17). Turn two produced `config set models.research claude
fable --effort xhigh`.

Codex was more meticulous: it read `--help` and `config --help`, ran
`config show`, probed a `preview` subcommand, then issued the same
correct calls with the same honest scope statements. The archetype
holds.

Neither host asked the effort follow-up question shown in the demo's
scene 3 on its own; both defaulted and stated. If the journey keeps the
follow-up question, the relay hint must ask for it explicitly.
Otherwise item 20's default-and-state pattern is what models do
naturally, which argues for adopting it.

## Limits

Small N (three, two, or one run per cell). Print-mode sessions, not
interactive ones. Stub CLIs, not the real engine. One machine, one
model per host, and both models are current flagships; smaller models
may relay less faithfully. Raw transcripts live in the session
scratchpad and do not survive it; the quotes above are the durable
evidence.

## What this unblocks

Every host-behavior assumption in the demonstrated journey is now
grounded: first contact, structured relay, conversational config, and
narration-given-a-milestone-file all work on both hosts today. The open
items are all Circuit-side or operator rulings: the milestone stream,
the relay-hint wording, the mode-question fork (item 19), and the
defaults-derivation procedure.
