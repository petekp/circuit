import type { CSSProperties, ReactNode } from "react";
import { FlowGlyph, type MotifCell } from "@/components/flow-glyph";
import { Wordmark } from "@/components/wordmark";

type Flow = {
  name: string;
  command: string;
  color: string;
  accent: string;
  motif: MotifCell[];
  summary: string;
};

type DiagramStep = {
  label: string;
  short: string;
};

type DiagramFlow = {
  name: string;
  color: string;
  accent: string;
  steps: DiagramStep[];
};

const flows: Flow[] = [
  {
    name: "EXPLORE",
    command: "/circuit:explore",
    color: "var(--flow-explore)",
    accent: "var(--flow-explore-accent)",
    motif: [
      "filled", "empty", "filled",
      "empty", "filled", "empty",
      "filled", "empty", "filled",
    ],
    summary: "Compare paths before the agent commits to one.",
  },
  {
    name: "BUILD",
    command: "/circuit:build",
    color: "var(--flow-build)",
    accent: "var(--flow-build-accent)",
    motif: [
      "empty", "empty", "filled",
      "empty", "filled", "filled",
      "filled", "filled", "filled",
    ],
    summary: "Turn a clear brief into a plan, a change, checks, and review.",
  },
  {
    name: "FIX",
    command: "/circuit:fix",
    color: "var(--flow-fix)",
    accent: "var(--flow-fix-accent)",
    motif: [
      "empty", "filled", "empty",
      "filled", "filled", "filled",
      "empty", "filled", "empty",
    ],
    summary: "Find the cause, make the fix, and keep evidence attached.",
  },
  {
    name: "REVIEW",
    command: "/circuit:review",
    color: "var(--flow-review)",
    accent: "var(--flow-review-accent)",
    motif: [
      "filled", "filled", "filled",
      "filled", "empty", "filled",
      "filled", "filled", "filled",
    ],
    summary: "Review a scoped change against evidence, not guesswork.",
  },
  {
    name: "GOAL",
    command: "/circuit:goal",
    color: "var(--flow-goal)",
    accent: "var(--flow-goal-accent)",
    motif: [
      "empty", "filled", "empty",
      "filled", "empty", "filled",
      "empty", "filled", "empty",
    ],
    summary:
      "Keep a bounded objective moving until it is done, blocked, or needs a decision.",
  },
];

const principles = [
  {
    title: "Process before skills",
    body: "A skill teaches one move. A flow gives the agent a repeatable way to use the right moves in the right order.",
  },
  {
    title: "A better working environment",
    body: "The human stops carrying every thread, prompt, and routine step. The agent gets a clearer path through the work.",
  },
  {
    title: "Evidence stays attached",
    body: "Circuit keeps checks and results with the work, so the agent and operator can see what happened.",
  },
  {
    title: "Judgment still matters",
    body: "Circuit pauses for decisions when they matter, while routine steps can keep moving.",
  },
];

const blocks = [
  {
    name: "Clarify",
    summary:
      "Turn a rough request into a clear task with an outcome, limits, and stop conditions.",
  },
  {
    name: "Frame",
    summary:
      "Set the boundary for the work and decide what evidence will count as done.",
  },
  {
    name: "Gather Context",
    summary:
      "Read the right files and facts before the agent starts guessing or editing.",
  },
  {
    name: "Diagnose",
    summary:
      "Explain what is wrong or unknown before the agent tries to change it.",
  },
  {
    name: "Plan",
    summary:
      "Choose a path, name the risks, and keep the next moves tied to the goal.",
  },
  {
    name: "Act",
    summary:
      "Make or delegate the change inside the boundary the flow already set.",
  },
  {
    name: "Run Verification",
    summary:
      "Run the checks that prove the work, then keep the results attached.",
  },
  {
    name: "Review",
    summary:
      "Take a separate pass over the result and look for missed risks or shortcuts.",
  },
  {
    name: "Human Decision",
    summary:
      "Pause for a clear choice when judgment matters more than automatic progress.",
  },
  {
    name: "Close With Evidence",
    summary:
      "End honestly with what changed, what passed, and what still needs attention.",
  },
];

const blockPool = [
  "Clarify",
  "Frame",
  "Context",
  "Diagnose",
  "Plan",
  "Act",
  "Verify",
  "Review",
  "Decide",
  "Close",
];

const diagramFlows: DiagramFlow[] = [
  {
    name: "Build",
    color: "var(--flow-build)",
    accent: "var(--flow-build-accent)",
    steps: [
      { label: "Frame", short: "Frame" },
      { label: "Plan", short: "Plan" },
      { label: "Act", short: "Act" },
      { label: "Run Verification", short: "Verify" },
      { label: "Review", short: "Review" },
      { label: "Close With Evidence", short: "Close" },
    ],
  },
  {
    name: "Fix",
    color: "var(--flow-fix)",
    accent: "var(--flow-fix-accent)",
    steps: [
      { label: "Frame", short: "Frame" },
      { label: "Diagnose", short: "Diagnose" },
      { label: "Act", short: "Act" },
      { label: "Run Verification", short: "Verify" },
      { label: "Review", short: "Review" },
      { label: "Close With Evidence", short: "Close" },
    ],
  },
  {
    name: "Goal",
    color: "var(--flow-goal)",
    accent: "var(--flow-goal-accent)",
    steps: [
      { label: "Clarify", short: "Clarify" },
      { label: "Frame", short: "Frame" },
      { label: "Human Decision", short: "Decide" },
      { label: "Act", short: "Act" },
      { label: "Run Verification", short: "Verify" },
      { label: "Close With Evidence", short: "Close" },
    ],
  },
];

const agentInstallInstructions = `Please install Circuit for the coding-agent tool I am using in this project.

If this is Claude Code, run:
/plugin marketplace add petekp/circuit
/plugin install circuit@circuit
/reload-plugins

If this is Codex, run:
codex plugin marketplace add petekp/circuit

After Circuit is installed, start with:
/circuit:run <my task>

Use a direct flow only when it is clearly the right fit:
/circuit:explore, /circuit:build, /circuit:fix, /circuit:review, or /circuit:goal`;

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
      {children}
    </div>
  );
}

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16 sm:py-24">
      <section className="flex flex-col gap-10">
        <Wordmark />

        <h1 className="max-w-2xl text-base font-medium leading-tight tracking-tight sm:text-xl">
          Powerful, repeatable work patterns for coding agents.
        </h1>

        <div className="flex max-w-2xl flex-col gap-4 text-[15px] leading-relaxed text-muted-foreground">
          <p className="text-[17px] leading-snug text-foreground">
            Skilled people rarely wing it.
          </p>
          <p>
            They follow a process, choose the right move at the right moment,
            and check the work before moving on.
          </p>
          <p>
            Ad-hoc chat makes you carry that process by hand: the state, the
            next move, the right skill, when to check, and when to pause.
          </p>
          <p className="text-foreground">
            Circuit puts that process into flows: a clearer way for the agent
            to work, and less for you to keep nudging forward.
          </p>
        </div>

        <div className="flex w-full max-w-3xl flex-col gap-5 mt-2">
          <Label>[ Install ]</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-[15px] font-medium tracking-tight">
                Claude Code
              </h2>
              <pre className="bg-[var(--panel)] border border-border text-foreground px-5 py-4 text-[13px] leading-7 overflow-x-auto">
                <code>
                  {`/plugin marketplace add petekp/circuit
/plugin install circuit@circuit
/reload-plugins`}
                </code>
              </pre>
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-[15px] font-medium tracking-tight">
                Codex
              </h2>
              <pre className="bg-[var(--panel)] border border-border text-foreground px-5 py-4 text-[13px] leading-7 overflow-x-auto">
                <code>{`codex plugin marketplace add petekp/circuit`}</code>
              </pre>
            </div>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Start with{" "}
            <code className="px-1.5 py-0.5 bg-muted text-foreground">
              /circuit:run &lt;your task&gt;
            </code>
          </p>
        </div>

        <div className="flex w-full max-w-3xl flex-col gap-3">
          <Label>[ Copy Agent Instructions ]</Label>
          <textarea
            readOnly
            rows={9}
            value={agentInstallInstructions}
            className="max-h-56 min-h-36 w-full resize-y overflow-y-auto border border-border bg-[var(--panel)] px-5 py-4 font-mono text-[13px] leading-6 text-foreground outline-none"
          />
        </div>
      </section>

      <section className="mt-28 flex flex-col gap-10">
        <div className="flex max-w-3xl flex-col gap-3">
          <Label>[ Flows ]</Label>
          <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
            Flows are named ways of working. They give the agent a path through
            the task: what to do first, what to check, and when to ask.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-8 gap-y-12">
          {flows.map((f) => (
            <div key={f.name} className="flex flex-col gap-5">
              <FlowGlyph
                name={f.name}
                color={f.color}
                accent={f.accent}
                motif={f.motif}
                cellSize={25}
              />
              <div className="flex flex-col gap-1">
                <div className="text-[15px] font-medium tracking-tight">
                  {f.name}
                </div>
                <code className="text-[11px] text-muted-foreground">
                  {f.command}
                </code>
              </div>
              <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
                {f.summary}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-28 flex max-w-3xl flex-col gap-10">
        <div className="flex flex-col gap-3">
          <Label>[ Blocks ]</Label>
          <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
            Blocks are the reusable moves inside a flow. Each one has a clear
            job, like clarifying, planning, acting, checking, reviewing, or
            closing with evidence.
          </p>
        </div>
        <div className="flex flex-col border-y border-border">
          {blocks.map((b) => (
            <div
              key={b.name}
              className="flex flex-col gap-2 border-b border-border py-5 last:border-b-0"
            >
              <h3 className="text-[15px] font-medium tracking-tight">
                {b.name}
              </h3>
              <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
                {b.summary}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-28 flex flex-col gap-10">
        <div className="flex max-w-3xl flex-col gap-3">
          <Label>[ Flow assembly ]</Label>
          <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
            A flow is a repeatable path made from smaller blocks. Circuit
            arranges the same reusable pieces in different orders for different
            kinds of work.
          </p>
        </div>

        <div className="flow-composer" aria-label="Flows made from blocks">
          <div className="flow-composer-grid">
            <div className="flow-composer-bank">
              <div className="text-[12px] uppercase tracking-[0.18em] text-muted-foreground">
                Reusable blocks
              </div>
              <div className="flow-composer-pool">
                {blockPool.map((block) => (
                  <span className="flow-composer-pool-chip" key={block}>
                    {block}
                  </span>
                ))}
              </div>
            </div>

            <div className="flow-composer-routes">
              {diagramFlows.map((flow) => (
                <div
                  className="flow-composer-route"
                  key={flow.name}
                  style={
                    {
                      "--flow-color": flow.color,
                      "--flow-accent": flow.accent,
                    } as CSSProperties
                  }
                >
                  <div className="flow-composer-route-name">
                    <span>{flow.name}</span>
                  </div>
                  <div
                    className="flow-composer-sequence"
                    aria-label={`${flow.name} flow blocks: ${flow.steps
                      .map((step) => step.label)
                      .join(", ")}`}
                  >
                    {flow.steps.map((step) => (
                      <span
                        className="flow-composer-step"
                        key={`${flow.name}-${step.label}`}
                        title={step.label}
                      >
                        {step.short}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mt-28 flex flex-col gap-10">
        <div className="flex max-w-3xl flex-col gap-3">
          <Label>[ Why flows ]</Label>
          <p className="text-balance text-[13px] leading-relaxed text-muted-foreground">
            The point is not more ceremony. It is less guessing, less nudging,
            and a clearer path for the agent to follow.
          </p>
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-8">
          {principles.map((p) => (
            <li key={p.title} className="flex flex-col gap-1.5">
              <h3 className="text-[15px] font-medium tracking-tight">
                {p.title}
              </h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {p.body}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-28 pt-8 border-t border-border flex flex-col sm:flex-row gap-2 sm:justify-between text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        <span>[ Circuit ]</span>
        <a
          href="https://github.com/petekp/circuit"
          className="hover:text-foreground transition-colors"
        >
          github.com/petekp/circuit
        </a>
      </footer>
    </main>
  );
}
