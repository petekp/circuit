# YAML Validation

This repo keeps YAML only where people or external platforms expect it. Circuit
runtime validation still comes from Zod. Editor-time validation comes from
generated JSON Schemas under `schemas/yaml/`, wired through
`.vscode/settings.json`.

Every checked-in YAML file should be classified here and covered by
`tests/contracts/yaml-surface-validation.test.ts`. Every Circuit-owned YAML
surface should also have a generated editor schema covered by
`tests/contracts/yaml-editor-schema.test.ts`.

| YAML surface | Classification | Validation |
| --- | --- | --- |
| `.github/workflows/verify.yml` | GitHub Actions workflow | Parsed for YAML syntax by the inventory test. The contract belongs to GitHub Actions, not Circuit Zod schemas. |
| `docs/release/claims/public-claims.yaml` | Authored release ledger | Parsed as `PublicClaimLedger`; editor schema: `schemas/yaml/release-public-claims.schema.json`. |
| `docs/release/parity/exceptions.yaml` | Authored release ledger | Parsed as `ParityExceptionLedger`; editor schema: `schemas/yaml/release-parity-exceptions.schema.json`. |
| `docs/release/parity/original-circuit.yaml` | Authored release ledger | Parsed as `OriginalCapabilitySnapshot`; editor schema: `schemas/yaml/release-original-capabilities.schema.json`. |
| `docs/release/proofs/index.yaml` | Authored release ledger | Parsed as `ProofScenarioIndex`; editor schema: `schemas/yaml/release-proof-index.schema.json`. |
| `docs/release/proofs/runs/customization/custom-home/drafts/release-note-flow/circuit.yaml` | Generated custom-flow descriptor proof artifact | Parsed as `CustomFlowPackageDescriptor`; editor schema: `schemas/yaml/custom-flow-descriptor.schema.json`. |
| `docs/release/proofs/runs/customization/custom-home/skills/release-note-flow/circuit.yaml` | Generated custom-flow descriptor proof artifact | Parsed as `CustomFlowPackageDescriptor`; editor schema: `schemas/yaml/custom-flow-descriptor.schema.json`. |

Runtime config files are not checked into this repo, but the loader validates
`~/.config/circuit/config.yaml` and `./.circuit/config.yaml` as `Config` or
`PolicyEnvelopeV2` when present. `SKILL.md` frontmatter is Markdown with YAML
frontmatter; Circuit validates the subset it consumes through
`UserSkillEntry`.

## Editor-Time Validation

Run this after changing any Zod schema used by YAML:

```bash
npm run emit-yaml-schemas
```

CI checks drift with:

```bash
npm run check-yaml-schemas
```

The workspace YAML language-server mappings live in `.vscode/settings.json`.
They map:

- `.circuit/config.yaml` and `**/.circuit/config.yaml` to
  `schemas/yaml/circuit-config.schema.json`.
- release ledgers under `docs/release/**` to their matching release schemas.
- custom-flow `circuit.yaml` descriptors under proof artifacts, `drafts/*`, and
  `skills/*` to `schemas/yaml/custom-flow-descriptor.schema.json`.

For the user-global config file outside this workspace, add this modeline to
the top of `~/.config/circuit/config.yaml` if your editor does not pick up
workspace mappings. Replace `/path/to/circuit` with this repo's absolute path:

```yaml
# yaml-language-server: $schema=/path/to/circuit/schemas/yaml/circuit-config.schema.json
```

## Manual Autocomplete Check

Open `.circuit/config.yaml` in Cursor or VS Code with the YAML extension active.
Type this:

```yaml
schema_version: 1
skill_hooks:
  policy:
    after:verification-failed:
      mode:
```

At `mode:`, the editor should suggest `auto` and `mute`. At the top
level, it should suggest keys such as `schema_version`, `defaults`, `relay`,
`skills`, `skill_hooks`, and `circuits`.

Also test an invalid key:

```yaml
schema_version: 1
defuults: {}
```

The editor should mark `defuults` as invalid. Runtime Zod validation remains
the final authority for cross-field rules that JSON Schema cannot express.
