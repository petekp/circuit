# Circuit Capability Visualization: Metaphor-Free Beats and Choreography

Status: design sketch for a visualization, not shipped behavior, and not a
roadmap commitment. Format-agnostic on purpose (it does not assume a duration,
a medium, or a tech stack).

This note assumes the north star is fully realized: genuine dynamic flow
generation and variant generation are real and shown as real. That is the
aspirational frame. It is deliberately ahead of what is on `main` today. For
what has actually shipped, read [`north-star-status.md`](north-star-status.md)
and [`non-linear-composition-frontier.md`](non-linear-composition-frontier.md).
Treat this doc as option generation for how to communicate the fundamentals,
not as a claim about current behavior.

The goal was a single, coherent, elegant way to communicate Circuit's
fundamental mechanisms with no metaphor at all. No trains, no circuit boards, no
factories, no music. Every primitive on screen is the real Circuit entity, drawn
directly, using Circuit's own vocabulary (flow, schematic, block, step, route,
relay, check, trace, report, evidence, equipment).

## 1. The spine

One persistent flow, watched as it is authored, repaired, and run.

There is exactly one flow on the canvas for the entire piece, and the view never
cuts away from it. The viewer always looks at the same structure getting more
real. An empty field gains a frozen identity, accretes typed steps and routes,
gets simulated and repaired before it runs, lights up as it executes, and seals
into replayable evidence.

This is what makes the mechanisms cohere instead of reading as a parts list.
Nothing is ever re-introduced. A route drawn during generation is the same route
that carries the thick downstream push and the same route the thin upstream pull
inverts. The viewer learns each edge once and watches it earn its keep three
times.

The spine is a fusion of two ideas. The organizing principle is "one persistent
object, authored then run" (it teaches typed routes by reuse, and it keeps
validity and efficacy un-confusable by giving them different homes on a screen
the viewer already has a map of). From a layered-reveal approach it borrows one
discipline that lets a single dense canvas survive its own density: color is
reserved for run-state and withheld until execution, so the static type-coded
graph never fights the live one, and efficacy is rendered as the one badge the
system structurally cannot fill in.

## 2. The visual system

Abstract but literal. Each primitive is the real Circuit entity, drawn directly,
never standing in for it.

| Real Circuit entity | Visual primitive |
|---|---|
| flow | the single persistent graph that owns the canvas the whole piece; a bounded field with an identity header across its top |
| frozen bootstrap (flow, depth, change_kind, manifest_hash, invocation_id) | five small header slots that snap in once, then a closed border plus lock glyph; they faintly tint everything downstream as provenance |
| block | a tile lifted from a fixed off-canvas palette; on placement it visibly expands into one or more steps (a source that unfolds, not an atom) |
| step | a node with two faces: an input port listing the typed slots it reads, an output port listing the typed report it produces |
| step kind | interior glyph, not color: compose is a pen mark, check is a gate bracket, relay is an outward chevron, fanout is a split fork, aggregate is a merge fork, sub-run is a node containing a tiny nested graph |
| route | a directed edge whose endpoints are shaped to the contract; a mismatched shape physically cannot dock |
| typed contract | a shape-coded payload chip riding the route, labeled with its schema id (for example `flow.brief@v1`); shape is the type, label is the name |
| report | a typed chip that materializes at a step's output port when the step settles, stamped with the producing step id |
| relay | the chevron extrudes a request to a separately-tinted warm worker region off the skeleton; work returns as a chip that re-enters through a gate, so the graph never does the labor |
| skills plus equipment | two markers riding docked to the downstream push: skills is an instruction marker, equipment is an allowed-tool bracket where non-permitted tools are visibly greyed |
| context push | a thick edge carrying settled reports plus skills plus equipment downstream; default, automatic, substantial |
| context pull | a single hairline reverse arrow (about ten times thinner) carrying one named typed slice from one ancestor; an over-broad `*` request bounces off the ancestor's typed surface and drops a finding row |
| check | a gate bracket that runs declared commands and reads real exit status; before-probe red and after-probe green on the same probe |
| trace | a fixed ledger column beside the graph; one immutable timestamped row per event, append-only, tinted by the frozen header |
| evidence and close | the terminal node assembles a receipt by drawing literal back-links to real report chips and trace rows; nothing in it is free text |
| variants | the prompt forks at generation into two or three whole alternative graphs side by side, each a different shape, tagged with cost (differs) and efficacy (about level) |

What carries state versus what is reserved. Each treatment owns exactly one
meaning, so the picture never blurs.

- Color carries one meaning only: run-state, and it is withheld until execution
  begins. The static graph reads in grey, type-coded by shape, never by hue.
- Fill weight and desaturation are reserved for locked or immutable things (the
  frozen header, sealed trace rows). They are hardened, never re-rendered.
- An empty open port is reserved for the one fault state, an unmet read, used by
  starvation and nothing else.
- Edge width carries volume (thick push versus thin pull) and means nothing
  else.

## 3. The beats

Fifteen beats, grouped into five acts. The number is deliberate thoroughness;
some beats can fold if a tighter cut is wanted (see the open choices).

### Act I: setup and literacy

You learn to read the picture before anything happens.

**Beat 1: the prompt, and the freeze.** A run is one natural-language prompt, and
the first thing Circuit does is lock a tiny identity that never changes. On
screen: an empty field, then one soft-edged prompt line drifts in from outside
(the only formless thing we will ever see). A five-slot header crystallizes at
top-left (flow, depth, change_kind, manifest_hash, invocation_id), then a lock
closes and it desaturates. The trace column appears and drops its first row,
`run.bootstrapped`. The soft prompt against the hard locked header sets the two
poles the whole piece lives between, informal input and frozen identity, and
plants both load-bearing rules at once: identity is set once and never moves, and
every change appends one immutable row.

**Beat 2: the vocabulary.** Circuit's material is a fixed vocabulary of
registered blocks; each block expands into typed steps that declare reads and
produces. On screen: a shelf of block tiles slides in. One lifts off and stamps,
expanding into a step node with a shaped input port (top) and output port
(bottom), labeled with contract ids. A few kind-glyphs (pen, gate, chevron, fork)
name the kinds before they act. This is pure visual noun-acquisition, so no
glossary is needed later. Type is geometry. The shelf stays parked at the edge as
a standing reminder that everything generated is composed from this finite
vocabulary, not invented.

**Beat 3: routes wire steps, and mismatches cannot connect.** A route is a typed
contract; a connection exists only where a producing type matches a consuming
slot. On screen: a second step stamps, an edge docks output-to-input and seats
because the shapes match, and a deliberately mismatched edge is attempted and
physically refuses to seat, hanging as a dangling end before being withdrawn. A
labeled chip rides the good route. The bounce-off makes typing a contract you can
watch fail to fit, not a decoration. The viewer can now read any future edge
fluently. This is the literacy that makes every later beat legible.

### Act II: generation and validation

The north-star claim, made trustworthy.

**Beat 4: generation.** Circuit generates a flow built for this exact prompt,
genuine novel composition from the registered vocabulary, not selection from a
menu. On screen: the frozen prompt sends a scan over goal plus header, then
blocks lift from the shelf one at a time and snap into an ordered graph, routes
auto-drawing only where ports match. A counter reads "composed from N registered
blocks," and the shelf depletes only of blocks used. This lands grounded because
beats 2 and 3 already taught blocks, ports, and routes, so generation reads
precisely as choosing and wiring known primitives. The depleting-but-finite shelf
is the coherence guard made visible: the intelligence is in the choosing, the
material is fixed and real.

**Beat 5: the shape decision, including whether to fan out.** Topology is chosen
deliberately (linear, loop, fan-out, or sub-run) as an axis independent of which
blocks were picked. On screen: the just-composed graph shows its topology
labeled, then the same step set re-flows into alternatives. A back-edge folds into
a loop, a node splits into parallel lanes (fan-out is dwelt on), one node thickens
to reveal a nested graph inside (sub-run). The chosen shape snaps to full opacity,
the others ghost. A trace row records the chosen shape. Showing four topologies as
transformations of one persistent step set, not four unrelated diagrams, keeps it
on the single canvas and frames shape as a real decision with fan-out as an
explicit branch of it.

**Beat 6: measure twice, simulate, detect starvation, repair or wall.** Before
anything runs, Circuit simulates the whole flow, finds any step reading something
no upstream step produces, and repairs the composition, or walls honestly if it
cannot. On screen: a scan line sweeps the committed graph before any node
activates. It halts at a step whose input port is drawn open and empty (the
reserved fault state), which is starvation. Repair re-binds an upstream producer
and the port fills. A second, unrepairable read stays open and the step is walled,
refused and marked, never emitted as a fake edge. This converts generation from
impressive to trustworthy. The empty-port primitive from beat 2 pays off:
starvation is just a port with no matching producer, readable at a glance. Showing
the wall is essential, because the guard fails safe, it is not magic that always
succeeds. This act ends on a validated, fully wired, not-yet-running graph.

### Act III: execution and context

The heart: push versus pull.

**Beat 7: cold skeleton, warm labor.** Orchestrator and decision steps run
deterministically with no model; relays hand the actual work to a worker. On
screen: color enters for the first time (reserved precisely for this). A control
token walks the routes, and compose, route, and fanout nodes resolve cold and
instant in place. A relay's chevron extrudes a request to the separately-tinted
warm worker region, which returns a report chip that must pass back through a gate
before it counts. The skeleton lines never warm. Withholding color until now lets
run-state read cleanly against the familiar grey topology, so the viewer is not
relearning the map, just watching it light up. The cold-warm split is the
architectural spine in one perceptual contrast.

**Beat 8: context and skills flow down, the thick push.** Every descendant's
prompt is built automatically from ancestors' settled reports plus the skills and
allowed equipment it needs; the default direction is down, and it is substantial.
On screen: as control reaches the next step, a thick payload travels down the
already-seated route (the edge from beat 3 earning its keep), docked with a skills
marker and an equipment bracket (non-permitted tools greyed). The descendant
visibly loads before it runs. Thickness is the meaning. Bundling skills and
equipment into the same down-arrow teaches that context in Circuit is reports plus
instructions plus permitted tools assembled as one payload, and the bounded
equipment bracket introduces least-privilege without a lecture.

**Beat 9: the one arrow that goes up, the thin pull.** A step that finds itself
short asks one ancestor for one named typed slice and re-runs once, the only thing
that travels upstream, deliberately about ten times narrower. On screen: a running
step stalls. A hairline reverse arrow draws up one route to a single ancestor
carrying one named field, just that slice detaches and returns, and the step
re-runs and completes. Beside it, a second node fires a `*` "everything" request,
which bounces off the ancestor's typed surface and drops a finding row. Staging
this immediately after the thick push lets the asymmetry be measured by eye, not
asserted. The single named slice versus the bounced blob is the whole lesson: the
inverse channel is narrow, named, typed, bounded, and honest. The viewer now holds
the complete context model, heavy automatic down and thin opt-in up, as one
picture.

### Act IV: scale and the honesty of shape

**Beat 10: fan-out and join.** Parallel branches each carry their own goal plus
skills, run concurrently, and merge through an aggregate that keeps the survivors.
On screen: at the fanout node from beat 5 the graph splits into lanes, each
carrying its own goal plus skills marker (a callback to beat 8) and opening its
own warm worker concurrently. A downstream aggregate draws the branch chips in,
keeps survivors, and greys the dropped branch. Shown as the same push mechanism
applied per lane, this reinforces rather than reintroduces. The aggregate
selecting survivors (not blindly merging) previews the honesty theme and sets up
the efficacy finding.

**Beat 11: variants, one prompt, several shapes, cost-real and efficacy-flat.**
One prompt can yield multiple bespoke flows of different shapes, and honestly,
across shapes topology is largely efficacy-flat while cost is real. On screen:
pull back to show the prompt forking at generation into two or three whole
alternative graphs side by side (a lean linear, a fuller decomposed, a loop), each
tagged with a cost meter (visibly different) and an efficacy meter (about level).
The meters fill and the honest finding is shown, not told: cost bars at different
heights, efficacy bars roughly even. The viewer learns to read shape as a cost
choice over an efficacy-flat field, which resists any "bigger is better."

**Beat 12: validity is not efficacy.** A check runs declared commands and gates on
real exit status; passing the gates (validity) is not the same as the work being
good (efficacy). On screen: a gate bracket runs a declared command, the same probe
shows red (defect present) before and green (defect gone) after, and the gate
opens. A validity checkmark lights, a glyph the system can actually emit. Beside
it, a greyed dashed badge labeled "is the work good?" (efficacy) sits
conspicuously unfillable, and the system never colors it in. The hardest
distinction is taught by drawability itself: validity is a glyph Circuit can emit,
efficacy is one it deliberately cannot. The two live in different places and never
share a pixel, so the viewer leaves unable to conflate "ran clean" with "actually
good."

### Act V: trust and proof

A reveal, not new claims.

**Beat 13: every event was already a row, the append-only trace.** Each event
appended exactly one immutable row to the authoritative trace; every other view is
a projection of it. On screen: the view pulls to the trace column that has been
quietly filling since beat 1, now a tall ordered stack. Replay scrubs the run by
reading rows top-to-bottom and the canvas reconstructs as they read; an attempted
edit to a row is rejected; tie-lines connect each on-screen view back to its row.
This is a retrospective reveal, not an introduction. The viewer re-sees the run
they just lived through as the ledger that was always underneath it, which cements
"every view is a projection" as recognition, not a new claim.

**Beat 14: evidence assembled, honesty structural.** The terminal step assembles
the receipt from real reports linked to their sources; a run cannot claim complete
if a stop was taken, it auto-downgrades. On screen: the terminal node gathers
report chips into a receipt, each line drawing a back-link to its trace row (an
unsourced line simply cannot render). A clean run seals complete; an alternate take
where a stop row exists shows the badge mechanically flip from complete to stopped.
The outcome is shown being computed from immutable rows, not typed on, so the run
cannot lie about itself. Honesty reads as a structural consequence, not a policy.

**Beat 15: seal and replay, done is provable.** A single close event seals the
trace into an immutable, replayable artifact; re-running yields bit-identical
state. On screen: a close row drops and a seam seals the column, a post-close write
bounces off, then the sealed trace plus frozen header replay from the top, the
whole graph from beats 4 through 14 reconstructs in fast-forward, and the result
lands bit-identical atop the original with zero drift. The final frame holds it all
at once: locked header, generated-and-repaired graph, cold and warm states,
thick-down and thin-up arrows, gates, validity-yes and efficacy-greyed, sealed
trace. The bit-identical rebuild ties every prior beat together, because it only
reproduces when the skeleton was cold, the bootstrap was frozen, and the trace is
authoritative. The piece ends where it began, on one field, now proven to
regenerate itself. The feeling that lands: intelligent composition you can trust.

## 4. Why this order

The sequence is the order in which understanding becomes possible, each beat
earning the next. You cannot read generation (4) until you can read blocks, typed
steps, and routes (2 and 3), so the vocabulary comes first and generation arrives
already grounded as choosing and wiring known parts. Shape (5) is separated from
generation so the viewer sees topology as its own axis. Repair (6) immediately
answers the doubt that free generation plants ("could it build a broken graph?")
and answers it before any cost is spent, which is what converts impressive into
trustworthy. Only then does the graph run (7), and execution is taught two-speed
first so push and pull (8 and 9) have somewhere to live; pull is staged directly
against push so the asymmetry is felt, not stated. Fan-out (10) reuses push rather
than re-teaching it, variants (11) reframe beat 5's shapes as a measured economic
choice, and the check (12) lands the one distinction the whole thesis rests on. The
trust trio (13 through 15) comes last because it is a reveal: the viewer has
personally watched every event, so "it was all one append-only ledger" is
recognition, and "it replays bit-identical" is the proof of everything that came
before. By the final frame the viewer can redraw the system from memory, which
means they understand it.

## 5. Coherence guards

The few rules that keep it honest and un-magical even with the north star assumed
realized.

- Composition over a real typed vocabulary, never arbitrary invention. Every
  generated step is sourced from a visible, finite, depleting block shelf, and
  routes only seat where contract shapes match. Generation is shown as constrained
  choosing, never as parts conjured from nothing.
- Repair fails safe. The look-ahead is shown walling an unrepairable read, not just
  succeeding, which proves it is a guard, not magic that always wins.
- Validity is not efficacy, and they never share a location or a treatment. Validity
  is a glyph the system can emit; efficacy is the one badge it structurally cannot
  fill in. Keeping efficacy undrawable is the guard against the deepest over-claim.
- Trace append-only, evidence structural, replay bit-identical. Rows only accrete
  and reject edits; receipt lines cannot render without a back-link to a source; the
  outcome is computed from the rows (complete auto-downgrades to stopped); replay
  overlays with zero drift.
- Staying metaphor-free, the real trap. The danger is that the abstract visual
  language quietly becomes a metaphor (a thick arrow feeling like a pipe, a worker
  region feeling like a factory). The rule that prevents it: every primitive must be
  defensible as literally the entity, not a likeness of it. A thick edge is wide
  because the payload volume is large (a real, measurable property), not because
  data flows like water; the warm region is a separate tint because the worker model
  is a genuinely separate executor, not because labor is hot. If a primitive's
  justification ever reaches for a likeness instead of a real property, it has
  drifted and must be redrawn.

## 6. Open choices

Genuine forks where taste should decide.

- Variant prominence. Variants (beat 11) can be a quick pull-back that names the
  cost-real and efficacy-flat finding and moves on, or a dwelt-on beat that lets the
  meters fill slowly. More prominence sells genuine generation harder, less keeps
  the single-object spine tighter. This is the call on how loudly to feature the
  north-star claim.
- Trace, always-visible versus revealed. The trace can sit beside the graph from
  beat 1 (accruing in view the whole time, honesty foregrounded) or stay nearly
  invisible until the beat 13 reveal (the "it was always underneath" recognition
  hits harder). The current fusion shows it from beat 1 but quiet; the reveal still
  works. Pick which payoff you want.
- Degree of abstraction. Ports-as-shaped-geometry and contract chips can be drawn
  crisply schematic (more legible, more diagram) or softened toward something
  warmer. Higher abstraction reads as rigorous and on-brand, lower reads as
  inviting. This sets the whole aesthetic register.
- The two counterfactual moments (variants in 11, the stop-downgrade alternate take
  in 14). These are the only places the single-continuous-object discipline bends to
  show a road not taken. Decide whether to keep both as explicit alternate takes that
  re-converge onto the one live object, or cut the beat 14 alternate and convey the
  downgrade by narration only, preserving an unbroken single timeline at the cost of
  one vivid honesty image.

## Provenance

Produced from a grounded read of Circuit's real mechanics and vocabulary
(`UBIQUITOUS_LANGUAGE.md`, `docs/contracts/`, the composition sources under
`src/flows/`, and the context-pull run reports), then a design pass that generated
four metaphor-free organizing spines and synthesized the strongest into the beats
above. An earlier metaphor-based exploration (transit map, circuit board,
assembly line, dataflow graph, orchestral score) was set aside in favor of
communicating the mechanisms directly.
