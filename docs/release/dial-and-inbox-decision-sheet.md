# Decision sheet: dial shape and the inbox name

Status: decided 2026-07-10. Path A for the dials (one power dial with an
advanced `--process` override) and `circuit checkpoints` for the inbox.
Written 2026-07-10. Covers punch items 4, 5, and 6 from
[pre-release-punch-list.md](pre-release-punch-list.md). These two
decisions gate the final rename sweep, the operator-skill refresh, the
circuit-land sweep, and the next release cut.

## Decision 1: dial shape (punch item 4)

The punch item reports that `--depth` and `--power` are not semantically
distinguishable. The sharper version of the complaint, raised while
brainstorming the rename: choosing more process and choosing stronger
models feel like the same decision. That points at combining the dials,
not renaming them.

### Path A (recommended): one front-door dial

`--power <low|medium|high|auto>` becomes the only dial the front door
teaches. It keeps its current meaning (which model tier fills each
archetype) and gains one rule: it also derives process thoroughness.

| power | derived process |
| --- | --- |
| low | low |
| medium | medium |
| high | high |
| auto | medium (auto stays a model-tier concept) |

Details that make it safe:

- Derived process clamps to each flow's supported set. Review and Pursue
  stay medium. Prototype floors at medium. Build, Explore, and Fix use
  the full ladder.
- The process axis survives as an advanced override: `--depth` is
  renamed `--process <low|medium|high>`, and an explicit value beats the
  derivation. Off-diagonal combinations stay one flag away: thorough
  process on cheap models (`--power low --process high`), or a strong
  model on a quick pass (`--power high --process low`).
- The old `--depth` flag is rejected as unknown, with a retirement test,
  matching the `--tournament-n` retirement from item 1. No aliases.
- Config does not move. `defaults.power`, `power_tiers`, and
  `power_auto` keep their meaning. The process axis has no config key
  today ("pick depth yourself; let power pick itself" is the documented
  stance) and keeps none.
  *Superseded:* `flows.<id>.process` now exists. The stance held until the
  interactive front door started offering a per-flow thoroughness picker,
  at which point refusing to persist the answer meant offering a knob that
  did nothing. See [`docs/configuration.md`](../configuration.md#process).
- Behavior note to accept consciously: on Fix, `--power low` now derives
  process low, which skips the independent review stage. That pairing is
  already the documented guidance for quick sanity passes; the
  derivation makes it the default instead of a two-flag incantation.

Why recommended:

- The operator's real input is one quantity: what is at stake. Turning
  stakes into process and model choices is Circuit's job, and the
  role-aware allocator already performs the intelligent off-diagonal per
  step (strong models on steering archetypes, cheap ones on execution).
- Our own guidance never moves the dials apart. Every documented example
  raises or lowers both together.
- The README masthead already says "One power dial sets the spend." Path
  A makes that sentence literally true.
- It dissolves the distinguishability complaint instead of answering it
  with better synonyms. One taught dial cannot be confused with another.

Cost to name honestly: this reopens the settled two-dial direction
(process manual, power auto-capable). The engine keeps both axes
internally, so the reopen is a surface decision, not an architectural
one.

### Path B (fallback): keep two dials, rename for contrast

If two front-door dials should survive, the strongest pairs from the
wider exploration:

- `--process` + `--models`: names the mechanism each controls; most
  literal. Renaming power migrates the config keys (`defaults.power`,
  `power_tiers`, `power_auto`).
- `--process` + `--power`: smallest change (one rename), keeps the
  masthead word and the config keys.
- `--thoroughness` + `--power`: plainest English, longest flag.

Why not recommended: better names still leave two knobs answering one
instinct. The punch item's root complaint (a new user cannot guess which
one to turn up) returns on day one.

## Item 5 consequence (either path): archetype becomes product vocabulary

Archetype is promoted from internal engine vocabulary regardless of the
dial decision: an UBIQUITOUS_LANGUAGE.md entry (the role-shaped slot in
a flow that a model fills), the preview and selection readouts naming
the archetype per relay, positioning claim 3 phrased with it, and the
circuit-land selection and configuration pages.

Under Path A the dial story becomes one sentence: the power dial decides
which model fills each archetype; `--process` decides how many passes
the flow makes.

## Decision 2: the inbox name (punch item 6)

Criterion from the punch item: name the contents (runs paused at
checkpoints, waiting on the operator), and prefer existing ubiquitous
language over a new metaphor.

- `circuit checkpoints` (recommended): canonical vocabulary, guessable
  six weeks later, names exactly what the list contains.
- `circuit parked`: matches the product's own prose ("the run is
  parked"), though it reads as a state more than a place.
- `circuit docket`: semantically exact (a list of matters awaiting
  decision) but the least plain word on the table.

Rejected: folding the command into `circuit runs --waiting`. "Was
anything waiting on me?" deserves a one-word answer at the front door.

## Execution order once redlined

1. Item 4 in this repo (one Build run, high depth): derivation rule,
   flag rename and retirement test, preview output, help text, docs.
2. Items 5 and 6 in this repo (one Pursue run, two pursuits): archetype
   promotion, inbox rename. After item 4 so the dial language lands in
   archetype terms.
3. Operator skill refresh, then one circuit-land sweep run covering all
   three items (landing dial section, selection and configuration
   pages, the inbox CLI page and nav entry).
4. Push, first-run container lab, then the release runbook (publish,
   tag, announcement).
