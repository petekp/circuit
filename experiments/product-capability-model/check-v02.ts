import assert from 'node:assert/strict';
import { loadCurrentSurfaceInventory } from './current-inventory.ts';
import {
  type CurrentSurfaceInventory,
  type ProductCapabilityCatalog,
  ProductCapabilityCatalogSchema,
  SurfaceKindSchema,
  type SurfaceRecord,
  auditCatalog,
  loadCatalog,
  renderMarkdown,
} from './model.ts';

const repositoryRoot = new URL('../..', import.meta.url).pathname;

function baseInventory(): CurrentSurfaceInventory {
  const surfaces: CurrentSurfaceInventory['surfaces'] = [
    {
      id: 'cli:command:demo',
      kind: 'cli-command',
      state: 'active',
      origin: 'derived',
      reach: [{ channel: 'cli', access: 'direct' }],
      source_paths: ['src/cli/command-vocabulary.ts'],
    },
    {
      id: 'flow:runtime-proof',
      kind: 'flow',
      state: 'active',
      origin: 'derived',
      reach: [{ channel: 'internal', access: 'direct' }],
      source_paths: ['src/flows/runtime-proof/data.ts'],
    },
    {
      id: 'block:queue',
      kind: 'block',
      state: 'dormant',
      origin: 'derived',
      reach: [{ channel: 'internal', access: 'direct' }],
      source_paths: ['src/schemas/flow-block-definitions.ts'],
    },
    {
      id: 'host:claude:hook:stop',
      kind: 'host-hook',
      state: 'active',
      origin: 'derived',
      reach: [{ channel: 'host-hook', host: 'claude', access: 'automatic' }],
      source_paths: ['plugins/claude/hooks/hooks.json'],
    },
  ];
  const populatedKinds = new Set(surfaces.map((surface) => surface.kind));
  return {
    surfaces,
    census_partitions: SurfaceKindSchema.options.map((kind) =>
      populatedKinds.has(kind)
        ? { kind, state: 'populated' as const }
        : { kind, state: 'empty' as const, reason: 'Not needed by this synthetic fixture.' },
    ),
    proof_ids: ['proof:doctor-first-run'],
    public_claim_ids: ['CLAIM-FIRST-RUN-DOCTOR'],
  };
}

function baseCatalog(): ProductCapabilityCatalog {
  return ProductCapabilityCatalogSchema.parse({
    schema_version: '0.2-spike',
    status: 'disposable',
    name: 'Test catalog',
    purpose: 'Exercise the disposable capability model.',
    baseline: {
      target: 'current-checkout',
      note: 'Synthetic fixture for focused checks.',
    },
    vision: [
      {
        id: 'carry-load',
        title: 'Carry the load',
        role: 'lead',
        statement: 'Circuit carries routine process work.',
      },
    ],
    areas: [{ id: 'operations', title: 'Operate Circuit', summary: 'Start and understand it.' }],
    capabilities: [
      {
        id: 'try-circuit',
        area: 'operations',
        title: 'Try Circuit safely',
        outcome: 'Run a real demonstration without touching the current checkout.',
        maturity: 'shipped',
        vision: [{ id: 'carry-load', fit: 'direct' }],
        claims: [
          {
            id: 'demo-is-tested',
            statement: 'The demo uses an isolated project.',
            level: 'tested',
            refs: [
              {
                kind: 'behavior-test',
                path: 'tests/runner/demo-command.test.ts',
                proves: 'The demo creates and uses a separate project.',
              },
            ],
          },
        ],
        attention: [],
      },
      {
        id: 'ambient-continuity',
        area: 'operations',
        title: 'Capture continuity automatically',
        outcome: 'Keep a compact continuation record without a manual save.',
        maturity: 'shipped',
        vision: [{ id: 'carry-load', fit: 'direct' }],
        claims: [
          {
            id: 'ambient-is-tested',
            statement: 'A host hook captures continuity.',
            level: 'tested',
            refs: [
              {
                kind: 'behavior-test',
                path: 'tests/runner/handoff-harvest.test.ts',
                proves: 'A supported host event writes ambient continuity.',
              },
            ],
          },
        ],
        attention: [],
      },
    ],
    supporting_elements: [
      {
        id: 'runtime-isolation',
        kind: 'mechanism',
        title: 'Runtime isolation proof',
        summary: 'An internal flow exercises isolated runtime behavior.',
        maturity: 'shipped',
        supports_capabilities: ['try-circuit'],
        claims: [
          {
            id: 'runtime-proof-is-tested',
            statement: 'The internal flow exercises the runtime contract.',
            level: 'tested',
            refs: [
              {
                kind: 'behavior-test',
                path: 'tests/runtime/runtime-capabilities.test.ts',
                proves: 'The runtime proof surface is exercised without becoming public.',
              },
            ],
          },
        ],
        attention: [],
      },
    ],
    surface_map: [
      { surface: 'cli:command:demo', node: 'try-circuit', role: 'entry-point' },
      { surface: 'flow:runtime-proof', node: 'runtime-isolation', role: 'example' },
      { surface: 'block:queue', node: 'runtime-isolation', role: 'dormant-vocabulary' },
      { surface: 'host:claude:hook:stop', node: 'ambient-continuity', role: 'delivery' },
    ],
    relationships: [],
    boundaries: [],
    review_questions: [],
  });
}

function audit(catalog = baseCatalog(), inventory = baseInventory()) {
  return auditCatalog(catalog, inventory, repositoryRoot);
}

function addSurface(inventory: CurrentSurfaceInventory, surface: SurfaceRecord): void {
  inventory.surfaces.push(surface);
  inventory.census_partitions = inventory.census_partitions.map((partition) =>
    partition.kind === surface.kind
      ? { kind: surface.kind, state: 'populated' as const }
      : partition,
  );
}

function firstCapability(catalog: ProductCapabilityCatalog) {
  const capability = catalog.capabilities[0];
  assert(capability);
  return capability;
}

function firstClaim(catalog: ProductCapabilityCatalog) {
  const claim = firstCapability(catalog).claims[0];
  assert(claim);
  return claim;
}

function firstSupportingElement(catalog: ProductCapabilityCatalog) {
  const element = catalog.supporting_elements[0];
  assert(element);
  return element;
}

const passing = audit();
assert.deepEqual(passing.errors, []);
assert.deepEqual(passing.reach['try-circuit'], ['cli']);
assert.deepEqual(passing.reach['ambient-continuity'], ['claude-hook']);
assert.deepEqual(passing.reach['runtime-isolation'], ['internal']);

const unmappedInventory = baseInventory();
addSurface(unmappedInventory, {
  id: 'host:codex:mcp:circuit_start',
  kind: 'mcp-tool',
  state: 'active',
  origin: 'derived',
  reach: [{ channel: 'mcp', host: 'codex', access: 'direct' }],
  source_paths: ['src/hosts/codex-mcp/contracts.ts'],
});
assert.match(
  audit(baseCatalog(), unmappedInventory).errors.join('\n'),
  /circuit_start.*not dispositioned/,
);

const dormantDelivery = structuredClone(baseCatalog());
const queueBinding = dormantDelivery.surface_map.find((item) => item.surface === 'block:queue');
assert(queueBinding && queueBinding.role !== 'excluded');
queueBinding.role = 'delivery';
assert.match(
  audit(dormantDelivery).errors.join('\n'),
  /dormant surface 'block:queue'.*dormant-vocabulary/,
);

const weakTest = structuredClone(baseCatalog());
firstClaim(weakTest).refs = [
  {
    kind: 'source',
    path: 'src/cli/demo.ts',
    proves: 'The demo implementation exists.',
  },
];
assert.match(audit(weakTest).errors.join('\n'), /tested claim 'demo-is-tested'.*behavior-test/);

const proposedDelivery = structuredClone(baseCatalog());
firstCapability(proposedDelivery).maturity = 'proposed';
assert.match(audit(proposedDelivery).errors.join('\n'), /proposed node 'try-circuit'.*entry-point/);

const unknownProof = structuredClone(baseCatalog());
firstCapability(unknownProof).claims[0] = {
  id: 'demo-release-proof',
  statement: 'The demo passed its release proof.',
  level: 'release-observed',
  refs: [
    {
      kind: 'release-proof',
      proof_id: 'proof:missing',
      proves: 'A nonexistent proof must not count.',
    },
  ],
};
assert.match(audit(unknownProof).errors.join('\n'), /unknown release proof 'proof:missing'/);

const unknownPublicClaim = structuredClone(baseCatalog());
firstClaim(unknownPublicClaim).refs.push({
  kind: 'public-claim',
  claim_id: 'CLAIM-MISSING',
  proves: 'A nonexistent public claim must not count.',
});
assert.match(audit(unknownPublicClaim).errors.join('\n'), /unknown public claim 'CLAIM-MISSING'/);

const hostReachInventory = baseInventory();
for (const surface of [
  {
    id: 'host:claude:command:demo',
    kind: 'host-command',
    state: 'active',
    origin: 'derived',
    reach: [{ channel: 'host-command', host: 'claude', access: 'install-gated' }],
    source_paths: ['plugins/claude/commands/run.md'],
  },
  {
    id: 'host:codex:command:demo',
    kind: 'host-command',
    state: 'active',
    origin: 'derived',
    reach: [{ channel: 'host-command', host: 'codex', access: 'install-gated' }],
    source_paths: ['plugins/codex/commands/run.md'],
  },
] satisfies SurfaceRecord[]) {
  addSurface(hostReachInventory, surface);
}
const hostReachCatalog = structuredClone(baseCatalog());
hostReachCatalog.surface_map.push(
  { surface: 'host:claude:command:demo', node: 'try-circuit', role: 'delivery' },
  { surface: 'host:codex:command:demo', node: 'try-circuit', role: 'delivery' },
);
assert.deepEqual(audit(hostReachCatalog, hostReachInventory).reach['try-circuit'], [
  'cli',
  'claude',
  'codex',
]);

const installReachInventory = baseInventory();
addSurface(installReachInventory, {
  id: 'install:codex-plugin',
  kind: 'install-path',
  state: 'active',
  origin: 'derived',
  reach: [{ channel: 'install', host: 'codex', access: 'direct' }],
  source_paths: ['plugins/codex/.codex-plugin/plugin.json'],
});
const installReachCatalog = structuredClone(baseCatalog());
installReachCatalog.surface_map.push({
  surface: 'install:codex-plugin',
  node: 'try-circuit',
  role: 'entry-point',
});
assert.deepEqual(audit(installReachCatalog, installReachInventory).reach['try-circuit'], [
  'cli',
  'codex',
]);

const reversedOverlap = structuredClone(baseCatalog());
reversedOverlap.relationships.push({
  from: 'runtime-isolation',
  to: 'ambient-continuity',
  type: 'overlaps-with',
  reason: 'Synthetic reverse-order overlap.',
});
assert.match(audit(reversedOverlap).errors.join('\n'), /overlaps-with relationship.*lexical order/);

const undisposedGap = structuredClone(baseCatalog());
undisposedGap.boundaries.push({
  id: 'demo-boundary',
  title: 'Demo boundary',
  rule: 'The demo stays isolated.',
  scope: { kind: 'nodes', ids: ['try-circuit'] },
  refs: [
    {
      kind: 'source',
      path: 'src/cli/demo.ts',
      proves: 'The demo has an isolated implementation path.',
    },
  ],
});
firstCapability(undisposedGap).attention.push({
  id: 'demo-gap',
  kind: 'gap',
  note: 'Synthetic gap.',
  related_nodes: [],
  disposition: { kind: 'boundary', id: 'demo-boundary' },
});
assert.match(
  audit(undisposedGap).errors.join('\n'),
  /gap attention 'demo-gap'.*review question or accepted disposition/,
);

const excludedPublicSurface = structuredClone(baseCatalog());
excludedPublicSurface.surface_map[0] = {
  surface: 'cli:command:demo',
  role: 'excluded',
  reason: 'Synthetic omission.',
};
assert.match(
  audit(excludedPublicSurface).errors.join('\n'),
  /active public surface 'cli:command:demo'.*cannot be excluded/,
);

const hiddenPublicSurface = structuredClone(baseCatalog());
const hiddenDemo = hiddenPublicSurface.surface_map.find(
  (item) => item.surface === 'cli:command:demo',
);
assert(hiddenDemo && hiddenDemo.role !== 'excluded');
hiddenDemo.role = 'proof';
assert.match(
  audit(hiddenPublicSurface).errors.join('\n'),
  /active public surface 'cli:command:demo'.*entry-point, delivery, or control/,
);

const docsDeliveryInventory = baseInventory();
addSurface(docsDeliveryInventory, {
  id: 'public-claim:CLAIM-FIRST-RUN-DOCTOR',
  kind: 'public-claim',
  state: 'active',
  origin: 'derived',
  reach: [{ channel: 'docs', access: 'direct' }],
  source_paths: ['docs/release/claims/public-claims.yaml'],
});
const docsDeliveryCatalog = structuredClone(baseCatalog());
docsDeliveryCatalog.surface_map.push({
  surface: 'public-claim:CLAIM-FIRST-RUN-DOCTOR',
  node: 'try-circuit',
  role: 'delivery',
});
assert.match(
  audit(docsDeliveryCatalog, docsDeliveryInventory).errors.join('\n'),
  /public-claim surface.*cannot be mapped as delivery/,
);

const controlOnlyCapability = structuredClone(baseCatalog());
controlOnlyCapability.surface_map = controlOnlyCapability.surface_map.filter(
  (item) => item.surface !== 'cli:command:demo',
);
firstSupportingElement(controlOnlyCapability).kind = 'control';
controlOnlyCapability.surface_map.push({
  surface: 'cli:command:demo',
  node: 'runtime-isolation',
  role: 'control',
});
assert.match(
  audit(controlOnlyCapability).errors.join('\n'),
  /delivered capability 'try-circuit'.*no active entry-point or delivery/,
);

const mislabeledBehaviorTest = structuredClone(baseCatalog());
firstClaim(mislabeledBehaviorTest).refs = [
  {
    kind: 'behavior-test',
    path: 'package.json',
    proves: 'A package manifest is not a behavior test.',
  },
];
assert.match(
  audit(mislabeledBehaviorTest).errors.join('\n'),
  /labels non-test path 'package.json' as behavior-test/,
);

const mislabeledFixture = structuredClone(baseCatalog());
firstClaim(mislabeledFixture).refs = [
  {
    kind: 'behavior-test',
    path: 'tests/fixtures/sweep-fixture/README.md',
    proves: 'A fixture is not an executable behavior test.',
  },
];
assert.match(
  audit(mislabeledFixture).errors.join('\n'),
  /labels non-test path 'tests\/fixtures\/sweep-fixture\/README.md'/,
);

const boilerplateEvidence = structuredClone(baseCatalog());
firstClaim(boilerplateEvidence).refs = [
  {
    kind: 'behavior-test',
    path: 'tests/runner/demo-command.test.ts',
    proves: 'Exercises the outcome: says only that the desired outcome is exercised.',
  },
];
assert.match(
  audit(boilerplateEvidence).errors.join('\n'),
  /uses boilerplate evidence text instead of naming the proved behavior/,
);

const pathOnlyReleaseProof = structuredClone(baseCatalog());
firstCapability(pathOnlyReleaseProof).claims[0] = {
  id: 'path-only-release-proof',
  statement: 'A path alone is not a registered release observation.',
  level: 'release-observed',
  refs: [
    {
      kind: 'release-proof',
      path: 'package.json',
      proves: 'This path exists but is not a registered proof.',
    },
  ],
};
assert.match(
  audit(pathOnlyReleaseProof).errors.join('\n'),
  /release-observed claim 'path-only-release-proof'.*known proof_id/,
);

const shippedProposalOnly = structuredClone(baseCatalog());
firstCapability(shippedProposalOnly).claims = [
  {
    id: 'proposal-only',
    statement: 'A proposal does not prove shipped behavior.',
    level: 'proposal',
    refs: [
      {
        kind: 'proposal',
        path: 'README.md',
        proves: 'Synthetic proposal evidence.',
      },
    ],
  },
];
assert.match(
  audit(shippedProposalOnly).errors.join('\n'),
  /delivered node 'try-circuit'.*requires source, tested, or release-observed evidence/,
);

const missingPartition = baseInventory();
missingPartition.census_partitions = missingPartition.census_partitions.filter(
  (partition) => partition.kind !== 'mcp-tool',
);
assert.match(
  audit(baseCatalog(), missingPartition).errors.join('\n'),
  /missing partition 'mcp-tool'/,
);

const invalidMcpReach = baseInventory();
addSurface(invalidMcpReach, {
  id: 'mcp-tool:wrong-host',
  kind: 'mcp-tool',
  state: 'active',
  origin: 'derived',
  reach: [{ channel: 'mcp', host: 'claude', access: 'direct' }],
  source_paths: ['src/hosts/codex-mcp/contracts.ts'],
});
assert.match(
  audit(baseCatalog(), invalidMcpReach).errors.join('\n'),
  /invalid surface inventory.*MCP reach requires host codex/,
);

const invalidCommandReach = baseInventory();
addSurface(invalidCommandReach, {
  id: 'cli:command:wrong-host',
  kind: 'cli-command',
  state: 'active',
  origin: 'derived',
  reach: [{ channel: 'host-skill', host: 'codex', access: 'direct' }],
  source_paths: ['src/cli/command-vocabulary.ts'],
});
assert.match(
  audit(baseCatalog(), invalidCommandReach).errors.join('\n'),
  /invalid surface inventory.*cli-command cannot use host-skill reach/,
);

const questionScopeMismatch = structuredClone(baseCatalog());
questionScopeMismatch.review_questions.push({
  id: 'unrelated-question',
  question: 'Synthetic unrelated question?',
  state: 'open',
  nodes: ['ambient-continuity'],
  refs: [],
});
firstCapability(questionScopeMismatch).attention.push({
  id: 'mis-scoped-question',
  kind: 'gap',
  note: 'Synthetic mismatch.',
  related_nodes: [],
  disposition: { kind: 'review-question', id: 'unrelated-question' },
});
assert.match(
  audit(questionScopeMismatch).errors.join('\n'),
  /attention 'mis-scoped-question'.*outside review question 'unrelated-question' scope/,
);

const boundaryScopeMismatch = structuredClone(baseCatalog());
boundaryScopeMismatch.boundaries.push({
  id: 'unrelated-boundary',
  title: 'Synthetic boundary',
  rule: 'Applies only elsewhere.',
  scope: { kind: 'nodes', ids: ['ambient-continuity'] },
  refs: [
    {
      kind: 'source',
      path: 'README.md',
      proves: 'Synthetic boundary source.',
    },
  ],
});
firstCapability(boundaryScopeMismatch).attention.push({
  id: 'mis-scoped-boundary',
  kind: 'boundary',
  note: 'Synthetic mismatch.',
  related_nodes: [],
  disposition: { kind: 'boundary', id: 'unrelated-boundary' },
});
assert.match(
  audit(boundaryScopeMismatch).errors.join('\n'),
  /attention 'mis-scoped-boundary'.*outside boundary 'unrelated-boundary' scope/,
);

const rendered = renderMarkdown(baseCatalog(), passing);
assert.match(rendered, /## User capabilities/);
assert.match(rendered, /## Supporting controls, guarantees, and mechanisms/);
assert.match(rendered, /Try Circuit safely/);
assert.match(rendered, /Runtime isolation proof/);

const supportingAttention = structuredClone(baseCatalog());
firstSupportingElement(supportingAttention).attention.push({
  id: 'runtime-young',
  kind: 'young',
  note: 'The internal proof is still young.',
  related_nodes: [],
  disposition: { kind: 'accepted', reason: 'Keep it internal while the contract settles.' },
});
const renderedAttention = renderMarkdown(supportingAttention, audit(supportingAttention));
assert.match(renderedAttention, /The internal proof is still young/);
assert.match(renderedAttention, /Accepted: Keep it internal while the contract settles/);

const currentCatalog = loadCatalog();
const currentInventory = loadCurrentSurfaceInventory(repositoryRoot);
assert.equal(currentInventory.surfaces.length, 283);
assert(!currentInventory.proof_ids.includes('proof:codex-mcp-first-run'));
const currentAudit = audit(currentCatalog, currentInventory);
assert.deepEqual(currentAudit.errors, []);
const currentMarkdown = renderMarkdown(currentCatalog, currentAudit);
assert.match(currentMarkdown, /32 user capabilities/);
assert.match(currentMarkdown, /283 inventoried surfaces/);

console.log('capability model v0.2 focused checks passed');
