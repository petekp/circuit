# First-run lab

Clean-room containers that replay Circuit's documented install funnels the way
a first-time user would: fresh box, no config, no sign-ins, following the
README verbatim. This is a standing pre-release gate: every release runs the
full battery before the version bump and again after publishing. See
[docs/release/runbook.md](../../../docs/release/runbook.md) for where it sits in
the release sequence.

No credentials enter the containers and no model calls are made. The battery
covers everything a new user hits *before* the first paid run: install, first
command, `circuit doctor`, and the honest-failure paths (no connectors,
misspelled flow, bad resume input).

## Images

| Image | Simulates | Funnel under test |
| --- | --- | --- |
| `Dockerfile.cli` | Node 22 user, no agent CLIs installed | README "Local CLI": clone, `npm install`, `npm run build`, `./bin/circuit ...` |
| `Dockerfile.cli-node20` | User on Node 20 (below the documented 22.18 floor) | Same clone path; captures what a floor-violating user actually sees |
| `Dockerfile.claude` | Claude Code user | README "Claude Code": marketplace add, plugin install, bundled runtime |
| `Dockerfile.codex` | Codex user | README "Codex": marketplace add at the published `--ref` |

## Run it

```bash
scripts/release/first-run-lab/run-lab.sh all      # or: cli | cli-node20 | claude | codex
```

Transcripts land in `scripts/release/first-run-lab/runs/<timestamp>-<name>.log`
(gitignored). Every step prints its exit code; the scripts never stop on
failure, because the failures are the data.

Containers clone `petekp/circuit` at main over the network, so the lab tests
what a user gets right now, not the local working tree. The codex funnel
installs at the exact `--ref` the README tells users to pin; the driver reads
that ref out of `README.md` at run time, so updating the README during a
release is the only place the ref lives.
