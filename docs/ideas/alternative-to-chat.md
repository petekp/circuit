# Circuit: the alternative to chat

A strategy deliverable. Messaging, product, and the long view.

> Drafted overnight on 2026-06-29 for your morning review. Produced by a
> multi-agent exploration (six framings, seven product-concept mandates, five
> adversarial skeptics) plus an editorial and honesty pass against
> `docs/positioning.md`. Everything is labeled shipped, partial, or proposed.
> Nothing here is on a live surface yet, and no copy ships without your
> sign-off. Any "walk away and it runs" framing waits on the Converge push
> decision (see Risks). Two source agents degraded mid-run (the honesty-audit
> skeptic and the beyond-coding concept set); I closed both gaps by hand, so
> the honesty sections below are the conservative result, not an omission.

---

## 1. TL;DR

Chat is the REPL of AI work: live, fast, and gone when the window closes. Circuit's real shift is not a smarter agent. It moves the human from *inside* the loop (you are the orchestrator, the memory, the router, and the only thing checking that "done" is true) to *on* the loop (you author the process once and review the evidence). That is the whole thesis, and the existing landing card "A process, not a chat" is its seed. The single biggest opportunity is to make the run a thing you can read and trust: surface the run folder, the decision pause, and the honest stop as first-class surfaces, because the substrate is already shipped and almost none of it is visible to a normal user. The honest catch, and it is load-bearing: do not say "alternative to chat" unqualified, do not say "it can't fake done," and do not promise "turn your past chats into flows." The defensible claim is narrower and truer. It is where chat-work *graduates* when it must be repeated, scheduled, chained, or trusted by someone who was not watching, and the one genuinely new thing under it all is a gate the worker cannot talk its way past.

---

## 2. The thesis

**Circuit is the alternative to chat-shaped agent work.** Not to the chat box. To the ungoverned conversation as the thing you trust and keep.

Start by being fair to chat. Chat is the right tool for a real and large set of work: exploring an unfamiliar codebase, chasing a novel failure, deciding an approach you have not seen before, trying a thing. That work is one-off and its shape is unknown until you are inside it. For all of that, a chat window with zero setup beats anything you would have to author first. Chat is not the obsolete past. It is the REPL, and you do not stop using the REPL because you learned to write programs.

Now strip chat to its mechanics. It is one linear stream of turns sharing one context window, where the only durable structure in the loop is you. In a chat session you are doing four jobs at once, by hand, in your head:

- **Orchestrator.** Nothing advances until you read the last turn and type the next one.
- **Memory.** You carry the intent across the drift, because the window does not.
- **Router.** You decide which concern the model should be in right now.
- **Verifier.** You are the only thing checking that "done" is actually done.

| The job | In a chat, who does it | In a flow, who does it |
|---|---|---|
| Order the steps | You, every turn | The compiled schematic |
| Hold the intent | You, against the drift | The goal, carried into each step |
| Switch the concern | You, in your head | The relay role and its declared reads |
| Check that it is done | You, by hand | The engine's check, before the run advances |

Every famous failure of agentic chat is a property of this shape, not a defect in the model. Context rot is the cost of one shared window. "It said done but it wasn't" is the cost of having no verifier but you. Work that vanishes when the tab closes is the cost of prose as output. The need to babysit is the cost of you being load-bearing. You cannot prompt your way out of a topology.

A post-chat tool has to take those four jobs off the human. Give work a fixed order the model cannot renegotiate (a schematic compiled ahead of time into a graph the engine walks). Give each concern its own clean context and role (a relay with declared reads, never the full transcript). Make trust mechanical instead of social (a check the engine runs, not a sentence the model types). Make the output a durable typed object instead of a transcript (a run folder you can read, query, and resume).

That is the reframe. **You stop being the runtime. You become the author of the process and the reviewer of its evidence.** You spend attention only where the process is genuinely undecided, at a checkpoint, and you get it back everywhere else.

This only works because of structure, not faith. You do not delegate because the model got more trustworthy. You delegate because the run is **bounded** (hard caps on tries and spend, a continuation loop that by invariant never completes by exhaustion), the steps are **gated** (the engine checks required evidence exists before advancing), and a human checkpoint inside an autonomous body is **fail-closed** (a decision it cannot make stops the run, it does not guess). Trust comes from the shape of the run being legible before you start and the evidence being checkable after.

Two analogies carry this, and I would lead with the first.

**Chat is the REPL. A flow is the program.** A REPL is live, linear, stateful only while you sit there, and the output scrolls away. It is wonderful for exploration and useless for delivery, because nothing is saved or guaranteed. A program is the REPL session made durable, named, and reusable. You explore in the REPL, then you promote what worked into a program. That is the honest relationship between chat and Circuit. Not replacement. Graduation.

**The calculator was already smart enough. The spreadsheet won because it remembered the formula.** Spreadsheets did not make arithmetic smarter. They made it auditable and re-runnable. The leap was the durable formula you could see, re-run on new inputs, and trust without redoing the keystrokes. Circuit's check-and-trace is the audit cell. The schematic is the saved formula. Same work, now inspectable and repeatable.

One honest boundary rides with the thesis everywhere: this pays off when the work repeats or must be trusted. For first-time or fast-changing work, a CLAUDE.md rule is better and a flow is not worth authoring. The assembly line beats the bench only when the work repeats. Saying so is what makes the rest believable.

---

## 3. What "alternative to chat" means for messaging

### The positioning shift

The current landing leads with "The antidote for your ad-hoc, improvised workflow" and names the enemy as "AGENTS.md plus a pile of skill files." That is right but small. It picks a fight with a config file. The bigger and truer enemy is **chat-shaped agent work itself**: the unstructured conversation as the unit you trust and keep.

The shift is to make the existing card **"A process, not a chat"** the spine of the whole product, not one of three feature cards. Today it sits next to "It can't fake done" and "It loops until it's proven." It should be the thesis those other two report into.

Three rules keep this honest under the positioning gate:

1. **Never say "alternative to chat" bare.** Circuit runs on top of chat hosts and delegates every line of coding to a chat-driven worker. "Alternative to chat" read literally is false and the first skeptical run discredits it. Always qualify: alternative to chat-*shaped operations*, the ungoverned session as the unit you keep.
2. **Retire "it can't fake done."** The check guarantees evidence is present, well-formed, and that a command ran and passed. It does not guarantee the content is correct. The honest version is **"it can't skip the proof"** or **"it can't say done until the evidence is on disk."** Smaller. True. Chat cannot match it.
3. **Do not promise "turn your prompts and skills into a flow."** That on-ramp is half-built. There is no path that ingests a chat session and emits a flow. The honest promise is "describe a process, get a runnable typed operation," and even that is local-CLI today.

### The refreshed narrative arc

1. **Name the shape.** You are not your agent's operator. You are its runtime. Order the steps, hold the intent, switch the roles, check the result: four jobs you do by hand in every chat.
2. **Name the three scars.** Context rot. "It said done and it wasn't." Work that vanishes when the window closes. Each maps to one structural fix.
3. **Show the noun-shift.** A chat is a moment. A flow is a thing you keep. From that one shift, everything follows: you can run it on a schedule, resume it tomorrow, feed its output into the next flow, and audit it.
4. **Show the empty chair.** The run finished while you were in a meeting. Here is what it proved, what it could not prove, and the one decision it left for you.
5. **Hold the boundary.** This is for work you repeat or must trust. For a one-off you are still figuring out, open a chat. Circuit is where that chat graduates.

### Copy candidates

**Hero thesis options** (pick one to test, all honest):

- "Chat is the REPL of AI work. Circuit is the program."
- "A chat is a moment. A flow is a thing you keep."
- "Stop being your agent's runtime."
- "Not a smarter agent. A process the agent runs inside, with rules it can't talk its way around." *(already on the page, and the most defensible)*

**The "what makes it different" section** (elevating the seed card):

- *A process, not a chat.* A flow is typed steps compiled from a schematic, so the same work runs the same way every time. Each step gets a clean context, so a long run can't rot the steps after it. Frame, plan, act, verify, review.
- *It can't skip the proof.* Done is not a sentence the agent types. It is a state the engine refuses to write until the evidence is there.
- *It stops at the forks it can't decide.* And it can't skip that stop.

**Taglines / fragments:**

- "A flow has a past you can replay and a future you can schedule. A chat has neither."
- "You cannot schedule a conversation or hand it to a teammate and trust it ran."
- "Run it on a schedule. Resume it tomorrow. Feed its output into the next flow. None of that works with a conversation."
- "Chat is free to start. It gets expensive the moment you have to trust it."

**Banned from every surface** (the positioning gate): anything implying Circuit learns, remembers across runs, compounds, or gets better over time. Anything implying it stores and replays your chat sessions. Anything that reads "verified" as "correct." Any "fleet of agents" or "army of agents" language, which puts Circuit on the hype axis (more agents) instead of its real axis (more structure).

---

## 4. What it means for the product

The substrate is genuinely rich and shipped: flows, checks, context isolation, traces, run folders, sub-runs, fan-out, the until-loop, plus a read-only decision `inbox` and `runs show` / `history query`. The gap is not missing primitives. It is that almost none of it is *visible* from the host, and the durable outputs read like engine internals instead of something a person reviews. The roadmap below surfaces what exists before building anything new.

### Near (this quarter, on today's foundations)

**Run Reader: the run folder as a readable case file.**
*Exists today:* `circuit runs show`, `history query`, an append-only trace plus typed reports and evidence in every run folder, and a close stage that already throws if an upstream report is missing or malformed.
*The gap:* `runs show` reads like a debug log and is CLI-only. Build a host-surfaced view that groups by step and foregrounds each step's claim, the evidence the engine accepted, which role/tools/tier touched it, and the checkpoints where a human decided. Pure presentation over data already on disk. This is the "click a cell, see the formula" moment, and it is the lowest build cost for the highest narrative payoff in the whole roadmap. Design it for a supervisor skimming, not an engineer grepping. Render a failed or stopped run as legibly as a passing one, or it becomes success theater.

**Decision Inbox: the on-the-loop front door.**
*Exists today:* `circuit checkpoints` already discovers every run parked at an operator checkpoint, shows the fork, the choices, and a best-effort staleness probe, and links `circuit resume`. Checkpoints are fail-closed. This is the single most underexposed asset in the codebase relative to the thesis.
*The gap:* It is CLI-only and read-only, one run at a time. Surface it on the host as the place you return to. Let an operator answer a fork inline. Carry enough situated context in each fork to decide it cold. Together with the Run Reader, the inbox *is* the on-the-loop experience: the inbox is "what needs me now," the reader is "what did it prove."

**Bake-off: parallel exploration that returns a verdict.**
*Exists today:* Fan-out and tournament are real and shipped, with per-branch git worktree isolation, a reviewer role, and a rubric. Explore and Prototype already use it. Branch count is hard-capped at 2 to 4.
*The gap:* It lives inside two specific flows, not as a general "send this change to a bake-off" surface, and the losing branches are buried in the trace instead of kept as a diffable set. Surface a host-visible entry and make the comparison a first-class object. This is the strongest immediately demoable proof of post-chat expressiveness, because the engine work is done. Frame the result as "compared with reasons," never "optimal," and keep the branch count visibly small so it does not drift into fleet rhetoric.

### Mid (the next layer)

**Away Run + finish receipt: it ran while you were gone.**
*Exists today:* The until-loop / Converge shape is built and merged to local main (the `iteratesUntilCondition` flag plus `finalize()`, with a generated Converge proven end-to-end via a real connector). The whole engine is one CLI, so cron and CI runs are already possible. `resume` makes long runs resumable. The honesty ledger (open-latch count) and bounded caps are real.
*The gap:* Production Converge triggers and some git wiring are deferred and unpushed. Push it. Give unattended execution a named operator mode with a clear story for what a fail-closed checkpoint does when no human is present (it must hard-stop and queue to the inbox, visibly). Build the finish receipt that reads the honesty ledger. Until it is pushed, the shippable honest version this quarter is "it pauses at the forks it cannot decide," which the existing checkpoint already delivers.

**Promote: turn a run you just did into a flow you keep.**
*Exists today:* A run folder already holds an ordered trace plus the role, tools, and scope each step used. A promote spike has passed as a small adapter.
*The gap:* Build the trace-to-flow projection and ride the existing compile floor to prove the result wires. **This works on a Circuit run, which has a typed trace, not on a raw chat session.** Do not let messaging blur "promote a run" into "turn your past chats into flows." The promoted file is a starting point a human edits, not a certified-good process. This is the "save as macro" moment the whole historical arc points at, and it is the most important on-ramp gap on the thesis.

**Flow File (.flow.md) and Flow Review.**
*Exists today:* `src/flows/composition/flow-file.ts` parses a text file to the same `CompositionRoleSet` and rides the identical generate floor. Three working samples exist. A bad file fails closed with the same floor errors a bad proposal would.
*The gap:* It is git-held and out of the published CLI. Wire `circuit create --from-file` with a contract test and golden-run coverage. Once a flow is a text file, a change to your team's way of working arrives as a reviewable diff in a pull request, which chat structurally cannot offer. Build `circuit flow diff` to render two flow-files as a plain-English semantic diff ("the implementer step lost its hard tool wall," "a verify step was added before close"), not raw YAML. Honest line: this proves a shared flow *compiles* on the receiver's machine, not that it is a good process for them.

### Long (2 to 5 years, the moonshots, each named honestly)

**The trust layer (the strongest moonshot).** The bones are already in the code as internals: the proof-assessment ledger where the *schema itself* forbids a claim from proving itself (worker-produced evidence cannot mark itself `pass`, self-independence evidence cannot pass, runtime-owned evidence kinds must come from the runtime). Lift this to a product surface: a Receipt you can hand to a skeptic, with provenance badges in plain words ("checked by the engine," "reviewed by a separate pass," "the worker's own claim, unverified," "a command that ran"). The honest core is an *independent, audit-grade* evidence record, trusted precisely because it was not produced by the same model that did the work. That is the one thing a host's internal loop structurally cannot say about itself. This gets *more* valuable as models improve and plausible-but-wrong output gets harder to spot-check by reading.

**Process library, not marketplace yet.** A registry where a person or team publishes versioned, installable flow-files. This is gated, hard, by two things that do not exist: an easy on-ramp and an efficacy signal. Ship the efficacy signal *first*: a per-flow evidence rollup computed from run folders (how many real runs, how often it reached proven-done, which checks it tends to trip). Without it, a library is a pile of plausible-looking process, which is the trust problem one level up. **Do not build the marketplace before the on-ramp is easy and there is an efficacy signal.** And know the live risk: an internal finding suggests flow *topology* may be efficacy-flat while per-step judgment is the scarce ingredient, which means a market of shareable shapes could be selling the variable that does not move outcomes. Let the efficacy signal tell you whether shared flows even vary in quality before betting here.

**Horizontal expansion (defer).** The primitive is verifiable-gated-resumable work, not coding, so data pipelines, migrations, and ops are real candidates. But each new domain needs its own verification commands and evidence conventions, and the moment Circuit needs domain-specific engine logic, the "one engine, derive from a catalog" discipline breaks. Defer entirely until the coding band is habitual and measured. Expand only along the literal spine: typed steps, gates, evidence.

**Stop calling it the substrate / OS.** Circuit owns no irreplaceable layer. It is host-agnostic by design, which is good ethics and the opposite of platform lock-in. The honest long claim is a portable *process format* plus a reference engine, a standards play (like a Dockerfile or an OpenAPI spec), not a platform play. Concentrate the roadmap on the three things that get *more* valuable as models improve: proof-carrying claims, typed delegation between steps, and provenance. Let the scaffolding that merely compensates for today's model deficits (shape hints, handoff briefs) stay deliberately shallow so it can erode without taking the thesis with it.

---

## 5. The keystone bets

Three things would most make Circuit *feel* like a true alternative to chat. I would sequence them exactly like this.

### Bet 1: Make the run readable. (Run Reader + Decision Inbox)

This is the keystone, and it is near-term, high-feasibility, and high-leverage. The entire post-chat thesis is output-as-object instead of transcript, and right now the object is invisible. A user only *feels* "a flow is a thing you keep" when reading the kept thing is pleasant. Ship the Run Reader and promote the Decision Inbox to the host in the same quarter. Together they deliver both role changes chat denies you: review the evidence instead of re-reading turns, and decide only at the forks instead of driving every turn. Lowest build cost, highest payoff, near-zero engine risk. Do this first.

### Bet 2: Ship the honest stop. (Push Converge, then build the verdict card)

The single most differentiated artifact Circuit can produce is a sentence chat structurally cannot: *"Goal not proven, caps hit, here is the evidence I do and do not have."* A chat stops when you stop typing. It stops on tired, never on proven. The until-loop's `finalize()` makes "complete" unreachable through exhaustion or any open honesty latch, and that invariant is exactly what licenses walking away. The mechanism is built and merged to local main. The bet is a decision more than a build: push it, wire one real trigger, and render the ledger as a verdict card a human reads. That card, the honest stop, is the ad.

### Bet 3: Ship Promote (a run, not a chat).

The historical arc is "save the steps that worked," and right now the save button does not exist. This is the gap that makes the most beautiful framing in the strategy a check the product cannot cash. A Circuit run already has a typed trace, the promote spike passed as a small adapter, so this is buildable. Ship it narrowly: promote a *run* into a starting flow-file the human edits. Never a chat session. This is what turns the on-ramp story from described to delivered, and it is the honest, in-bounds version of session-to-flow.

If you do only one, do Bet 1. If you do two, add Bet 2. Bet 3 is the one that opens the next chapter of messaging, so it pays for itself the moment you are ready to talk about authoring.

---

## 6. The honest risks

A founder has to trust this section, so here it is straight.

**Where chat genuinely wins, permanently and correctly.** Zero-friction starts. Exploratory one-offs where the shape is unknown until you are in it. Warm, in-context decisions made fast because you were just there. Most daily agent use is one-off or fast-changing, which is the regime the boundary cedes to a CLAUDE.md. Do not contest the high-frequency exploratory surface. Cede it on purpose and win the narrow, underserved job: scheduled, chained, audited, repeated work. "Alternative to chat" is a complement claim, not a replacement claim, and a complement is a weaker market position than it sounds. Own that.

**Where the thesis could be repackaging.** Strip the AI vocabulary and the orchestration substrate (a DAG of typed steps with retries, routes, fan-out, sub-runs, and a run-artifact store) is Airflow, CI, and a decade of workflow engines. The control shapes are not novel. Concede this. The *one* genuinely new thing is the adversarial evidence-provenance gate: a typed rule that the untrusted, self-reporting worker cannot produce its own passing evidence. CI never needed this because CI trusts its own scripts. Circuit needs it because the worker is a capable LLM that lies. Lead the novelty with the gate, not the primitives.

**The "can't fake done" trap.** A green check can launder a plausible-but-wrong result into something the operator trusts *more* because the engine blessed it. That is arguably worse than chat for the exact failure mode it claims to cure, because misplaced confidence is more dangerous than known uncertainty. The independent reviewer is itself a fallible model with no extra capability. So hold the line ruthlessly: every "verified" reads as "evidence present and a command passed," never "correct." The Receipt must foreground what was *not* checked as loudly as what was. The defensible claim is compliance, not correctness: it cannot skip the step or claim it ran a check it did not run.

**The adoption tax.** Authoring cost is the number-one reason Circuit is not worth it, and the moment of reaching for a tool favors chat (immediate, low-effort, present-tense) over authoring (a future-tense benefit against a present cost). Do not compete at the moment of reach. Compete at the moment of institutionalization: capture the process *after* the value is proven (Promote a run), when the amortization math is concrete, not speculative. And lead the funnel with "run a proven flow with zero authoring," not "author your own flow."

**The squeeze.** Hosts move fast. The Claude Workflow tool already offers runtime dynamism for free, maintained by the model vendor. If a host adds a provenance gate to its own orchestrator, the wedge closes. Name this risk plainly rather than hiding it. The defense is being deeply right about two things hosts are *not* incentivized to build: bounded dynamism (an envelope you can read before you run, which hosts reject because they sell expressiveness) and an *independent, cross-vendor* evidence record (which a host's own loop structurally cannot offer about itself).

**The honesty lines we do not cross, ever.** No compounding, learning, or "gets better over time" as a tool property. Any growth is the *human* codifying and reusing a process. No stored-and-replayed chat sessions. No "encode your existing way of working easily" until session-ingest ships. "Validity is not efficacy": the gates passing never means the flow is good. These are not constraints on the pitch. The honesty *is* the differentiator against a market full of overclaim. Break one and the whole positioning loses the thing that makes it trustworthy.

**The unpushed reality.** As of today the until-loop is merged to local main but unpushed, and production Converge triggers are deferred. Any "walk away and it runs overnight" copy runs ahead of the host surface. Until Converge is pushed and wired, message only the shipped floor: "it pauses at the forks it cannot decide." That is real today.

---

## 7. Open questions for Pete

1. **How hard do we narrow the front-door claim?** "Alternative to chat" is juicy but overreaches literally. Do we lead with the bolder framing and qualify in the subhead, or lead with the defensible "a process, not a chat" and let the bigger thesis live in the long copy? My lean: defensible front door, bold thesis underneath.

2. **Do we push Converge now?** Keystone Bet 2 and the entire walk-away story are gated on it. The mechanism is built and proven via a real connector. This is your call per the ship plan. My lean: push it, wire one trigger, because the honest stop is the most differentiated artifact we have.

3. **Which property name do we commit to?** The vocabulary names parts (flow, block, relay) but not the property. "Replayable agent ops," "auditable agentic engineering," "the trust layer." A property name travels without you in the room. The substrate lens favors "programmable"; the market and long-horizon lenses favor "the trust layer." Unsettled and worth deciding.

4. **Do we cede the exploratory surface explicitly, in public?** Saying "for one-offs, open a chat, we are for the work you keep" is honest and builds trust, but it is a smaller claim than competitors make. Are we comfortable putting the boundary on the landing page, or does it stay in the docs?

5. **Promote a run, or wait for a real session-ingest path?** Promote-a-run is buildable now and in-bounds. True session-to-flow is the dream and does not exist. Do we ship the honest narrow version and message it carefully, or hold the on-ramp story until the dream is real? My lean: ship Promote-a-run, message it as exactly what it is.

6. **Is the real wedge a team / compliance buyer, not the solo developer?** The TAM for "stable, high-stakes, must-be-trusted, repeated work" looks more like a team and regulated-process market than a horizontal developer-tool market. That changes who we build the Receipt and the library for. Worth deciding before the long-horizon roadmap calcifies around the wrong buyer.