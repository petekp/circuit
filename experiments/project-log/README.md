# Project activity log (prototype)

A readable, browsable log of what has happened and is happening in a Circuit
project, and a roll-up across many projects at once. An alternative to the
`/catch-up` skill that reads structured run records instead of reconstructing
history from a transcript.

This is a prototype. It lives in `experiments/`, touches nothing in the engine,
and reads only local disk. Nothing here ships until we decide to productize it.

## The idea

`/catch-up` works by reconstructing what happened: it reads git history and the
chat transcript and infers the story. Circuit does not have to reconstruct. It
already records what happened in structured form. So this reads the records
directly, and it can do it across every project at once.

It fuses three signals that are already on disk per project:

1. **Circuit runs** (`.circuit/runs/<id>/reports/`)
   `result.json` gives the goal, outcome, and verdict. `operator-summary.json`
   gives a clean headline plus key points. Parked checkpoints
   (`checkpoints/<id>-request.json` with no matching `-response.json`) are the
   real decisions waiting on you, read from data, not guessed.
2. **Last chat session** (`.circuit/continuity/records/*.json`)
   The ambient-continuity harvest. This is how chat-driven work still shows up
   even when it never ran a flow: the last session's goal is captured here.
3. **Git** (commits, branch, working-tree status)
   The universal signal. Captures all committed work regardless of how it was
   done.

## Usage

```bash
# Briefing for the current project
node experiments/project-log/catch-up.mjs

# Briefing for a specific project
node experiments/project-log/catch-up.mjs ~/Code/some-project

# Portfolio roll-up across every Circuit-touched project under ~/Code
node experiments/project-log/catch-up.mjs --all

# Flags
#   --days <n>    time window (default 21)
#   --root <dir>  where to look for projects in --all mode (default ~/Code)
#   --json        machine-readable output
#   --no-color    plain text
```

## The honest coverage gap

A runs-only log would miss most of what happens in a project, because a lot of
work is chat-driven and never runs a flow, so it leaves no run folder. That is
the same gap `/catch-up` solves by reading git and the transcript. This tool
closes most of it with git (all committed work) plus the last-session snapshot
(the harvested chat goal). What it still does not see: in-flight conversational
work that has neither committed nor been harvested yet. The footer says so.

## What is shipped vs what this adds

Shipped in Circuit today (per project only):
- `circuit history query` (full-text search over runs, not a timeline)
- `circuit inbox` (parked checkpoints, with staleness probe)
- `circuit runs show` (one run's status)
- Per-run `operator-summary.md` (one run, not a feed)

What no command does today, and what this prototype adds:
- A chronological feed of all runs with outcomes (single project)
- A plain-English "what changed / where you left off / waiting on you" briefing
- A cross-project roll-up (no global index exists; this walks `~/Code/*/.circuit`)

## Path to productizing

If this earns its place, the natural home is a real read command, e.g.
`circuit log` (single project) and `circuit log --all` (portfolio), built on the
same run-record reads the existing `history`/`inbox`/`runs` commands use, so it
shares their code rather than reimplementing parsing. The cross-project walk is
the one genuinely new capability and should stay opt-in (it reads other repos).

Fast-follow after that: ingest the chat transcript the way `/catch-up` does, to
close the last sliver of the coverage gap; and a browsable surface (scroll,
filter, drill into a run) rather than a one-shot terminal dump.
