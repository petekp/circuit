# Circuit surface test — <host>

**Run:** <ISO timestamp>
**Operator:** <user name or session id>
**Pass rate:** <P>/<T> (<F> failed, <PWF> pass-with-finding, <S> skipped, <PS> partial-skip)
**Severity counts:** Critical <C> · High <H> · Medium <M> · Low <L>

## Summary

<2–4 sentences in plain English. State the headline result: clean / mostly
clean with N issues / broken. If the operator should hold a release, say
so up front. Do not bury the lede.>

## Environment

- **Host being tested:** <claude | codex>
- **Executing host:** <Claude Code | Codex> (cross-host: <yes | no>)
- **Plugin root:** <absolute path>
- **Plugin version:** <from .claude-plugin/plugin.json or .codex-plugin/plugin.json>
- **Circuit repo commit:** <`git -C <repo> rev-parse HEAD` from the repo
  whose plugin you are testing>
- **Cache freshness gate:** <passed | blocked; include emit/cache-check/doctor commands>
- **Cache sync targets:** <Claude cache path; Codex cache path>
- **Runtime source:** <direct | bundled | unresolved>
- **Doctor host identity:** <doctor --json `.host`: claude-code | codex>
- **Auto connector resolved_from (per host):** <"auto" + resolved connector name observed in trace? yes/no/not checked>
- **Wrapper doctor:** <ok | warning | failed; include warning names>
- **Installed package doctor:** <ok | warning | failed | not checked; include source/target counts when checked>
- **Scratch repo:** <absolute path>
- **Report dir:** <absolute path>
- **Native invocation available:** <yes | no — if no, list the rows that
  became Skipped because the executing host could not invoke the target's
  surface>

## Source-Backed Surface Inventory

Fill this from `references/current-surface-inventory.md` and the local commands
you actually ran.

### Commands and Host Packages

- **Claude commands present:** <run, pursue, handoff>
- **Codex commands/skills present:** <run, pursue, handoff>
- **Public generated flow packages (mirrors):** <review, fix, pursue, prototype, build, explore>
- **Internal generated flow packages:** <goal, runtime-proof; host mirrors absent?>
- **Host-only limits:** <pursue is the only flow with a direct command/skill — the others are routed through Run; create is CLI-only; goal is internal and never auto-selected>

### CLI Flags

- **Run-axis flags observed:** <--depth, --power, --tournament, --tournament-n, --autonomous>
- **Evidence flags observed:** <--include-untracked-content, --progress jsonl, --run-folder>
- **Rejected unsupported flags checked:** <--mode, --rigor, --dry-run, if checked>

### Axis Allow-List

| Flow | Visibility | Allowed depth | Tournament | Autonomous | Direct host command/skill |
|---|---|---|---|---|---|
| review | public | medium | no | no | none; via Run |
| fix | public | low, medium, high | no | yes | none; via Run |
| build | public | low, medium, high | no | yes | none; via Run |
| explore | public | low, medium, high | yes | yes | none; via Run |
| prototype | public | medium, high | yes | yes | none; via Run |
| pursue | public | medium | no | yes | direct command/skill + via Run |
| goal | internal | low, medium, high | no | yes | none; internal, no classifier auto-selects it |

The power dial is per-run, not per-flow: `--power <auto|low|medium|high>`,
default `medium`.

Build (depth high only) iterates a per-slice implement+verify loop: progress
gains a `(slice N)` suffix and the trace gains `slice_index`. Record the slice
count, whether the `(slice N)` suffix appeared, and the observed
`anticipated_file_extensions`.

### Operator Summary Fields

- **Markdown final answer (digest-first):** <operator_summary_markdown_path rendered verbatim when present? yes/no>
- **Run surface fallback:** <run_surface_markdown_path observed as fallback only when digest absent? yes/no/not applicable>
- **Status text (digest = flow name; surface = outcome):** <operator_summary_status_text and run_surface_status_text observed and distinct? yes/no>
- **HTML rich summary:** <operator_summary_html_path observed? yes/no/not applicable>
- **Presentation events:** <presentation.status_text preferred? yes/no/partial>
- **Skill hooks:** <skill_hook_activations present + "## Skill hooks" section rendered? yes/no/not applicable (no config)>
- **skill_hook_dispatch_failed warning:** <present? yes/no — expect no on a healthy run>
- **Outcome taxonomy coverage:** <which of {complete, aborted, handoff, stopped, escalated, checkpoint_waiting} were observed vs partial-skipped>

## Phase 1 — checklist results

Group by section. One row per checklist item. Status emoji optional but
recommended for scanning.

### Section A0 — structural smoke matrix

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| A0.0 | run — native host pick | pass / fail / skipped | <abs path or — > | <one line> |
| A0.1 | explore — default | … | … | … |
| A0.2 | review — default | … | … | … |
| A0.3 | fix — default | … | … | … |
| A0.4 | build — default | … | … | … |
| A0.5 | prototype — default | … | … | … |
| A0.6 | pursue — default | … | … | … |

### Section A — flow and axis surface

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| A1 | explore — default | pass / fail / skipped | <abs path or — > | <one line> |
| A2 | explore — depth low | … | … | … |
| … | … | … | … | … |

### Section B — utility surface

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| … | … | … | … | … |

### Section C — outcome paths

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| … | … | … | … | … |

### Section D — security and safety

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| … | … | … | … | … |

### Section E — host integration smoke

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | Notes |
|---|---|---|---|---|
| … | … | … | … | … |

### Section F — skill-hooks surface

| ID | Item | Status (pass / pass-with-finding / fail / skipped / partial-skip) | Run folder | CLI-observable / interactive-only | Notes |
|---|---|---|---|---|---|
| F1 | mute hook fires, no inject | … | … | CLI (run-dependent) | … |
| F2 | auto hook injects + provenance | … | … | CLI (run-dependent) | … |
| F3 | inert lifecycle + role gate | … | … | CLI | … |
| F4 | unavailable-skill disclosure | … | … | CLI (run-dependent) | … |
| F5 | no-config = no surface | … | … | CLI | … |
| F6 | config validation rejects | … | … | CLI (cheap) | … |
| F7 | dispatch-failed warning | … | … | interactive-only | … |

## Local Protocol Smoke

- **Command:** <exact wrapper smoke command>
- **Exit:** <code>
- **Evidence:** <path or transcript snippet>
- **Result:** <what this smoke proved; what it did not prove>

## Phase 2 — exploratory findings

Findings ranked by severity. Use as many entries as warranted. If there
are no findings in a severity bucket, state "(none)" rather than omitting
the section — explicit empty-bucket signaling helps readers calibrate.

### Critical

A finding is Critical when it would break an out-of-the-box install, lose
operator data, or silently produce wrong output a real user would act on.

#### F-C-1: <one-line title>

- **Triggering checklist row(s):** <e.g., A11, A12>
- **Repro:**
  ```bash
  <exact command>
  ```
- **Expected:** <what the SKILL.md / checklist / plugin docs say should
  happen>
- **Actual:** <what actually happened — quote stdout/host render where
  useful>
- **Evidence:** <run folder path, transcript snippet, file diff>
- **Hypothesis:** <2–3 hypotheses for the root cause, in order of
  likelihood. Per AGENTS.md rule 5, do not commit to one without
  evidence.>

### High

A finding is High when it produces a degraded but recognisable user
experience: missing summary fields, wrong progress rendering, broken flag
handling.

#### F-H-1: <title>

(same structure as Critical)

### Medium

Slow, ugly, ambiguous, or surprising — the user gets the right answer but
not the right experience.

#### F-M-1: <title>

(same structure)

### Low

Cosmetic issues, minor copy nits, or behavior that is technically correct
but could be friendlier.

#### F-L-1: <title>

(same structure)

## What looked good

A short list of surfaces that worked exactly as documented. Resist the
urge to flatter — only entries you actually verified during the run.
This section keeps the report honest about which parts of the system you
actually proved.

## Recommendations

Two to four concrete next steps. Each one names the surface affected, the
suggested change, and which finding(s) it addresses. Do not invent
follow-up work that wasn't earned by something in the report.

- <recommendation> — addresses <F-C-1, F-H-2>
- <recommendation> — addresses <F-M-1>

## Open questions

If anything was ambiguous about the spec, list it here. These are
questions for the operator, not bugs.

- <question>

## Appendix — invocations attempted

A flat list of every command run during the session, in order, with exit
codes and run folders. This is the audit trail. Future readers (including
LLMs) read this when they need to understand what was actually exercised.

```text
[01] /circuit:run briefly explain the repo layout (selected_flow=explore)
     exit=0  run=<abs path>
[02] run explore --depth high --goal 'compare low vs high depth tradeoffs for explore'
     exit=0  run=<abs path>
…
```
