import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadJsonSchema, REPO_ROOT, validate } from "./schema.js";

const EXPECTED_VERDICTS = [
  "analysis_ready",
  "audit_complete",
  "clean",
  "closed",
  "coexistence_invalidated",
  "complete_and_hardened",
  "contract_ready",
  "decision_packet_ready",
  "design_holds",
  "design_invalidated",
  "drafts_ready",
  "evidence_sufficient",
  "issues_found",
  "issues_remain",
  "map_complete",
  "needs_adjustment",
  "needs_more_exploration",
  "options_ready",
  "outputs_ready",
  "partial",
  "plan_ready",
  "pressure_complete",
  "queue_adjustment_required",
  "re_envision",
  "ready",
  "reopen",
  "reopen_execute",
  "reopen_plan",
  "repair_again",
  "retriage",
  "reviews_complete",
  "revise",
  "risk_boundary_invalidated",
  "ship_ready",
  "stable",
  "validation_complete",
  "verification_complete",
] as const;

const COMPLETION_COMPLETE_VERDICTS = new Set<string>([
  "analysis_ready",
  "audit_complete",
  "closed",
  "complete_and_hardened",
  "contract_ready",
  "decision_packet_ready",
  "design_holds",
  "drafts_ready",
  "evidence_sufficient",
  "map_complete",
  "options_ready",
  "outputs_ready",
  "plan_ready",
  "pressure_complete",
  "ready",
  "reviews_complete",
  "ship_ready",
  "stable",
  "validation_complete",
  "verification_complete",
]);

const PROTOCOL_VERDICTS: Record<string, string[]> = {
  "adversarial-evaluation@v1": ["decision_packet_ready"],
  "adversarial-pressure-test@v1": ["pressure_complete"],
  "category-survey-fanout@v1": ["outputs_ready"],
  "compile-circuit-files@v1": ["drafts_ready"],
  "cutover-review@v1": ["ready", "revise"],
  "design-review@v1": ["ready"],
  "envision-ratchet@v1": ["needs_more_exploration", "ready", "retriage"],
  "evidence-adjudication@v1": [
    "evidence_sufficient",
    "queue_adjustment_required",
    "risk_boundary_invalidated",
  ],
  "execution-audit@v1": ["partial", "ready"],
  "execution-ratchet@v1": ["partial", "ready", "reopen_plan"],
  "exploration-fanout@v1": ["outputs_ready"],
  "final-review@v1": ["issues_found", "partial", "reopen_execute", "ship_ready"],
  "forensic-flow-audit@v1": ["audit_complete", "closed", "partial", "reopen"],
  "full-verification@v1": ["verification_complete"],
  "inventory-probes@v1": ["outputs_ready"],
  "option-generation@v1": ["options_ready"],
  "parallel-evidence-probes@v1": ["outputs_ready"],
  "parallel-review-fanout@v1": ["reviews_complete"],
  "pattern-mapping@v1": ["analysis_ready"],
  "plan-ratchet@v1": ["ready", "re_envision", "retriage"],
  "plan-review@v1": ["plan_ready", "ready"],
  "quality-gate@v1": ["validation_complete"],
  "regression-contract@v1": ["contract_ready"],
  "seam-proof@v1": ["design_holds", "design_invalidated", "needs_adjustment"],
  "stability-audit@v1": ["audit_complete"],
  "stabilize-ratchet@v1": ["repair_again", "retriage", "stable"],
  "system-map-exploration@v1": ["map_complete"],
  "triage-probes@v1": ["outputs_ready"],
  "verification-audit@v1": ["audit_complete"],
  "workers-execute@v1": [
    "coexistence_invalidated",
    "complete_and_hardened",
    "issues_remain",
  ],
};

function makeJobResult(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    run_id: "run-001",
    circuit_id: "test-circuit",
    step_id: "step-one",
    attempt: 1,
    protocol: "custom-protocol@v1",
    completion: "partial",
    verdict: "issues_found",
    artifacts_written: [],
    files_changed: [],
    tests: [],
    issues: [],
    sandbox_limited: [],
    ...overrides,
  };
}

function makeManifest() {
  return {
    schema_version: "2",
    circuit: {
      id: "test-circuit",
      version: "2026-04-01",
      purpose: "Schema regression coverage",
      entry: {
        signals: {
          include: ["quality_improvement"],
        },
      },
      steps: [
        {
          id: "dispatch-step",
          title: "Dispatch Step",
          executor: "worker",
          kind: "dispatch",
          protocol: "pattern-mapping@v1",
          reads: ["user.task"],
          writes: {
            artifacts: [
              { path: "artifacts/pattern-map.yaml" },
              { path: "artifacts/decision-notes.yml" },
            ],
          },
          gate: {
            kind: "result_verdict",
            source: "jobs/{step_id}-{attempt}/job-result.json",
            pass: ["analysis_ready"],
          },
          routes: {
            pass: "@complete",
            fail: "@escalate",
          },
        },
      ],
    },
  };
}

function getJobCompletedVerdictEnum(eventSchema: Record<string, any>) {
  const clause = eventSchema.allOf.find(
    (entry: Record<string, any>) =>
      entry?.if?.properties?.event_type?.const === "job_completed",
  );

  return clause.then.properties.payload.properties.verdict.enum as string[];
}

describe("schema regressions", () => {
  it("keeps shared verdict enums aligned and sorted", () => {
    const manifestSchema = loadJsonSchema(
      "schemas/circuit-manifest.schema.json",
    ) as Record<string, any>;
    const jobResultSchema = loadJsonSchema(
      "schemas/job-result.schema.json",
    ) as Record<string, any>;
    const eventSchema = loadJsonSchema("schemas/event.schema.json") as Record<
      string,
      any
    >;

    expect(manifestSchema.$defs.verdict.enum).toEqual(EXPECTED_VERDICTS);
    expect(jobResultSchema.properties.verdict.enum).toEqual(EXPECTED_VERDICTS);
    expect(getJobCompletedVerdictEnum(eventSchema)).toEqual(EXPECTED_VERDICTS);
  });

  it("accepts yaml and yml artifact paths in manifest writes", () => {
    const manifestSchema = loadJsonSchema(
      "schemas/circuit-manifest.schema.json",
    );

    expect(validate(manifestSchema, makeManifest())).toEqual([]);
  });

  it("enforces protocol-specific verdict constraints", () => {
    const jobResultSchema = loadJsonSchema("schemas/job-result.schema.json");

    for (const [protocol, verdicts] of Object.entries(PROTOCOL_VERDICTS)) {
      for (const verdict of verdicts) {
        const completion = COMPLETION_COMPLETE_VERDICTS.has(verdict)
          ? "complete"
          : "partial";

        expect(
          validate(
            jobResultSchema,
            makeJobResult({ protocol, verdict, completion }),
          ),
        ).toEqual([]);
      }

      expect(
        validate(
          jobResultSchema,
          makeJobResult({
            protocol,
            verdict: "clean",
            completion: "partial",
          }),
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it("forces completion=complete for completion-implying verdicts", () => {
    const jobResultSchema = loadJsonSchema("schemas/job-result.schema.json");

    for (const verdict of COMPLETION_COMPLETE_VERDICTS) {
      expect(
        validate(
          jobResultSchema,
          makeJobResult({ verdict, completion: "complete" }),
        ),
      ).toEqual([]);

      expect(
        validate(
          jobResultSchema,
          makeJobResult({ verdict, completion: "partial" }),
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it("accepts new job_completed verdicts in event payloads", () => {
    const eventSchema = loadJsonSchema("schemas/event.schema.json");

    const event = {
      schema_version: "1",
      event_id: "evt-001",
      event_type: "job_completed",
      occurred_at: "2026-04-01T12:00:00.000Z",
      run_id: "run-001",
      attempt: 1,
      payload: {
        result_path: "jobs/step-one-1/job-result.json",
        completion: "partial",
        verdict: "reopen_execute",
        attempt: 1,
      },
    };

    expect(validate(eventSchema, event)).toEqual([]);
  });
});

describe("circuit.yaml manifest validation", () => {
  it("rejects legacy entry.command", () => {
    const manifestSchema = loadJsonSchema("schemas/circuit-manifest.schema.json");
    const manifest = makeManifest();

    manifest.circuit.entry = {
      command: "/circuit:test-circuit",
      signals: {
        include: ["quality_improvement"],
      },
    };

    expect(validate(manifestSchema, manifest).length).toBeGreaterThan(0);
  });

  it("rejects expert_command because slash identity is derived from the slug", () => {
    const manifestSchema = loadJsonSchema("schemas/circuit-manifest.schema.json");
    const manifest = makeManifest();

    manifest.circuit.entry = {
      expert_command: "/circuit:test-circuit",
      signals: {
        include: ["quality_improvement"],
      },
    };

    expect(validate(manifestSchema, manifest).length).toBeGreaterThan(0);
  });

  it("accepts a single placeholder entry.usage and rejects free-form usage strings", () => {
    const manifestSchema = loadJsonSchema("schemas/circuit-manifest.schema.json");

    const validManifest = makeManifest();
    validManifest.circuit.entry = {
      usage: "<task-name>",
      signals: {
        include: ["quality_improvement"],
      },
    };
    expect(validate(manifestSchema, validManifest)).toEqual([]);

    for (const usage of ["task", "<Task>", "<task> <scope>"]) {
      const invalidManifest = makeManifest();
      invalidManifest.circuit.entry = {
        usage,
        signals: {
          include: ["quality_improvement"],
        },
      };
      expect(validate(manifestSchema, invalidManifest).length).toBeGreaterThan(0);
    }
  });

  it("all circuit.yaml files validate against manifest schema", () => {
    const skillsRoot = join(REPO_ROOT, "skills");
    const manifestSchema = loadJsonSchema("schemas/circuit-manifest.schema.json");
    const circuitFiles = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(skillsRoot, entry.name, "circuit.yaml"))
      .filter((filePath) => existsSync(filePath));
    const errors: Array<{ filePath: string; errors: string[] }> = [];

    // v3: 3 circuits (run, cleanup, migrate). Was 10+ in v2.
    expect(circuitFiles.length).toBeGreaterThanOrEqual(3);

    for (const filePath of circuitFiles) {
      const relativePath = relative(REPO_ROOT, filePath);

      try {
        const manifest = parseYaml(readFileSync(filePath, "utf-8")) as object;
        const validationErrors = validate(manifestSchema, manifest);

        if (validationErrors.length > 0) {
          errors.push({ filePath: relativePath, errors: validationErrors });
        }
      } catch (error) {
        errors.push({
          filePath: relativePath,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    expect(errors).toEqual([]);
  });
});

describe("surface-manifest schema validation", () => {
  it("accepts the checked-in generated surface manifest", () => {
    const schema = loadJsonSchema("schemas/surface-manifest.schema.json");
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/runtime/generated/surface-manifest.json"), "utf-8"),
    ) as object;

    expect(validate(schema, manifest)).toEqual([]);
  });
});
