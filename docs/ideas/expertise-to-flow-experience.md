# Encoding Expertise Into Circuit Flows

Status: design evaluation. Post-v1 product direction; no implementation is
proposed during the launch freeze.

Date: 2026-07-16

## Recommendation In One Paragraph

The strongest full-lifecycle candidate is **Demonstrate, Debrief, Promote**.
Treat it as the leading hypothesis, not an earned build decision.

The operator starts with a real Circuit run that was worth repeating. Circuit
turns the run into an evidence-backed draft, then asks a short set of
contrastive questions: which parts were essential, which were accidents of this
task, what would change on a harder case, which decisions must stay human, and
what proof really defines success. The result is an editable flow draft with
provenance on every important rule. Circuit checks that the draft accounts for
the observed source path, pilots it on held-out work, and publishes it only
after explicit approval. Later run evidence may propose a revision, but it
never edits the flow by itself.

A demonstrated run supplies evidence that a one-shot description lacks, while
the debrief captures reasons that a graph editor cannot. But a Circuit run is
also constrained by the flow that produced it. Before Promote becomes the
front door, a direct study must show that it captures executable expert rules
beyond cloning or configuring the source flow. Until that gate passes, the
honest first build is Guided Remix with Cases First as its proof layer, plus
Process Interview when the user needs genuinely new process logic.

## The Decision

> How might Circuit help a practitioner turn explicit and tacit expertise into
> a process that another agent can run, another person can inspect, and the team
> can improve without losing the original intent?

The decision horizon is the first strong post-v1 authoring experience, with an
architecture that can grow into team-owned flow packs over the following year.

## What Has To Be Captured

Expertise is more than a list of steps. A useful authoring experience must help
the user express all of these:

| Layer | What the expert knows |
| --- | --- |
| Purpose | When this process is worth using and what outcome it serves |
| Inputs | What the process needs before it can start |
| Sequence | The work that usually happens and what depends on what |
| Judgment | The signs that change the route or require a human decision |
| Boundaries | What the worker may do, must not do, and must preserve |
| Equipment | Which tools, skills, context, models, and connectors belong in each step |
| Proof | What evidence must exist before the work may advance or close |
| Recovery | What to try after failure, and when to stop or hand off |
| Output | What the next person or process receives |
| Ownership | Who maintains the process, where it applies, and when it becomes stale |

Current generation is strongest at sequence and execution shape. The largest
gap is the expert judgment around that shape: instructions, examples,
counterexamples, quality criteria, proof expectations, and revision rules.

## Decision Frame

### Goal

Make encoding a proven process feel like teaching a capable colleague, while
still producing Circuit's typed, inspectable, repeatable flow.

### Invariants

- The authored flow, not the authoring conversation, is the durable authority.
- A flow still compiles through the existing schematic and compiled-graph
  boundary.
- Known blocks, typed reports, declared routes, checks, evidence, and
  checkpoints remain visible.
- Structural validity and process quality remain separate claims.
- Every machine inference is visible and carries its source.
- Publishing and every durable revision require explicit operator action.
- The normal experience uses plain work language. It does not require the user
  to know block IDs, schema names, or runtime fields.
- The result can be reviewed, versioned, rolled back, shared, and retired.
- Sensitive run data is redacted before it becomes reusable source material.
- The engine stays flow-neutral. Authoring features do not add flow-specific
  branches to the runtime.

### Non-Goals

- Do not build a new feature before the v1 announcement.
- Do not turn Circuit into an arbitrary TypeScript workflow runtime.
- Do not claim that Circuit learns, improves itself, or proves a process is
  correct.
- Do not build a marketplace before authoring, versioning, and real-run quality
  signals are credible.
- Do not optimize for one-off or rapidly changing work. A rules file or chat is
  often the right tool there.
- Do not use a Circuit-versus-vanilla comparison as the quality bar. Test
  transfer on held-out cases, name the person or check judging the result, and
  report uncertainty instead of letting the author, cases, and verdict form a
  closed loop.

### Primary People

- **Practitioner-author:** knows how the work should be done, but may not know
  Circuit internals.
- **Flow maintainer:** reviews changes, owns versions, and responds when the
  process drifts.
- **Flow user:** invokes the process and needs to understand its cost,
  checkpoints, evidence, and limits.
- **Team reviewer:** decides whether the encoded process is safe and useful for
  other people to adopt.

## Current System And The Real Gap

Circuit already has much of the execution substrate:

| Lifecycle area | What exists | What is missing for expertise encoding |
| --- | --- | --- |
| First draft | [circuit create](../../src/commands/create.md) instantiates a proven family; [circuit generate](../../src/commands/generate.md) proposes a block-level shape from one description | A description does not reliably capture judgment, examples, exceptions, or why a check matters |
| Authoring model | Built-in flows use the [typed authoring model](../flows/authoring-model.md) made from known blocks | The strong internal authoring layers are not a simple public experience |
| Structural checks | Schematic assembly, compilation, catalog checks, route and contract checks, and runnability checks | These show that a flow can run, not that it represents a good process |
| Inspection | [Preview](../../src/cli/preview.ts) can show the flow and its model, effort, and connector choices without spawning work | There is no author-facing semantic view that explains what was inferred, omitted, or changed |
| Publication | [Custom-flow drafts and publishing](../../src/cli/custom-flow-package.ts) exist in a user-global custom home | Team scope, source review, versions, updates, rollback, and retirement are not first-class |
| Operation | A [run folder](../contracts/run.md) records its Trace and any Reports, Evidence, checks, checkpoints, and summary produced during the run | Run evidence does not flow back into a flow-maintenance experience |
| Improvement | History and memory can offer hint-only context; Improve and run-close learning are parked proposals | There is no visible, cited propose-review-republish loop for flow changes |
| Host access | The normal product door is the host agent | Create and generate are still mostly CLI-only and easy for plugin users to miss |

The canonical authoring model is deliberately constrained: authors compose
known blocks into typed definitions, then Circuit compiles them. That is a
strength. The experience problem is how to help someone supply the human
knowledge those definitions need.

## The Full Lifecycle

Every candidate below is judged across the same lifecycle:

1. **Recognize:** notice that a piece of work repeats and is worth encoding.
2. **Gather:** collect the best source material: a run, a playbook, examples, or
   the expert's own explanation.
3. **Elicit:** surface intent, judgment, boundaries, proof, and exceptions.
4. **Model:** turn that knowledge into steps, reports, routes, checks, and
   checkpoints.
5. **Inspect:** let the author understand and edit the proposed process.
6. **Check:** prove that the flow is structurally valid and runnable.
7. **Pilot:** try it on representative work and find missing judgment.
8. **Publish:** assign scope, owner, version, and an explicit release.
9. **Operate:** run it, pause at real decisions, and preserve evidence.
10. **Improve:** use cited run evidence to propose a bounded change.
11. **Retire:** supersede or remove a stale process without erasing its history.

The first five stages capture expertise. The next two test it. The last four
make it an owned product rather than a generated file.

## Design Principles From Adjacent Tools

Several current workflow products reinforce the same lifecycle choices:

- [GitHub Actions](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)
  shows the value of repository-native workflow source, while its [run
  history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history)
  keeps execution logs available for inspection.
- [Zapier's draft and version model](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions)
  keeps edits separate from the live workflow, while
  [run history](https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history)
  brings real execution data back into debugging.
- [Power Automate's narrated recorder](https://learn.microsoft.com/en-us/power-automate/desktop-flows/create-flow-using-ai-recorder)
  starts from demonstration but still lands in an editor because the generated
  result can omit important actions.
- [Power Automate task mining](https://learn.microsoft.com/en-us/power-automate/task-mining-tutorial)
  shows why several demonstrations are better than one: stable work and real
  variants become visible.
- [n8n's AI workflow builder](https://docs.n8n.io/advanced-ai/ai-workflow-builder/)
  uses conversation to create a visible graph, while
  [past execution debugging](https://docs.n8n.io/workflows/executions/debug/)
  pulls live failures back into the editor.
- [Zapier guided templates](https://help.zapier.com/hc/en-us/articles/43465487495181-Guided-templates)
  let an expert lock invariants while exposing safe choices to adopters.

We infer one shared pattern rather than copying any one product:
generated or observed work should become an editable draft; real runs should
test and improve that draft; publishing should create an explicit version.

## Candidate 1: Process Interview

### Essence

**Tell Circuit how a skilled practitioner thinks.**

The author starts with no prior Circuit run. A host-side interviewer asks about
one concrete recent example, then turns the answer into a process draft. It
does not ask, “Which blocks do you want?” It asks questions a good apprentice
would ask:

- What is the first sign that this process should be used?
- What does a novice usually miss?
- Tell me about a case where the normal path was wrong.
- What evidence makes you comfortable moving on?
- Which judgment would you never delegate?
- What should happen when the expected proof is unavailable?

### Experience

The user chooses “Teach Circuit a process” and gives the job a name. Circuit
asks for a recent successful case and, when useful, a contrasting failure. It
  builds a plain-language expertise card while the conversation continues:
purpose, inputs, usual path, forks, checks, human decisions, limits, and
outputs.

After each section, the user sees what Circuit believes and can correct it.
Only then does Circuit map the card onto known blocks and compile a draft. Any
idea that does not fit the block catalog appears as an unresolved capability
gap instead of being silently flattened.

The user performs a tabletop walkthrough on two hypothetical cases, pilots the
flow on real work, and publishes a version. Later exceptions reopen the same
expertise card, with the failing run cited beside the proposed edit.

### Unique Advantages

- Works before the user has ever run Circuit.
- Captures reasons, standards, and exceptions better than a one-line prompt.
- Uses the expert's language and can hide authoring internals.
- Works well for an existing runbook, review policy, or team ritual that is
  already understood but not automated.
- Creates a reusable “expertise card” that remains useful even if the eventual
  schematic changes.

### What Gets Harder

- People describe the process they wish they followed, not always the process
  they actually follow.
- A long interview recreates the authoring tax in conversational form.
- Leading questions can manufacture sophistication that the real process does
  not have.
- Without representative examples, the first pilot may expose large gaps.
- The interviewer needs strong stopping rules; more questions do not
  automatically mean more expertise.

### Must Be True And Fastest Disproof

It must be possible to reach a faithful first draft with a short, focused
conversation. The fastest disproof is a concierge study in which skilled
authors still need to rewrite most of the flow after the first real pilot, or
abandon the interview before completion.

### Fit With Circuit

The existing generate proposer, host question surfaces, typed blocks, and
compilation and validity checks are useful foundations. The missing work is a
richer expertise model, progressive confirmation, source provenance, and a
pilot loop.

### Disqualifier

Do not choose this as the primary experience if the interview feels like
writing a requirements document through a chatbot. Its advantage disappears
when the user has to invent the whole process before receiving value.

## Candidate 2: Demonstrate, Debrief, Promote

### Essence

**Show Circuit a piece of work worth repeating, then explain the judgment
behind it.**

This candidate begins after value exists. A completed Circuit run supplies the
observed sequence, roles, tools, reports, checks, decisions, evidence, and
result. The expert supplies what the trace cannot know: what was intentional,
what was incidental, and how the process should behave next time.

### Experience

At the end of a useful run, the operator may choose “Make this repeatable.”
Circuit creates a private draft and a readable digest of the run. Each proposed
part is marked:

- **Observed:** directly supported by the Trace or a Report.
- **Confirmed:** explicitly stated by the expert.
- **Inferred:** plausible, but still needs a decision.
- **Unknown:** required for a durable flow but absent from the source.

The debrief asks contrastive questions grounded in the run: “This run retried
verification once. Is that a real rule or an accident?” “You approved this
checkpoint. What evidence made the answer safe?” “This command passed. Is it
the real finish line or only one part of it?”

Circuit then compiles an editable draft, checks that it accounts for the
observed source path, and highlights mismatches. The author adds one awkward or
failure case, pilots the draft, and explicitly publishes it. Future run
failures and operator interventions can open a cited change proposal against
the current version.

### Unique Advantages

- Captures practice when the authoring payoff is already concrete.
- Grounds the draft in real evidence instead of a plausible story.
- Surfaces tacit expertise through specific, low-effort comparison questions.
- Uses Circuit's own strongest assets: typed runs, evidence, checks, and a
  compilation and validity boundary.
- Makes the product thesis tangible: work graduates from a one-off run into a
  thing the team can keep.
- Gives maintenance a natural source of truth: later runs can be compared with
  the promoted source and current version.

### What Gets Harder

- One good run mostly shows the happy path and may encode accidental behavior.
- The Trace records what happened, not why the expert chose it.
- The first narrow version can promote Circuit runs, not arbitrary past chats.
- Run folders can contain sensitive paths, prompts, or evidence that must be
  redacted.
- A run may simply be an instance of an existing flow; promotion must discover
  the expert-specific layer instead of cloning generic topology.

### Must Be True And Fastest Disproof

The structured run plus a short debrief must contain enough information to
produce a materially better draft than a plain task description. The fastest
disproof is a set of real promotions where the result is usually a renamed
built-in flow, or where the debrief remains as long and abstract as the Process
Interview.

### Fit With Circuit

This is the closest fit with current product direction, but only a medium fit
with the present authoring capability. Circuit already owns the run folder,
Trace, Reports, Evidence, checks, checkpoints, compiled flow, and custom-flow
publishing path. A prior promotion spike is [recorded as having
passed](../release/v1-launch-plan.md#deferred-until-after-the-announcement).
The missing pieces are an executable home for expert rules, a faithful
trace-to-draft projection, the debrief and provenance model, a readable editing
surface, pilot evidence, and versioned project/team publication.

### Disqualifier

Do not choose it if the intended authoring market mostly starts from work that
cannot be performed as a Circuit run. In that case the product needs broader
session or artifact capture first.

## Candidate 3: Guided Remix

### Essence

**Start from a process that already works and teach only the difference.**

Instead of a blank page, the user selects a built-in or team-owned flow close
to their intent. The flow owner has marked some parts as fixed invariants and
some as safe choices. The author answers a short setup guide and receives a
derived flow with a semantic diff from its source.

### Experience

The user describes the intended job. Circuit recommends two or three candidate
flows and explains the meaningful differences. After choosing one, the user
works through only the exposed choices:

- Which project proof commands count?
- Which review findings block completion?
- Which tools or local skills belong in each role?
- Which checkpoint can use a default, and which must ask?
- Which outputs should be delivered, and where?

The experience clearly separates inherited rules, local overrides, and locked
invariants. A preview shows the final path and spend choices. A pilot runs with
representative inputs. Publication creates a derived version that points back
to its source. When the source publishes an update, the maintainer receives a
semantic change report and can accept, adapt, or stay pinned.

### Unique Advantages

- Fastest route from intent to a credible first draft.
- Avoids asking every user to rediscover common process structure.
- Lets experienced flow authors protect important checks and expose safe
  variation.
- Fits familiar software habits: fork, configure, diff, pin, update.
- Gives teams a controlled way to share expertise without exposing every
  internal detail.

### What Gets Harder

- The nearest template can pull a process toward the wrong shape.
- Locked decisions can turn yesterday's good practice into dogma.
- Derived flows drift, and upstream updates need a clear merge story.
- A library without real-run evidence becomes a shelf of plausible processes.
- It captures local variation well but is weak at discovering genuinely new
  expertise.

### Must Be True And Fastest Disproof

Most target authors must find a close-enough starting flow, and the meaningful
variation must fit a small set of exposed choices. The fastest disproof is a
study where users repeatedly unlock or replace the supposedly invariant parts,
or choose a template mainly because its name sounds right.

### Fit With Circuit

Create already proves template instantiation, and selection, skills, equipment,
checks, and routes are declared data. The larger missing pieces are author-owned
configuration points, inheritance, semantic diffing, provenance, version
pinning, and an update model.

### Disqualifier

Do not make remix the whole strategy. It lowers cost brilliantly for known
families, but it cannot be the main route for processes whose value lies in a
new decision pattern.

## Candidate 4: Flow Workshop

### Essence

**Give the author direct control over the process model.**

This is the structured editor candidate. A block palette, readable schematic,
report and evidence inspector, route editor, and live validation panel let the
author build or revise a flow directly. It may be visual, textual, or a hybrid;
the defining idea is direct manipulation rather than inferred capture.

### Experience

The author starts blank or imports a generated draft. They place stages and
steps, connect routes, choose each step's role and equipment, declare required
inputs and outputs, define checks, and mark human decisions. The editor
continuously explains:

- what facts are available at this point;
- which route leaves a required report unavailable;
- which evidence a step promises;
- what can write to the checkout;
- what a low, medium, or high process setting changes;
- whether the flow can close honestly.

A simulator walks example cases through the graph. A semantic diff describes
changes in work language, such as “review can now be skipped on this route” or
“verification no longer blocks close.” The flow then goes through pilot,
review, publish, run history, revision, and retirement.

### Unique Advantages

- Maximum legibility and control without requiring raw manifest editing.
- Excellent for teaching the Circuit model and debugging generated drafts.
- Makes hidden contract and route problems visible at authoring time.
- Supports team review, compliance-sensitive processes, and careful change
  control.
- Can become the shared inspection surface for every other candidate.

### What Gets Harder

- A graph is an implementation of expertise, not the expertise itself.
- Authors can perfect topology while leaving step judgment vague.
- The full block, report, route, and evidence model is a large concept load.
- Visual builders become unwieldy around loops, fanout, child flows, modes, and
  report contracts.
- It has high UI cost and risks becoming a second product beside the CLI and
  host agent.

### Must Be True And Fastest Disproof

Authors must gain confidence from direct editing without needing to understand
the engine. The fastest disproof is a prototype where users can manipulate the
graph but cannot explain why the resulting process is better or what its
checks actually prove.

### Fit With Circuit

The generated block catalog and compile-time checks provide unusually good raw
material for this experience. The gap is a stable author-facing model and a
rich editor. The Workshop is valuable as a shared inspection and repair
surface even if it loses as the primary capture surface.

### Disqualifier

Do not lead with it if users experience “encode my expertise” as “learn a
workflow notation.” It should earn its place by making drafts clearer, not by
making authoring look powerful.

## Candidate 5: Cases First

### Essence

**Teach Circuit through representative jobs, expected outcomes, and failure
cases.**

The author does not start by describing a process. They provide a small set of
cases that define what the process must handle: ordinary examples, an awkward
case, a known failure, expected evidence, and the decisions that should remain
human. Circuit proposes the smallest flow that can satisfy those cases.

### Experience

The user creates a “casebook” for the intended flow. Each case contains a task,
the important starting facts, expected outputs, proof commands or review
criteria, prohibited outcomes, and any expected checkpoint.

Circuit groups the cases by common work and meaningful variation. It proposes
a draft and explains which case justifies each route, check, or checkpoint. The
author can challenge the proposal by adding a counterexample: “On this kind of
repository, do not run the migration until the compatibility report is clean.”

The draft compiles, then runs in a safe rehearsal environment. Failures return
to the casebook rather than prompting arbitrary graph edits. Publication stores
the cases beside the flow as regression evidence. When a production run
reveals a missed situation, the maintainer first adds the case, then changes
the flow, reruns the casebook, and publishes a new version.

### Unique Advantages

- Grounds authoring in observable outcomes instead of eloquent process prose.
- Makes exceptions and negative knowledge first-class.
- Creates a durable regression set for future flow changes.
- Keeps structural validity and real usefulness visibly separate.
- Works especially well when the domain has strong external checks, fixtures,
  or reviewable examples.
- Gives reviewers a concrete answer to “Why does this route exist?”

### What Gets Harder

- Good cases are expensive to assemble and may contain sensitive code or data.
- Many expert processes, especially research and design, lack an honest
  deterministic oracle.
- A casebook can overfit the known examples and miss a new class of work.
- Rehearsing write-capable flows needs isolated workspaces and careful spend
  controls.
- Authors may encode surface outputs while omitting the judgment that makes the
  process robust.

### Must Be True And Fastest Disproof

Authors must have representative cases and a credible way to judge them. The
fastest disproof is a trial where users either cannot provide a useful awkward
case or choose checks that reward the wrong behavior.

### Fit With Circuit

Circuit already has typed reports, verification commands, acceptance criteria,
proof evidence, and some worktree-isolation machinery. It has no general
multi-case rehearsal environment. The missing work is the casebook model, safe
rehearsal, result comparison, author-facing diagnostics, and versioned
attachment of cases to flows.

### Disqualifier

Do not use Cases First as the universal front door. Where the work has no
credible external judgment, it risks turning an uncertain craft into a fake
test suite.

## Candidate 6: Flow Pack SDK

### Essence

**Let advanced authors encode process software as code.**

A public TypeScript authoring API exposes known blocks, typed report contracts,
routes, checks, checkpoints, selection, equipment, child flows, and fanout.
Flow packs can later contribute custom schemas, writers, validators, and
readable projectors while execution remains on Circuit's compiled graph.

### Experience

An author creates a repository-native flow package. Their editor provides types
for legal step inputs, outputs, and routes. Local commands compile the source,
run the real catalog and graph checks, preview model and connector selection,
exercise the flow with stub or real cases, and build a versioned pack.

The pack is reviewed like code. Publication records its version and bundle
identity. A run snapshots the exact flow and code identity so resume cannot
continue against changed behavior. Run logs and failed cases become inputs to a
normal pull request that updates the pack and its tests.

### Unique Advantages

- Highest expressive power for engineering teams.
- Fits source control, code review, package ownership, CI, and releases.
- Can represent custom report schemas, validators, and output rendering that a
  simple builder cannot.
- Makes sophisticated reusable flow infrastructure possible without adding
  flow-specific engine branches.
- Provides a precise escape hatch when the guided experience reaches a real
  capability gap.

### What Gets Harder

- Code is a formalization surface, not an expertise-capture surface.
- It brings a high present cost before the user sees the benefit.
- Custom code introduces trust, signing, package identity, resume, and
  portability problems.
- A public API can freeze poor internal concepts if it exposes current types
  too directly.
- It biases the product toward developers who already think like workflow
  engine authors.

### Must Be True And Fastest Disproof

A small stable API must express real flows without leaking most of the compiled
manifest. The fastest disproof is trying to port Review or Fix and discovering
that every useful line needs an internal escape hatch.

### Fit With Circuit

Built-in flows already prove that TypeScript can author typed flow packages,
and the compiler is the right admission boundary. A public authoring facade
still needs its own proof; it is not a current-main capability or a settled
decision.

### Disqualifier

Do not choose this as the primary experience. If “encode your expertise” begins
with installing an SDK, Circuit has failed to lower authoring cost. The SDK is a
power-user layer and extension boundary.

## Candidate 7: Apprentice Mode

### Essence

**Let Circuit notice repeated practice, then ask the expert what should become
durable.**

This is the most ambient candidate. With explicit opt-in, Circuit compares
several runs that share an intent. It identifies stable stages, common
evidence, repeated interventions, and meaningful variations. It proposes a
candidate process only after a pattern appears.

### Experience

The operator marks a small set of runs as related, or Circuit offers a private
candidate based on explicit metadata. A process-mining view separates:

- the stable core that appeared in most runs;
- alternate paths that correlate with different task conditions;
- one-off noise;
- repeated human decisions;
- checks that frequently stop or recover the work;
- missing evidence that repeatedly causes trouble.

The expert adjudicates every finding. Frequent does not mean correct, so no
pattern becomes policy automatically. The approved pattern enters the same
debrief, draft, source-path check, pilot, and publish lifecycle as other
candidates.

After publication, the apprentice compares new runs with the current flow and
may propose a change when the same exception recurs. The proposal cites the
runs and states its uncertainty. The maintainer decides whether to edit,
ignore, or retire it.

### Unique Advantages

- Lowest explicit capture burden once enough runs exist.
- Sees real variation instead of one idealized happy path.
- Can reveal tacit checkpoints and exception handling the expert forgot to
  mention.
- Makes the long-term maintenance loop feel native to actual work.
- Could help teams reconcile several practitioners' versions of the same
  process.

### What Gets Harder

- The product must collect enough comparable runs before it can help.
- Frequent behavior can be wasteful, wrong, or merely caused by current tool
  limitations.
- Pattern mining can erase the reason behind a branch.
- Privacy and surveillance concerns are substantial.
- False suggestions could make the product feel intrusive or untrustworthy.
- Circuit does not ingest broad host-session history today, and it must not
  imply silent learning.

### Must Be True And Fastest Disproof

Repeated Circuit runs must contain enough comparable structure to surface
useful patterns, and experts must trust the capture posture. The fastest
disproof is a corpus study where the suggested stable core is either obvious
and low-value or repeatedly confuses coincidence with policy.

### Fit With Circuit

Run traces, reports, evidence, and history indexes are a promising substrate.
The automatic compare-and-crystallize path does not exist. This candidate needs
the most new product work and the clearest consent, redaction, retention, and
authority model.

### Disqualifier

Do not lead with Apprentice Mode. It has the highest magic and the highest
trust risk. It should follow a successful explicit promotion experience, not
replace one.

## Comparative Evaluation

The ratings below are directional. They use one fixed scale and are not a
numerical score. The dependency column names the condition behind each rating.

| Candidate | Draft speed | Tacit expertise | Author control | Real-world grounding | Team lifecycle | Fit with current Circuit | Delivery ease | Privacy confidence | Main dependency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Process Interview | Medium | Medium-high | Medium-high | Medium | Medium | High | Medium | High | A short interview can recover real judgment |
| Demonstrate, Debrief, Promote | Medium | High | High | High | High | Medium | Low | Medium | A run contains executable expert signal beyond its source flow |
| Guided Remix | Very high | Low-medium | Medium | Medium-high | High | Very high | High | High | A close, proven source flow exists |
| Flow Workshop | Medium-low | Low | Very high | Medium | High | Medium-high | Low | High | The author has already articulated the expertise |
| Cases First | Low-medium | Medium | High | Very high | Very high | Medium | Low-medium | Medium | Credible cases, judges, and safe rehearsal exist |
| Flow Pack SDK | Low | Low | Very high | Medium | Very high | Medium-high | Low-medium | High | A stable public API and trust model exist |
| Apprentice Mode | Low | High | Medium | Very high | High | Low-medium | Low | Low-medium | A consented, comparable run corpus exists |

### Evaluation By Angle

**Human effort.** Guided Remix wins on immediate speed. Promote is next because
the authoring decision happens after value is proven and most questions can be
grounded in the run. Interview and Cases First ask for substantial work before
the first useful flow. The Workshop and SDK move effort into formal authoring.
Apprentice Mode delays effort but also delays value.

**Fidelity to tacit practice.** Promote and Apprentice Mode have the best raw
material because they start from behavior. Promote is safer because the user
chooses the source and immediately explains it. Interview captures reasons but
suffers from recall bias. A Workshop, SDK, or template can encode expertise
precisely only after the author has already articulated it.

**Quality evidence.** Cases First is strongest when an honest case judge exists.
Promote has a real source run and can add cases during pilot. Remix inherits
some confidence from its source, but local fit still needs proof. Compilation
alone leaves Interview, Workshop, and SDK vulnerable to a valid but poor
process. Apprentice Mode has abundant evidence but a hard causal problem:
common behavior is not necessarily good behavior.

**Legibility and control.** The Workshop and SDK win for direct control.
Promote is close if it exposes a clear expertise card, provenance, and semantic
diff. Apprentice Mode is weakest unless its inference trail is excellent.

**Team ownership.** SDK, Workshop, Cases First, and Guided Remix naturally fit
versioned team assets. Promote can match them if publication becomes
project-first, versioned, and reviewable. Current custom publication is
user-global and has no full replace, rollback, or retirement lifecycle.

**Product fit.** Promote best expresses Circuit's core story: a proven piece of
agent work becomes a repeatable process. Remix fits the current create lane.
Interview fits the current generate lane but asks the proposer to understand
more expertise. Workshop and SDK are valuable supporting surfaces. Apprentice
Mode requires a larger product posture change.

**Adoption and demonstration.** Guided Remix is easiest to adopt because the
user starts close to a known answer. Promote has the clearest product proof:
the audience can see one useful run become a reusable team process. Interview
is familiar but less visible, while Workshop and SDK risk making the authoring
mechanism more memorable than the outcome. Cases First is strongest for
high-stakes teams that already invest in test cases. Apprentice Mode may look
magical in a demo, but that promise will outrun trust until explicit promotion
has proved the capture and approval model.

**Technical and trust risk.** Remix is the safest. Interview can stay near the
existing generation lane. Promote preserves the compiled engine boundary, but
still requires a semantic source, redaction, provenance, source-path checking,
safe pilots, and a new version lifecycle. Workshop is a large UI investment.
Cases First requires safe rehearsals. SDK creates code trust and resume
obligations. Apprentice Mode creates privacy, corpus, inference, and authority
risk at once.

### The Right Role For Each Candidate

| Product role | Best candidate |
| --- | --- |
| Leading full-lifecycle hypothesis | Demonstrate, Debrief, Promote |
| Provisional first build | Guided Remix |
| No-run fallback | Process Interview |
| Shared inspection and repair surface | Flow Workshop |
| Strongest validation companion | Cases First |
| Advanced extension surface | Flow Pack SDK |
| Long-term discovery and maintenance bet | Apprentice Mode |

This is not an argument to build seven products. It is a decision about the
primary mental model and the proof needed to earn it. Candidate 2 supplies the
entry path. Candidate 4 supplies an optional inspection surface inside that
journey; it is not the recommendation itself. Guided Remix and Cases First are
the honest first build while Promote is tested.

## Recommendation: Demonstrate, Debrief, Promote

### Product Promise

> Turn a Circuit run worth repeating into a flow your team can inspect, pilot,
> publish, and improve.

The experience should feel like a skilled debrief, not a macro recorder and not
a graph builder.

### Two Claims It Must Not Confuse

1. **Promote a variation of an existing flow.** The run helps configure,
   narrow, or explain a known family. This is close to Guided Remix and fits
   the present catalog boundary.
2. **Promote genuinely new expert logic.** The debrief adds a new decision,
   exception, instruction, proof rule, or recovery behavior that changes what
   the runtime does. This is the valuable claim and the unproven one.

The experience earns the second claim only when one non-trivial expert rule can
travel from expertise card to editable source to compiled bytes to changed
runtime behavior and evidence. If the current authoring model cannot express
that rule, a public Flow Pack or authoring API becomes a prerequisite rather
than a later power-user feature.

### Why It Leads

1. **It attacks the authoring tax at the right moment.** Before a process has
   proved useful, chat or a rules file is cheaper. After a valuable run, the
   benefit of reuse is concrete.
2. **It starts from evidence.** The Trace, Reports, checks, decisions, and
   result constrain what Circuit may infer.
3. **It has a natural way to elicit tacit knowledge.** Specific questions about
   a real decision are easier and more faithful than a blank process interview.
4. **It preserves Circuit's architecture.** The output still compiles into the
   same typed graph. Promotion is an authoring path around the engine, not a new
   runtime.
5. **It creates the missing lifecycle.** The same source-run link supports
   source-path checking, pilot, provenance, versioning, later change proposals,
   and retirement.
6. **It makes the positioning felt.** A one-off run becomes a durable process,
   with the user moving from driving each turn to reviewing a reusable system.

### Why Process Interview Does Not Lead

Process Interview is the runner-up because it can start from an existing
playbook without requiring a prior run. It loses as the primary experience
because it asks the user to pay the full authoring cost up front and relies on
memory. It should remain the fallback when there is no promotable run.

### Why The Others Are Supporting Experiences

- Guided Remix is the provisional first build and the fastest path when a close
  source exists, but it cannot discover a genuinely new process.
- Flow Workshop gives control but makes notation the starting point.
- Cases First is an excellent proof layer but too demanding and domain-limited
  as the universal entry.
- Flow Pack SDK is necessary for extension, not for elicitation.
- Apprentice Mode is a strong later bet but asks for a corpus and a level of
  trust Circuit has not yet earned.

### What Could Change The Recommendation

The recommendation should change if any of these prove true:

- A real promotion study shows that run evidence adds little beyond the
  original compiled flow.
- The debrief remains as long and abstract as starting from scratch.
- Most valuable target processes begin outside Circuit and cannot be captured
  by a narrow run source.
- Users consistently prefer to configure a close template rather than promote
  their own run.
- Privacy constraints make useful run evidence unavailable for reuse.

## Detailed End-To-End Experience

### 0. Recognition

Promotion is available from the run summary, run reader, and an explicit host
request such as “make that process repeatable.” Circuit should not nag after
every successful run.

The affordance appears when there is a plausible reuse signal, such as the
operator marking the run valuable or running a similar intent more than once.
The product states plainly that promotion creates a draft, not a proven flow.

### 1. Choose And Redact The Source

The first version accepts one completed Circuit run. The author chooses which
Reports and Evidence may inform the draft. Circuit identifies likely secrets,
large payloads, personal paths, and task-specific content before any model sees
the promotion bundle.

The source record pins:

- run ID and flow digest;
- final outcome;
- steps and routes actually taken;
- Reports and checks used;
- checkpoints and operator answers;
- selected skills, tools, models, and connectors;
- changed files and verification evidence where allowed;
- explicit exclusions and redactions.

Later versions may add two or more related runs. A raw host-chat transcript is
out of scope until there is a separate consent and capture design.

### 2. Build A Demonstration Digest

Circuit renders the source as a short demonstration digest, grouped by work
rather than raw trace entries. It proposes:

- purpose and trigger;
- inputs;
- stages and steps;
- decisions and routes;
- checks and evidence;
- limits and equipment;
- outputs and handoff;
- unresolved questions.

Every statement has one provenance label: observed, confirmed, inferred, or
unknown. “Observed” links to the run record. “Inferred” can never silently
become policy.

### 3. Run The Teach-Back Debrief

The debrief asks only questions that could materially change the flow. A good
default set is:

1. Which parts of this run should happen every time?
2. Which parts were specific to this task or repository?
3. What would make the process take a different path?
4. Which decision must remain with a person?
5. What evidence is truly required before the flow may say it is done?
6. What failure should trigger retry, recovery, handoff, or stop?
7. What may adopters configure, and what must remain fixed?

Circuit asks follow-ups only when an answer leaves a contradiction or an
unbound decision. It does not turn the debrief into a general consulting
session.

### 4. Produce The Expertise Card

Before showing a schematic, Circuit shows a plain-language contract:

| Section | Content |
| --- | --- |
| Use when | Trigger and intended class of work |
| Do not use when | Boundaries and known bad fits |
| Inputs | Required task, project, evidence, and configuration |
| Process | Named stages and the purpose of each |
| Decisions | Branch conditions, human choices, and safe defaults |
| Proof | Checks and evidence required to advance and close |
| Recovery | Retry, revise, handoff, and stop rules |
| Outputs | Reports, deliveries, and next owner |
| Configurable | Safe adopter choices |
| Fixed | Expert-owned invariants |
| Owner | Maintainer, scope, and review date |

The author approves this card before Circuit maps it to blocks. This separates
the person's intent from one technical representation.

### 5. Compose The Draft

Circuit maps the approved card onto known blocks and the current compiler. It
may reuse a built-in family, compose a new registered shape, or stop on a real
catalog gap.

The mapping rules are strict:

- Never invent a report contract or executable capability to make the draft
  look complete.
- Keep expert guidance, examples, deterministic checks, and human decisions as
  distinct fields.
- Preserve provenance from the expertise card into the draft.
- Prefer the smallest shape that preserves the decisions and proof.
- Do not add stages merely to make the flow look thorough.

The output is a new immutable draft identity. Publishing must use those exact
reviewed bytes. It must never regenerate a different candidate during publish.

### 6. Inspect And Edit

The author receives three synchronized views:

1. **Process view:** the expertise card in work language.
2. **Schematic view:** stages, steps, routes, reports, checks, and checkpoints.
3. **Evidence view:** why each important element exists and what remains
   inferred.

Edits in any view update the same draft. A semantic diff says what changed in
plain language. Raw compiled JSON remains available for debugging, not normal
authoring.

### 7. Check Source-Path Coverage

Circuit performs a zero-spend comparison first:

- Would this draft have accepted the source inputs?
- Which observed steps, decisions, and outputs does it represent?
- Which source evidence satisfies each required check?
- Where would it ask a new question?
- Which observed action has no place in the draft?
- Which draft rule has no support in the source or debrief?

The result is a coverage and fidelity report, not a success verdict. It cannot
predict an unobserved route when that choice depends on a future model report.
The compiler proves that the flow is well formed. The source-path check tests
whether it accounts for what happened once. Neither proves that the process
will work on a new task.

### 8. Pilot On Representative Work

The author supplies at least one new ordinary case and one awkward case when
the work permits it. Read-only flows may run normally. Write-capable pilots
should use an isolated worktree or another explicit safe workspace.

The pilot uses a named human judge or an honest external check. It judges:

- the author's own outcome checks;
- whether the expected evidence appeared;
- whether routes and checkpoints happened at the right moments;
- whether the author had to intervene outside declared checkpoints;
- cost and duration as operational facts;
- what the flow did not prove.

The quality question is not “Did Circuit beat a vanilla agent?” It is whether
the version transfers to held-out work, what the named judge accepted, and how
uncertain that judgment remains. Before a team release, a non-author must be
able to explain the intended decisions and run at least one pilot without the
author reconstructing the process for them.

### 9. Publish A Version

Publish is explicit and project-first. The release records:

- stable flow ID and version;
- owner and intended scope;
- authored source digest and compiled-flow digest;
- source-run provenance;
- pilot cases and their outcomes;
- known gaps and unsupported cases;
- configurable choices and fixed invariants;
- required Circuit and flow-pack API versions.

Personal scope remains useful for private experiments. Team scope should be a
reviewable repository asset. A broader registry comes later.

The currently reviewed draft identity must survive publication exactly. Update,
rollback, unpublish, supersede, and retire are part of the same lifecycle, not
future cleanup.

### 10. Operate With Versioned Evidence

Each run records the exact flow version and digest. The operator summary shows
when a user override, undeclared intervention, repeated retry, or unsupported
case made the run diverge from the intended process.

These are not automatic learning signals. They are evidence a maintainer may
review.

### 11. Propose A Revision

From any relevant run, the maintainer can choose “propose a flow change.”
Circuit creates a new draft against the current published version and cites the
run evidence behind every proposed change.

The proposal returns through the same expertise card, semantic diff,
source-path check, pilot, and explicit publish steps. No run, memory item, or
model-written lesson may directly alter a route, check, checkpoint, or write
authority.

### 12. Supersede Or Retire

A flow can be marked superseded or retired with a reason, replacement, date,
and final version. Old runs remain reproducible against the pinned version.
New invocations receive a clear replacement path instead of silently running
stale expertise.

## The Durable Artifacts

The experience needs several artifacts with different authority. Collapsing
them into one generated prompt would recreate the original problem.

| Artifact | Purpose | Authority |
| --- | --- | --- |
| Promotion source record | Immutable, redacted pointer to the run evidence used | Evidence of what happened once |
| Expertise card | Plain-language intent, judgment, proof, limits, and ownership | Author-approved design intent |
| Flow draft | Structured editable process mapped to known blocks | Proposed process; not live |
| Provenance map | Links rules and routes to run evidence or author decisions | Explanation, not execution authority |
| Casebook | Ordinary, awkward, and regression cases with expected proof | Validation input |
| Validation report | Structural, source-path, and pilot results kept separate | Evidence about one draft |
| Flow release | Versioned source plus compiled manifest and ownership metadata | Live process |
| Change proposal | Cited diff against a published version | Proposed revision; not live |

The state model should be explicit:

| State | Meaning |
| --- | --- |
| Candidate | A run has been selected but no process claim has been approved |
| Draft | An expertise card and editable flow exist |
| Structurally valid | The current compiler and runnability checks pass |
| Source-checked | The draft accounts for the observed path in the selected source run |
| Piloted | Representative cases ran and their gaps are recorded |
| Published | A named version is available to users |
| Superseded | A newer version or flow is preferred |
| Retired | New use is blocked or strongly redirected; old runs stay readable |

“Structurally valid,” “source-checked,” and “piloted” must remain separate
labels. None should be presented as “certified good.”

## Authority And Provenance Rules

The authoring system needs a simple authority ladder:

1. **Run evidence says what happened.** It cannot decide what should always
   happen.
2. **The author says what the process intends.** Their confirmation can turn an
   inference into design intent.
3. **The compiled flow says what will run.** Only declared routes, checks,
   checkpoints, and equipment carry execution authority.
4. **Pilot evidence says what happened on tested cases.** It does not license a
   universal quality claim.
5. **Later run evidence may justify a proposal.** It cannot mutate the
   published flow.

This keeps a memory hint, frequent behavior, or model suggestion from quietly
becoming policy.

## Product Surfaces

### Host Agent

The host agent is the normal interface. It should support:

- “Make this run repeatable.”
- “Show me what Circuit inferred.”
- “That retry was task-specific.”
- “Add this as an awkward case.”
- “Publish this draft to the project.”
- “Propose a change from this failed run.”
- “What changed between versions?”
- “Retire this flow and point users to its replacement.”

The host should narrate in its own voice around Circuit's structured output. It
must not paraphrase away provenance, validation status, cost, or known gaps.

### CLI

A direct CLI remains important for inspectable automation and recovery. The
eventual command family might cover promote, draft show, source check, pilot,
publish, diff, replace, rollback, and retire. Exact command names are a later
surface decision; the lifecycle and immutable draft identity come first.

### Repository

Project-published flow source, cases, ownership, and versions should be
reviewable in Git. The compiled manifest remains generated runtime input.
Personal experiments may stay under the user's Circuit home.

The concrete source syntax is deliberately not chosen here. The experience
needs one semantic authoring model that can support a guided editor and a later
TypeScript SDK. Choosing Markdown, YAML, or TypeScript before proving the
capture model would let file syntax drive the product.

## Technical Shape

The recommended design adds an authoring system around the existing engine:

| Component | Responsibility |
| --- | --- |
| Source reader | Reads a pinned run and selects allowed Trace, Report, Evidence, and checkpoint material |
| Redactor | Removes secrets, task-only payloads, and excluded source before model use |
| Digest builder | Produces the readable demonstration digest |
| Debrief coordinator | Asks bounded, contradiction-driven questions and records explicit answers |
| Expertise model | Stores purpose, decisions, proof, limits, examples, provenance, and ownership |
| Draft mapper | Maps approved intent onto known blocks and reports honest catalog gaps |
| Existing compiler | Continues to own schematic, contract, route, and compiled-flow validity |
| Source-path evaluator | Compares the draft with observed source-run facts without executing work |
| Pilot runner | Executes representative cases in an appropriate safe workspace |
| Versioned flow store | Owns immutable drafts, releases, replacement, rollback, and retirement |
| Revision proposer | Creates cited diffs from later run evidence; never applies them |

The runtime remains unchanged in concept: it receives a compiled flow and
executes it. Promotion, debrief, provenance, source-path checking, versioning,
and revision belong outside the graph runner.

## Current Authoring Integrity Gaps To Fix First

The current custom-flow lane is not yet a safe base for this experience:

1. [Generate's documented review-then-publish
   sequence](../../src/commands/generate.md) runs generation again in the
   [publish implementation](../../src/cli/generate.ts), so the published output
   can differ from the draft the operator reviewed.
2. A manually edited custom draft is reparsed by the [custom-flow package
   loader](../../src/cli/custom-flow-package.ts) and checked for identity and
   flow kind, but does not regain Generate's full checks for an empty or
   unrunnable flow.
3. That same custom-flow package publishes to a user-global location, requires
   an explicit flow root at run time, and has no first-class project or team
   scope.
4. Published slugs in that store cannot follow an update, rollback, unpublish,
   supersede, or retirement lifecycle.
5. The manifest records publication time but not a true flow version.
6. The normal custom draft is compiled JSON. There is no approachable source
   representation between that output and a full built-in [typed flow
   package](../flows/authoring-model.md).
7. The current [composer](../../src/flows/composition/composer.ts) binds
   registered contracts; it does not author new contract bodies. An expertise
   card can therefore describe rules that have no executable home unless the
   authoring boundary grows.

These are not side issues. Exact draft identity and a version lifecycle are
preconditions for asking a user to trust an expertise-authoring system.

## Pre-Mortem

Imagine the recommended Promote experience failed a year after launch.

| Failure mode | Early warning | Prevention |
| --- | --- | --- |
| Promotion mostly clones the source built-in flow | Semantic diffs contain little expert-specific guidance | Run a trace-sufficiency study before building; make the expertise card, not topology, the primary output |
| One demonstration becomes dogma | Awkward pilots repeatedly find missing routes | Require an explicit “task-specific vs reusable” pass and encourage a contrasting case |
| The debrief becomes a long interview | Authors abandon before the first draft | Ask only questions that can change a route, check, checkpoint, equipment rule, or source scope |
| Compilation launders a poor process | Users describe structurally valid drafts as verified | Keep structural, source-path, and pilot statuses visibly separate everywhere |
| Sensitive run data enters the reusable flow | Redactions happen after model processing | Pin, inspect, and redact the source bundle before any authoring relay |
| Expertise view and compiled behavior drift | The card says one thing while the runtime does another | Generate every view from one semantic draft and prove one expert rule end to end |
| Publish releases different bytes | Published digest differs from the reviewed draft | Make drafts immutable and publish by draft ID and digest only |
| Flows become stale but keep running | Repeated overrides and failures accumulate without an owner | Require ownership and review posture; surface stale signals; support supersede and retire |
| Team copies fork beyond repair | Many derived versions cannot accept upstream fixes | Record ancestry, pin versions, and provide semantic update diffs |
| More stages are mistaken for more expertise | Drafts grow while cases and outcomes do not improve | Prefer the smallest flow that preserves decisions and proof; measure interventions, not graph size |

## Must-Be-True Assumptions

| Assumption | Why it matters | How to verify | Fastest disproof |
| --- | --- | --- | --- |
| A Circuit run contains useful expert signal beyond its source flow | Promotion needs evidence that Generate does not already have | Compare source run, source compiled flow, and debrief output across real cases | Promoted drafts are usually renamed copies with no useful expert delta |
| Contrastive questions recover missing intent efficiently | The debrief is the bridge from action to judgment | Concierge promotions with timed debriefs and author correction tracking | The debrief takes as long as a blank-page interview |
| A small held-out case set can expose early transfer failures | Keeps the first pilot attainable without pretending it certifies quality | Pilot on work the source author did not use to define the draft | New tasks routinely require major redesign or undeclared intervention |
| Authors understand provenance and status labels | Prevents false confidence | Usability test the process, schematic, and evidence views | Users equate observed or compiled with approved or good |
| Project-first publication matches real ownership | Expertise is usually shared with the code it governs | Test personal versus project placement with teams | Most useful flows must span projects and project scope feels restrictive |
| The current block and report surface can express common promoted processes | Avoids immediate SDK dependence | Map a varied run sample through the current composer | Important expert decisions repeatedly wall on missing authoring capability |
| Maintainers will act on cited revision proposals | The lifecycle must extend past first publish | Observe the first several exceptions after pilot | Proposals pile up and flows quietly rot |

## Validation Spikes

Run these in order. Each should be allowed to kill or reshape the recommendation.

| Spike | Question | Cost | Success signal | Failure signal |
| --- | --- | --- | --- | --- |
| Trace sufficiency audit | What expert-specific information survives in current run folders? | Small, read-only | Several runs expose meaningful decisions, equipment, proof, or intervention beyond generic topology | Most useful knowledge exists only in surrounding host chat or the author's head |
| Paired concierge study | Does run plus debrief beat one-description Generate and Guided Remix? | Small design study | On held-out work, Promote needs fewer major corrections, captures more expert-specific rules, and needs fewer unplanned interventions | Promote mostly renames or configures the source flow, or needs the same rewrite |
| Executable expert-delta gate | Can one non-trivial expert rule change runtime behavior? | Small technical spike | Expertise card to editable source to compiled bytes produces the intended changed behavior and evidence | The rule remains prose beside an unchanged graph or requires hidden engine code |
| Source-path coverage prototype | Can a draft account for the observed source path without running? | Small technical spike | The tool identifies represented, missing, and unsupported actions and rules without predicting unseen routes | The comparison can only restate the trace |
| Immutable draft publish | Can review and publish preserve exact identity? | Small technical spike | Reviewed and published source and compiled digests match | Publish requires regeneration or hidden mutation |
| Read-only pilot and blind handoff | Does the flow transfer to held-out work and another person? | Medium | A non-author can explain and run an ordinary and awkward case; a named judge records outcome and uncertainty | The author must reconstruct intent or the first new case needs substantial redesign |
| Write-safe pilot | Can a promoted write flow be rehearsed without risking the working checkout? | Medium | An isolated workspace preserves exact evidence and cleanup semantics | Rehearsal changes the parent checkout or hides material behavior |
| Multi-run comparison | Do several runs reveal useful stable and variant behavior? | Medium research | Experts recognize a stable core and can explain meaningful variants | Mining mostly reports noise, cost, or model variance |
| Maintainer revision | Can a non-author safely revise the flow after a real exception? | Medium product study | The maintainer can explain the evidence, propose a bounded change, and preserve scope | They need the original author to reconstruct intent |

## Delivery Sequence

### Phase 0: Compare Capture Models And Prove Executability

Run the same real processes through three concierge arms: Promote, a plain
Generate description, and Guided Remix. Use held-out tasks. Track major author
corrections, expert-specific executable rules, unplanned interventions, and
whether a blind non-author can explain and run the result.

In parallel, prove one non-trivial rule end to end: expertise card to editable
source to compiled bytes to changed runtime behavior and evidence. Do not build
a Promote command until both the run source and the semantic authoring model
prove useful.

The exit rule is explicit:

- If Promote captures executable expert signal beyond the source flow, proceed
  to the conditional Promote slice.
- If it mostly clones or configures the source, make Guided Remix the front
  door, keep Cases First as the proof layer, and use Process Interview for new
  logic. Demonstration remains optional supporting evidence.
- If important expert rules have no executable home, make the Flow Pack or
  authoring API boundary a prerequisite before any Promote slice.

### Phase 1: Shared Draft Lifecycle And Provisional Remix

Build the common integrity work that every candidate needs:

- give every draft an immutable ID and digest;
- publish the exact reviewed draft;
- rerun the full validity and runnability checks after edits;
- add versions, replace, rollback, supersede, and retire;
- define project scope and discovery;
- establish one semantic authoring document above compiled JSON;
- expose Guided Remix as the provisional front door;
- attach a small casebook and named judge to its pilot.

This work improves Create and Generate even if Promote is rejected.

### Phase 2: Conditional Single-Run Promote For Read-Only Work

Only after the Phase 0 gates pass, ship the narrowest honest experience:

- one completed Circuit run;
- pre-model redaction;
- demonstration digest;
- short debrief;
- expertise card;
- current-block mapping;
- compile and check source-path coverage;
- held-out read-only pilots with a named judge;
- a blind non-author explanation and run before team publication;
- explicit, versioned project publication.

Review-like flows are the safest first proving ground. Do not claim raw chat
promotion or automatic learning.

### Phase 3: Cases And Write-Safe Pilots

Add a small casebook, awkward-case prompting, isolated workspaces for
write-capable pilots, and semantic regression reports.

### Phase 4: Team Ownership

Add reviewers, maintainers, ancestry, safe configuration points, reusable
flow-pack distribution, update diffs, and evidence rollups. A library comes
only after these signals exist.

### Phase 5: Cited Revision Proposals

Let a later run propose a bounded change to a published flow. Reuse the exact
draft, source-path check, pilot, and publish lifecycle. Keep proposal-only
authority.

### Phase 6: Advanced And Ambient Authoring

Add the TypeScript SDK for genuine extension needs unless Phase 0 shows it is
already a prerequisite for executable expert rules. Explore multi-run
Apprentice Mode only after explicit promotion is trusted and privacy controls
are proven.

## Success Measures

The first research phase should measure behavior, not set a vanity target:

- time from selecting a run to a structurally valid draft;
- number and severity of author corrections before pilot;
- number of expert-specific rules that change executable behavior rather than
  only adding explanation;
- percentage of draft rules with clear observed or confirmed provenance;
- interventions that happen outside declared checkpoints during pilot;
- held-out ordinary and awkward cases handled inside the intended routes;
- named judge decisions and recorded uncertainty for subjective work;
- whether another practitioner can explain the flow without the original
  transcript;
- whether a non-author can run and safely revise it;
- time from a real exception to a reviewed replacement version;
- stale flows that are superseded or retired instead of silently ignored;
- privacy or redaction failures;
- cases where users mistake structural validity for process quality.

The most important product signal is repeated use by someone other than the
author, with the intended decisions and proof still intact.

## Open Decisions

These decisions should follow the Phase 0 evidence:

1. What is the smallest semantic source format that supports both a guided
   editor and a later TypeScript SDK?
2. How much of the authoring document belongs in the project repository versus
   Circuit's local state?
3. Which run outcomes are eligible as initial promotion sources? The
   recommended first answer is completed runs; stopped and failed runs should
   feed revision proposals later.
4. What is the minimum honest pilot for subjective work with no deterministic
   check?
5. When should Circuit offer promotion without becoming noisy?
6. Which facts can be generalized from a run, and which must always require
   explicit author confirmation?
7. How should team-scoped secrets, connectors, and skill dependencies be
   represented without entering the portable flow?
8. How should a flow release declare that its source evidence or project
   assumptions have gone stale?
9. What must a derived flow inherit from its source, and what can it override?
10. When does a repeated expert decision deserve a deeper internal flow rather
    than a better prompt section and report?

## Decision And Handoff

### Leading Hypothesis And Provisional Build

Use Demonstrate, Debrief, Promote as the leading full-lifecycle hypothesis.
Build Guided Remix first as the fast configuration path, with Cases First as
its proof layer. Keep Process Interview as the no-run and new-logic fallback,
Flow Workshop as an inspection surface, Flow Pack SDK as the extension boundary,
and Apprentice Mode only as a later opt-in discovery layer.

### Critical Workflows

- completed run to redacted promotion source;
- source to digest and debrief;
- approved expertise card to compiled draft;
- immutable draft to source-path check and pilot;
- reviewed draft to exact published version;
- published run exception to cited revision proposal;
- version to replacement, rollback, supersede, and retirement.

### External Surfaces

- host agent actions and structured authoring output;
- direct CLI recovery and automation commands;
- project-owned source, cases, and review diffs;
- personal custom-flow storage;
- compiled flow manifests and trust policy;
- run folders, summaries, history, and checkpoints;
- later flow-pack APIs and team distribution.

### Known Hotspots

- current custom-flow draft and publish identity;
- lack of a middle authoring representation;
- custom flow update and version semantics;
- project discovery and removal of repeated flow-root flags;
- redaction before model use;
- source-path coverage versus true pilot evidence;
- safe write-capable rehearsal;
- subjective quality judgment;
- source and bundle identity across resume;
- stale-flow detection and ownership.

### What Still Needs Proof

The detailed Promote proposal is ready to test, not ready to build. Trace
sufficiency, the paired concierge study, and the executable expert-delta test
are the three gates. Failure does not leave the product without a direction:
Guided Remix plus Cases First becomes the front door, with Process Interview
for genuinely new logic.

## Final Position

Run Phase 0 before designing a Promote command. The winning path is the one that
captures executable expert judgment, transfers to held-out work, and survives a
non-author handoff with its evidence and limits intact.
