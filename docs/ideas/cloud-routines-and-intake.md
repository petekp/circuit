# Circuit under cloud routines, plus Intake flows

Status: `current-proposal`. Created 2026-07-10. Nothing here builds before
the v1 announcement; the launch freeze in
[`docs/release/v1-launch-plan.md`](../release/v1-launch-plan.md) applies.

## Seed

A 2026-07-09 X article by Pierson Marks (Jellypod founder):
"I built a software factory that actually works. Here's what I learned."
Post: <https://x.com/piersonmarks/status/2075361336381555096> (full text via
the fxtwitter mirror at
<https://api.fxtwitter.com/piersonmarks/status/2075361336381555096>).
Roughly 119k views in the first day, with bookmarks at about four times
likes. People are saving it as a how-to, so this shape will be widely
hand-rolled.

His factory has two phases with Linear as the deliberately designed seam
(create work, store work, complete work):

- **Pre-triage**: three scheduled Claude Code Cloud Routines that originate
  work. A daily system health check (PostHog and Vercel MCPs file Linear
  issues), a weekly feedback and session-replay miner (Intercom, PostHog
  replays), and a daily churn forensics loop (Stripe, PostHog, Supabase,
  report to Slack, issues to Linear).
- **Implementation**: an `auto` label on a Linear issue fires a webhook. A
  small self-hosted shim adds auth headers and POSTs to Anthropic, which
  starts a cloud routine session. The routine prompt is one line: fetch the
  issue and run a `/do` skill that walks the whole SDLC (fetch context,
  implement, verify in a browser, open a PR, watch comments). The
  human-in-the-loop is whoever adds the label.

The enabler he singles out: MCP connectors set up through the Desktop app
work in both local and remote sessions, and the whole thing runs on an
existing Claude subscription with no infrastructure.

## What is already settled, and stays settled

Circuit digested this wave before this article. This doc records only the
deltas. Settled ground, not reopened here:

- The factory pattern itself is analyzed and ranked in
  [`flow-ideas.md`](flow-ideas.md) (seeded 2026-07-02 from an earlier
  factory post). Burden of proof, tiered intelligence, and the rejected
  cloud middle manager are all recorded there.
- The webhook and label-trigger family was declined in
  [`popular-workflow-market-scan.md`](popular-workflow-market-scan.md)
  (2026-07-06). That decline holds. Circuit does not build trigger
  infrastructure, webhook receivers, or a resident orchestrator. The user
  brings the trigger; Circuit needs one-line invocability and honest exits.
- Outward writes (tracker sync, Slack reports) are boundary deliveries from
  typed artifacts in the host session, never equipment inside a relay.
  Settled 2026-07-02 in [`flow-ideas.md`](flow-ideas.md).

What the article changes: the trigger question used to be "should Circuit
build event triggers?" (no). The new question is "when a user's factory
fires an unattended host session, does Circuit run correctly inside it?"
That is a deployment context to prove, not a feature to build.

## Delta 1: prove Circuit inside an unattended host session

[`alternative-to-chat.md`](alternative-to-chat.md) already claims the
engine is one CLI, so cron and CI runs are possible. The claim is unproven
on the substrate people are actually adopting: Claude Code cloud routines,
scheduled or webhook-fired, running on a subscription with Desktop-app
connector parity. An unattended session is also where Circuit's floor
matters most. Nobody is watching, so the exit code and the report are all
the caller has.

The pieces that make Circuit factory-grade already shipped:

- The exit-code contract: every non-complete close exits 1, usage errors
  exit 2, and the code answers "did the work complete" without reading a
  transcript (`src/cli/run.ts`, close handling around lines 744 to 770).
  A webhook pipeline can branch on this.
- Relays stay MCP-closed and the host session keeps the connectors, so
  boundary deliveries (posting evidence back to the tracker) reuse the
  routine session's own connector auth. See the worker-isolation record in
  [`flow-ideas.md`](flow-ideas.md).
- The label gate in his design maps directly onto a checkpoint: pre-triage
  files the issue, a human (or a policy) promotes it, the flow pauses at
  decisions the operator reserved.

The proof run (one container-lab style session, same rig pattern as the
first-run lab):

1. Cloud environment setup installs the Circuit plugin and its CLI.
2. A routine prompt drives the host agent to invoke `circuit run` with an
   issue-shaped intent.
3. Relays spawn as subprocesses under the routine sandbox (workers run
   MCP-closed with permissions bypassed; confirm the sandbox allows the
   nested spawn).
4. The run closes; the exit code surfaces to the routine outcome.
5. The host session posts the close digest back to the tracker as a
   boundary delivery through its own connectors.
6. Evidence egress: `.circuit/runs/` lives in the workspace, and a cloud
   workspace is ephemeral. Decide what survives the session: the digest
   posted at the boundary, run artifacts committed on the PR branch, or
   both. This is the one genuinely open design question.

If all six hold, the deliverable is a short recipe doc (routine prompt
template, environment setup, trigger stays user-owned) and the claim in
`alternative-to-chat.md` gets a citation instead of a "possible".

## Delta 2: Intake, a work-creation flow family

Every row in the [`flow-ideas.md`](flow-ideas.md) backlog is
implementation-side: it starts after work exists. Decompose is closest and
still transforms operator input. Nothing originates work from telemetry.
Marks' pre-triage loops do, and his strongest practical advice is to build
that side first because it pays off even if implementation stays manual.
That is also an adoption on-ramp for Circuit: a work-creation flow files
issues, touches no code, and risks nothing.

Intake, sketched: a flow family whose deliverable is evidence-cited work
items in the operator's tracker.

- **Health check**: read error tracking and system diagnostics, file one
  issue per confirmed regression, every issue cites the log lines or
  failing probe that prove it.
- **Feedback mining**: read support threads and session replays, file UX
  issues, every claim cites the replay or thread it came from.
- **Churn forensics**: for each cancellation, correlate payment, usage,
  and replay data into a typed report, then file or bump issues linked to
  the causes found.

The Circuit difference is the check: an issue cannot be filed without its
evidence citation, the same way a fix cannot close without its proof. A
prompt loop files plausible issues; an Intake flow files provable ones.

Shape: boundary ingestion, mirroring the settled boundary delivery. The
host session pulls the telemetry slice at the open (it has the
connectors), relays analyze the pulled data locally, and the host files
issues from the typed report at the close. Workers stay MCP-closed, and no
new engine primitive is obviously needed.

Note for the record: pre-triage is exactly the revisit trigger named in
the shelved per-step read-only MCP mount decision
([`flow-ideas.md`](flow-ideas.md), "Outward comms are boundary
deliveries"): a flow that genuinely needs to read an external system
mid-step. Boundary ingestion is the conservative path that avoids
reopening it. If a real Intake build finds boundary-pulled slices too
coarse, that shelf decision is the designated escalation, read-only mount
first.

Intake enters the stack rank as row 13 in
[`flow-ideas.md`](flow-ideas.md); the ranking rationale lives there.

## Launch narrative material

The article argues Circuit's case in its own words:

- Its implementation step is a skill that walks the SDLC with agents
  "hopefully verifying their work via Playwright or Agent Browser" (Marks).
  Hopefully is the word the evidence gate exists to delete. Nothing in the
  factory can distinguish "PR opened" from "work proven", and he keeps
  humans as PR reviewers because of it.
- His routine prompt carries hand-patched honesty glue: an instruction to
  wait for a payload message that arrives in a race, a guard against
  re-doing work already in progress, a comment prefix so humans can tell
  agent writes from human ones. Exactly the class of process rule the
  codify-and-compound thesis says should be encoded once and enforced by
  an engine, not re-typed into every prompt.
- The bookmark-to-like ratio says this is a copy-me pattern. The `/do`
  skill shape will proliferate hand-rolled, which makes "the factory's
  implementation step, with receipts" a timely frame.

## What this doc does not reopen

No trigger infrastructure, no webhook receiver, no scheduler, no work
queue, no PostHog/Stripe/Intercom connector surface owned by Circuit, no
resident cloud orchestrator. All previously declined with mechanical
reasons ([`popular-workflow-market-scan.md`](popular-workflow-market-scan.md));
the article gives no cause to reopen any of them.

## Sequencing

Post-v1, per the freeze. The proof run is the first move and is one
session of work with an existing rig pattern. The recipe doc follows it.
Intake waits its turn in the backlog behind the top tier. The narrative
material is available to the announcement draft now if wanted.
