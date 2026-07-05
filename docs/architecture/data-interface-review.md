# Data Interface Review (pre-v1)

Date: 2026-07-04. Status: complete; one decision open.

Before the v1 announcement, every operator-facing field name is still cheap
to change. After it, each one is a compatibility promise. This review audited
the whole operator-facing data interface at that last cheap moment, so that
what ships at v1 is deliberate, and so the reasoning survives for whoever
questions a name later.

## Scope and method

Three rings, by how hard they freeze:

1. **Operator-typed** (freezes hardest): the config YAML schema
   (`src/schemas/config.ts`) and CLI flags.
2. **Operator-read**: CLI JSON outputs (`preview --json`, `runs show`,
   `config show`, run stdout envelopes) and run records.
3. **Flow-authoring formats**: noted where relevant, not blocking v1.

Method: a full surface inventory, seven independent critique lenses (naming,
structure, consistency, evolvability, first-touch, parity, prior-art), code
dedup, then one adversarial verifier per finding required to cite
file-and-line evidence and state what concretely breaks. 48 agents total.
56 raw findings, 50 after dedup, 31 confirmed, 8 weakened, 0 refuted. Most
confirmed findings resolved to "keep, and write down why" rather than
"change" - the verifiers killed nearly every rename proposal on evidence.

## Fixed before v1

- **CONFIG-I6 told a falsehood about `schema_version: 2`.** The contract
  claimed a v2 config is rejected at parse time; the runtime loader actually
  routes v2 documents to the policy envelope, so the version number doubles
  as a document-family discriminator and the number 2 is burned forever.
  Code, tests, and [run-process.md](run-process.md) all agreed; the
  contract was the one stale surface. CONFIG-I6 now states both guarantees and carries the
  version registry (1 = selection config, 2 = policy envelope permanently,
  3 = next breaking Config shape). See
  [docs/contracts/config.md](../contracts/config.md).
- **Preview provenance `config` renamed to `pinned`.** The value meant "the
  explicit selection stack won", but that stack includes pins the flow
  itself authors (flow/stage/step selection), not just the operator's config
  files. [docs/configuration.md](../configuration.md) even claimed "in your
  config", which was true only by accident. `pinned` promises a pin, not a file, and matches the
  render rule (pinned values are bold). Preview JSON was unratified and had
  no external consumers, so the rename was cheap; it is ratified vocabulary
  from v1 on.
- **Unrecognized config keys now explain themselves.** Additive optional
  keys (`power_auto`, `project_id`, `skill_hooks`) land without a
  `schema_version` bump, so a config written for a newer Circuit fails on an
  older binary with an unrecognized-key error the version literal cannot
  flag. The loader stays strict but the error now names both explanations:
  a typo, or a key from a newer Circuit. The skew is ratified as accepted in
  CONFIG-I6 (bumping on every additive key would make every release
  breaking).
- **Per-flow model pinning got a positive example.** The shape
  `circuits.<flow_id>.selection.model` appeared in the configuration guide
  only inside a warning against misusing it on a mixed-connector flow. It is one
  of the three most likely first-touch tasks; it now has a worked example
  next to the warning.

## Kept by design

These survived adversarial challenge. The rationale is the payload; keep it
with the design.

- **Three intensity vocabularies (Power, Effort, Depth) stay separate.**
  They are three real axes, not synonyms. Effort deliberately borrows each
  provider's exact tokens (including oddities like `xhigh`) because it is a
  pass-through the provider defines. Power is Circuit's own ordered dial;
  the engine clamps and escalates over its order (`power_tiers` maps a Power
  word to an Effort target per connector). Depth picks which compiled flow
  shape runs. Merging any two would couple an external vocabulary to an
  internal one.
- **Strict parse everywhere; reject and regenerate; no migration layer.**
  This is the corrected form of known regrets in comparable ecosystems
  (ESLint removed cascading configs; implicit leniency hides typos). The
  honest consequence, now stated rather than implied: key renames are
  one-way doors after v1, because there is no soft-deprecation channel to
  walk one back. That is exactly why this review ran before the
  announcement.
- **The `selection` wrapper stays; `circuits.<id>.model` shorthand
  rejected.** `selection` bundles model, effort, skills, depth, and
  invocation options as one override unit across four config positions, and
  the SelectionOverride/ResolvedSelection/SelectionResolution triplet is
  ratified in [docs/contracts/selection.md](../contracts/selection.md). The
  proposed flat shorthand would save one nesting level while creating a
  second spelling for the same concept, forcing `config show`/`set` and
  provenance to normalize dual forms forever, and it would advertise
  flow-wide model pins, which the docs deliberately steer away from (toward
  `power_tiers`) because they break on mixed-connector flows.
- **`variant_models` entries require `model` and `effort`.** Looks
  inconsistent with the all-optional SelectionOverride, but the requiredness
  is what prevents two variants from silently resolving identical, which
  would waste a whole tournament arm.
- **Two config locations with explicit precedence and recorded provenance.**
  `~/.config/circuit/config.yaml` then `.circuit/config.yaml`, composed
  default < user-global < project < invocation. Two locations is the
  minimum honest set (personal defaults vs shared project policy).
- **`engine_state: completed` beside `terminal_outcome: complete` stays.**
  Convention, now named: states are participles (running, completed);
  outcomes are the trace-locked words checks emit. Renaming either would
  break recorded runs for a cosmetic gain.
- **Preview JSON casing (camelCase) and its polymorphic top level are
  unratified watch items.** Every other operator JSON surface is
  snake_case; preview is camelCase because it serializes a TS interface
  rather than a zod schema. Kept for v1 (single consumer, low stakes), but
  it is the first candidate to align if preview JSON ever gets ratified or
  scripted against.

## Open decision: the `circuits.<flow_id>` key

The most-typed config key names flows with a noun, `circuits`, that
[UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) never defines (Flow
is canonical; "Circuit" appears only as the product name). The same word also names two
different value shapes at two nesting levels (`relay.circuits.<id>` holds a
connector pin; `circuits.<id>` holds the per-flow override slot). Every
read surface says `flow`/`flow_id`, and the docs translate the key on first
use ("per-flow overrides under `circuits.<flow_id>`").

All lenses agreed on one thing: the current state, an undefined noun on the
hardest-freezing surface, should not survive v1. They split on the remedy:

- **Rename to `flows.` / `relay.flows.`** (first-touch and prior-art
  lenses): matches every read surface, ends the translation tax. Cost: a
  mechanical 42-file change plus frozen contract identifiers
  (`config.circuit-override` report id and a property id keep the old noun
  or need a contract migration), and it spends the brand word.
- **Keep and ratify** (naming, structure, consistency lenses): add a
  ubiquitous-language row defining "circuit (config noun): a flow as wired
  into your configuration", use it consistently in prose, and add a
  did-you-mean hint when an operator writes `flows:`. "Your circuits" is
  coherent product naming for a tool named Circuit. Cost: the word stays a
  translation burden for cold readers.

This is an identity call, not a technical one, so it is the owner's. Until
it is made, neither the rename nor the ratifying dictionary row has been
applied.

## Post-v1 candidates (additive, nothing burns)

- **Bare-string connector references.** `relay.roles.reviewer: codex` as
  sugar for the tagged `{kind: builtin, name: codex}` object.
  `relay.default` already accepts the bare string, and reserved-name
  disjointness makes the resolution unambiguous, so accepting
  string-or-object is purely additive. Landing it later cannot break
  anything; the tagged form stays canonical on trace surfaces.
- **Derive preview's `--power` choices from the schema.** `preview`
  hardcodes the dial vocabulary that `run` derives from `PowerDialSetting`;
  fold when next touching preview.
- **One provenance vocabulary.** `config show` (default/user-global/
  project), traces (7-value SelectionSource), and preview
  (pinned/power-tier/...) each answer "where did this value come from" with
  different words at different granularities. Each is locally right;
  aligning them is a post-v1 polish pass.
- **A stated compatibility promise for JSON consumers.** The versioning
  contract governs Circuit reading its own artifacts; it says nothing to an
  operator scripting against `runs show --json`. One paragraph of policy
  (what may change without notice, what will not) would close it.
- **`discoverConfigLayers` cleanup.** The selection-only loader entry point
  has no product callers (tests only) and does not route policy envelopes;
  fold it into the runtime loader or mark it test-only.

## Where the full evidence lives

The audit ran as a workflow (48 agents; inventory, seven lenses, dedup,
per-finding adversarial verification). Findings cite file and line for
every claim. The four "fix before v1" items above landed as individual
commits referencing this review; everything else is recorded here so the
next person who asks "why is it called that?" gets an answer instead of an
archaeology project.
