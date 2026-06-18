# Idea: on-demand context pull — a step queries its parent(s) for context

> Status: **spiked offline; no live channel yet.** Written 2026-06-16; status
> updated 2026-06-17. The runtime-binding sibling of deep fork (iii) (adaptive
> bubble-up-recompile): where recompile lets a step bubble up a *discovery* and
> re-plan, this lets a step bubble up a *request for context* and have it answered.
>
> A pure-function offline demonstrator now exists (PR #107,
> `experiments/flow-lab/context-pull-demonstrator.ts` + `.test.ts`, built the same
> way as the recompile Step 0 demonstrator — no model calls, no engine seam,
> throwaway). It scores three envelope strategies on the same need and measures
> thin-plus-pull reaching fat-push completeness (zero starvation) at **29 carried
> bytes vs 293 — about a 10x reduction — with zero irrelevant bytes**. The
> conservative defaults below all hold under test: no `*` "everything" query, a
> bounded per-step pull budget, and a legible per-pull trace. The finding: the trade
> is worth pursuing, and the typed-lookup first cut is enough to prove it before any
> semantic/retrieval machinery. **No live/`src/` query channel was built** — that is
> sequenced after the live recompile work (Step 3 and beyond) matures.

## The idea in one line

Default each step to a minimal, focused context envelope, and let it **pull more from
its parent(s) on demand** through a typed, queryable surface — instead of pushing a
fixed envelope decided entirely at assembly time.

## Why (the context-sizing tension it dissolves)

The context scope (one of the four micro-harness axes) is decided up front today: the
assembler picks what a step sees before it runs. That forces a bad trade — too little
context and the step is starved; too much and it loses the focus that makes a tightly
scoped step valuable. You often cannot know the right amount until the step is running
and hits the edge of what it was given.

A pull channel dissolves the trade: under-provision by default (focus, lower cost, less
distraction), and let the step ask for more only when it discovers it needs it. Focus
*and* completeness, resolved at runtime — the "balance between whole and chopped
determined at runtime" the operator was reaching for.

It also partly dissolves the **chop/hold** dilemma: you can chop more aggressively if a
chopped step can recover the context it turns out to need. That may be *why* the grain
experiment came back null (see `grain-experiment-deferred.md` and the grain run report)
— there is no fixed right answer to chop-vs-whole because the right answer is dynamic,
and a pull channel is one way to make it dynamic.

## Not exotic — known patterns in new clothes

- **Lazy loading / demand paging:** start minimal, fault more in on demand.
- **Agent-directed retrieval:** the step asks for what it needs instead of being
  pre-stuffed (RAG, but driven by the step rather than a fixed pre-fetch).
- **Lexical scope / closures:** an inner scope references names from the enclosing
  scope on demand instead of copying everything in. The closest mental model — the
  parent's context is the enclosing scope; the step references it as needed.

## The hard part — the discipline of the query channel

This is what decides whether the idea is great or a mess. The entire value of scoping is
focus and isolation; a step that can freely ask its parent for "everything" just
re-imports the blob the scoping was meant to escape. So the channel must not be "give me
anything":

- **The parent exposes a typed, declared queryable surface** — "here is the structured
  set of things you may ask me for." The child queries within that. The queryable
  surface is itself a contract, so the seam discipline (you know what crosses each seam)
  is preserved rather than punctured.
- **Every query + its answer is written to the trace**, so "what context did this step
  actually see" stays knowable and the run stays replayable. A runtime-pulled context
  must be as legible after the fact as a statically pushed one.
- **Bounded.** Like the reshape budget, a per-step query budget keeps a step from
  pulling unboundedly; exhaustion degrades to "proceed with what you have" or a finding,
  never an infinite widen.

## Where it fits (rides the existing machinery)

- **"Query the parent" is equipment.** It is a tool injected into a step's scope — the
  same equipment axis (and the same manifest/resolver rails) that scopes any other tool.
  A step is *equipped* with the ability to ask.
- **The queryable context is a typed contract surface.** The parent's outputs are
  already typed seams; the queryable surface is a (possibly richer) declared view over
  them.
- **It is the sibling of runtime equipment injection (Step 2).** Step 2 lets the engine
  inject *equipment* into the remaining steps at runtime; this lets a step pull *context*
  at runtime. Same upward channel, same "bind it at runtime" frontier, different payload
  — which is why it sequences naturally *after* the runtime-binding work, not as a detour.

## The cheap first cut (if pursued)

Do **not** build a retrieval engine first. The parent steps' outputs are already a
structured, typed surface, so the minimal version is a **typed lookup**: "give me parent
step X's output" or "give me the named field Y from a parent contract." Prove that
targeted typed pull is useful before adding anything fuzzy or semantic.

Spike it offline first, exactly as the recompile demonstrator was spiked
(`experiments/flow-lab/`): author a flow with a deliberately thin envelope, fire a
simulated "I need more about Y" query, answer it from the typed surface, and score
whether targeted pull beats a fatter push. Only if the typed lookup proves insufficient
does a richer (semantic/retrieval) queryable format earn its place.

## Conservative defaults

- Default envelope stays **minimal**; pull is the exception, not the norm.
- Queries are **targeted** (a named slice), never "everything"; an "everything" query is
  a smell that the envelope or the chop was wrong, and should surface as a finding.
- Typed lookup before semantic retrieval; offline spike before any engine seam.
- Budgeted + trace-recorded, so it can never silently widen a step back into a blob.

## The broader design space — who provisions context, and from what surface?

The section above is one answer (child-pull, option B below): the step asks when it
starves. But that is only one slice of a larger question, and the battle-test finding
(pull is low-yield because the parent over-provisions) showed the real lever is *who
decides and how context flows*, not just whether a starved child can recover. Two axes
organize the space:

- **Who decides** what a step gets: the assembler (up front), the parent (at handoff),
  the step itself (by pulling), or a dedicated context policy.
- **What surface is queryable**: just the parent's outputs, any ancestor's, or the whole
  run's typed outputs (a shared store).

### The options

- **A — Assembly-time push (today's default).** The assembler fixes each envelope before
  anything runs. Legible and simple, but static: it cannot adapt to what a step discovers
  at runtime, so it over- or under-provisions.
- **B — Child-pull (spiked; the design above).** Thin envelope, and the running step asks
  its parent when it turns out short. Adaptive and legible (typed, traced), but *reactive*
  — starve, then recover with a re-run — and low-yield whenever the parent over-provisions.
- **C — Parent-driven runtime provisioning.** The parent decides and fetches each child's
  context at handoff, asking up its *own* chain when it lacks something. The decision sits
  where the broad view is (the parent decomposed the work) and it skips the re-run — "good
  delegation." Architecturally it moves the context decision from *assembly time* to
  *runtime in the parent*, which is strictly richer (the parent knows more after running
  than the assembler knew up front). The catch: it *relocates* the "how much" judgment to
  the parent rather than removing it, and the parent has the same temptation to over-provision
  defensively — the very thing that made B low-yield.
- **D — Central context manager / blackboard.** A dedicated agent, or a passive typed
  queryable store, that owns context and serves each step out of band — context no longer
  threads through ancestors; any step queries the store. Appeal: one specialized place for
  the "what does each step need" judgment, steps stay clean, the store can dedup/summarize/
  (later) retrieve semantically, and any step can reach anything without it being passed
  down. The tension: an *active, omniscient broker* re-centralizes exactly the context the
  micro-harness thesis works to scope and isolate — to serve everyone it must hold the whole
  picture, so the fat-context problem moves *into* the broker — and it weakens the
  tree-as-legibility (today the typed seams record what crossed each boundary; a broker
  serving out of band makes "what did this step see" a property of the broker's choices
  unless every serve is typed and traced). The *aligned* form of D is the passive one: a
  typed, queryable shared surface (a blackboard) over the run's outputs, with the *deciding*
  still done by a parent or a step and every query + answer typed and recorded — which is
  really just B/C's queryable surface widened from "your parent" to "the whole run."

### The deep fork: hierarchical vs central

Underneath, the space splits on one question: does context flow *through the step tree*
(A/B/C — each level hands down or asks up, across typed seams) or *out of band from a
central source* (D — steps query a shared store)? Hierarchical keeps strong legibility and
replay (the tree itself records what each step saw) and gives the parent the natural
deciding role, but a step can only reach context via its ancestors. Central is more flexible
(any step reaches anything, decoupled from the tree) but re-centralizes context and weakens
the tree-as-record unless the store is fully typed and traced.

### The likely synthesis

These are probably not exclusive. The most defensible shape is a **hybrid**:
parent-driven provisioning (C) as the *primary* (decide well where the broad view is, no
re-run), child-pull (B) as the *fallback* for the genuine runtime needs the parent could
not foresee, both over a **typed, queryable substrate** (the aligned, passive form of D) —
the substrate is the mechanism (the typed surface the spike began, widened to the run), and
the policy is parent-primary + child-fallback. That keeps the seam discipline (every query
typed and traced) while gaining the flexibility (query the run, not just the parent) and
putting the deciding where the knowledge is.

### Status: open fork

This is an open design fork to resolve *before* the next context build. The child-pull
mechanism (B) is spiked and safe but low-yield; C and the passive-substrate form of D are
the higher-leverage directions. The choice of who-decides + what-surface should be made
deliberately and validated the same way everything else was — an offline demonstrator
scoring each shape on the same need — before any live engine seam.

## Sequencing

After the live recompile work (Steps 2–3) lands and the runtime-binding seam is proven,
this is the natural next runtime-binding capability — but the design fork above
(who-decides + what-surface) should be settled first, since it decides *what* the next
context build actually is. Until then: captured, not built.
