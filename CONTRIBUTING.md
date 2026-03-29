# Contributing to Circuit

## Adding a New Circuit

### Prerequisites

- Familiarity with the circuit system (read [ARCHITECTURE.md](./ARCHITECTURE.md))
- A workflow that fits the circuit model (multi-phase, artifact-producing)

### Using circuit:create (Recommended)

The plugin includes a built-in circuit compiler:

1. `/circuit:create` — starts the interactive authoring flow
2. It asks questions about your workflow, generates `circuit.yaml` + `SKILL.md`
3. `/circuit:dry-run` — validates the generated circuit

### Manual Authoring

If you prefer to author manually:

1. Create `skills/<circuit-name>/circuit.yaml` and `skills/<circuit-name>/SKILL.md`
2. Follow the schemas documented in [ARCHITECTURE.md](./ARCHITECTURE.md)
3. Validate with `/circuit:dry-run`

### Circuit Quality Checklist

- [ ] `circuit.yaml` and `SKILL.md` agree on topology
- [ ] Every step has a gate stronger than "file exists"
- [ ] Artifact chain is fully traced (no orphaned `produces`/`consumes`)
- [ ] Frontmatter has effective trigger phrases and negative scope
- [ ] Relay headings present in all dispatch headers
- [ ] Resume awareness documented
- [ ] Circuit breaker section present

### Testing

Run `/circuit:dry-run` with a concrete feature that exercises the circuit's hardest seam. Pick a real scenario, not a toy example — the dry run should stress the gates and artifact handoffs that are most likely to fail in practice.

## Improving Existing Circuits

- Edit `SKILL.md` for runtime behavior changes
- Edit `circuit.yaml` only for topology changes (steps, gates, artifacts)
- Always cross-validate both files after editing
- Run `/circuit:dry-run` after any change

## Improving Relay Scripts

`scripts/relay/compose-prompt.sh` and `scripts/relay/update-batch.sh` are the shared infrastructure that all circuits depend on.

- Both have test suites — run `scripts/verify-install.sh` for smoke tests
- Changes here affect **all circuits** — test thoroughly before committing
- If you change argument parsing or output format, audit every circuit that calls the script

## Submitting Changes

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `scripts/verify-install.sh` to confirm nothing broke
5. Open a PR with a clear description of what changed and why

## Code of Conduct

Be respectful. This is a tool for everyone.
