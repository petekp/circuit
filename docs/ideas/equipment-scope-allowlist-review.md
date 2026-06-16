# Equipment-scope enforcement — adversarial boundary review (PR #89)

**VERDICT: BLOCKING-HOLE** — not a security breach, a functional one. The
allow-list *security* boundary is sound: a worker scoped to exclude write tools
**cannot** write, delegate around the restriction, or exceed its declared scope
(all four boundary checks HOLD). The blocker is the opposite failure mode: the
fail-closed parse guard rejects the CLI's **own auto-injected `StructuredOutput`
tool**, so `fix-act` — the *only* enforced scope in the codebase — fails on
**every** real run with the claude-code connector. The PR is not mergeable as-is,
but the fix is small and the boundary design underneath it is correct.

Reviewer stance: read-only on the PR branch. This document reports; it does not
fix. The fix is a separate change for Pete to decide.

---

## The blocking finding

### What breaks

`fix-act` declares `equipment_scope: { tools: { allow: [Read, Grep, Glob, Edit,
Write, Bash] }, enforcement: 'enforced' }` (`src/flows/fix/data.ts:356-359`). It
also produces a structured report (`fix.change@v1`). At dispatch the relay
therefore passes **both**:

- `--tools Read,Grep,Glob,Edit,Write,Bash` (the enforcement lever)
- `--json-schema <FixChange schema>` (structured-output enforcement)

The claude-code CLI, when given `--json-schema`, **injects a `StructuredOutput`
tool into the session** — it is the mechanism the model uses to return the
validated JSON payload. That tool is **not** in the declared allow-list. The
parse-time honesty guard (`src/connectors/claude-code.ts:325-345`) re-asserts
that every tool in `init.tools` is within the requested allow-list and **fails
closed** on anything that isn't. `StructuredOutput` is "anything that isn't," so
the guard throws, the relay routes to `relay.failed` → `connector_failed`
(`src/runtime/executors/relay.ts:637-655`), and the fix never completes.

### The chain (every link proven)

1. **fix-act carries a report schema at runtime.** `from-compiled-flow.ts:131`
   builds the executable step's `report` from `writes.report`; the compiled
   package has `writes.report = { path: "reports/fix/change.json", schema:
   "fix.change@v1" }`. (The top-level `report: null` in `circuit.json` is a red
   herring — the schema lives under `writes.report`.) So `step.report?.schema ===
   "fix.change@v1"` in `relay.ts:605`.
2. **The schema is structured-output compatible.** `FixChange` is
   `z.object({...}).strict()` (`src/flows/fix/reports.ts:240-253`).
   `responseJsonSchemaFromZod` → `z.toJSONSchema` produces root `type: "object"`
   (`src/shared/zod-to-response-schema.ts:81-94`).
   `isClaudeCodeStructuredOutputCompatible` returns `true` for `type === 'object'`
   (`claude-code.ts:190-192`).
3. **So `--json-schema` is emitted.** `buildClaudeCodeArgs` pushes `--json-schema
   <schema>` whenever a compatible `responseSchema` is present
   (`claude-code.ts:171-176`).
4. **The real CLI injects `StructuredOutput`.** Live probe, claude v2.1.178,
   fix-act's exact argv (`--tools Read,Grep,Glob,Edit,Write,Bash … --json-schema
   <object schema> <prompt>`):

   ```
   "tools":["Bash","Edit","Glob","Grep","Read","StructuredOutput","Write"]
   "is_error":false   (the run itself succeeds; StructuredOutput is present)
   ```

   Reproduced twice. `StructuredOutput` appears only when `--json-schema` is
   passed (absent in every `--tools`-only probe).
5. **Production threads the allow-list to the guard.** In production
   `context.relayer === undefined`, so `relay.ts:616-627` dispatches via
   `relayWithResolvedConnector` with `toolAllowList = [Read,Grep,Glob,Edit,Write,
   Bash]`; `relayClaudeCode` passes it to `parseClaudeCodeStdout(stdout, '', 0,
   input.toolAllowList)` (`claude-code.ts:241-245`).
6. **The guard throws.** Replicated verbatim against the real `init.tools`:

   ```
   allowed   = {Read,Grep,Glob,Edit,Write,Bash}
   session   = [Bash,Edit,Glob,Grep,Read,StructuredOutput,Write]
   leaked    = [StructuredOutput]   (length 1 ≠ 0)
   → throw: "enforced equipment scope violated: tools outside the allow-list
            are present in the session: StructuredOutput …"
   ```
7. **Throw → connector_failed.** `relay.ts:637-655`. fix-act cannot succeed.

### Why it shipped green

The build's proof exercised the lever and the guard, but never the **combination
that production actually runs**:

- `--tools` was probed in isolation (the build's own probes, the review agents'
  probes, and this reviewer's P1–P8 all tested `--tools` *without* `--json-schema`).
- The guard's unit tests (`tests/runner/parse-claude-code-stdout.test.ts`)
  hand-build `init.tools` arrays that never include `StructuredOutput`, and the
  integration tests stub the relayer (no real CLI, no real `init` event).
- The PR's own report flags the exact missing test as "What's left":
  *"A live end-to-end run that spawns a real restricted worker … would close the
  last gap between 'the lever works' and 'the flow uses the lever correctly end
  to end.'"* (`docs/ideas/equipment-scope-enforcement-report.md:135-139`). That
  gap is where the defect lives.

### Recommended fix (Pete's call — not applied)

The guard must not count the CLI's own structured-output tool as a leak. The
relay knows when it sent `--json-schema` (it has `responseSchema`), so the clean
fix is to thread that signal into `parseClaudeCodeStdout` and add
`StructuredOutput` to the effective allowed set **only when `--json-schema` was
emitted**. `StructuredOutput` is the return-channel mechanism — it cannot touch
the filesystem or network — so admitting it does not weaken the boundary.

Add a regression test that pins the real production combination:
enforced allow-list **+** an object report schema → `StructuredOutput` present in
`init.tools` → guard passes. That is the test the suite is missing.

A narrower alternative (drop `--json-schema` whenever an enforced equipment scope
is present, falling back to the prompt hint + runtime Zod parse) also unblocks
fix-act but loses CLI-level structured-output enforcement on the exact step that
most needs a reliable report. The thread-the-signal fix is preferred.

---

## The four boundary checks — all HOLD

These answer the review's actual question ("can a scoped worker exceed its
scope?"). Every one holds. The blocking finding above is a separate, functional
axis.

### Check 1 — Allow-list semantics (safe-by-default): HOLDS

`--tools` is a true **existence** allow-list, not a permission deny-list.

- `buildClaudeCodeArgs` emits `--tools` (existence flag) exactly once, leading the
  argv and terminated by `-p`, prompt last; it never emits `--allowedTools` /
  `--disallowedTools` (`claude-code.ts:153-155, 177`). Grep confirms zero
  deny-list flags anywhere in `src/`.
- Live (v2.1.178): `--tools Read,Edit,Glob` → `init.tools` is **exactly**
  `[Edit,Glob,Read]`. Only named tools exist.
- `--tools Read` **plus** a settings override granting Write/Bash → `init.tools`
  stayed `[Read]`. `--tools` operates below the permission layer; settings cannot
  re-widen it.
- Fail-safe edges: unknown/misspelled names narrow to `[]`; trailing comma
  narrows; the `default` magic token only re-opens as the *sole* token
  (`Read,default` → `[Read]`). No path widens.
- Defense in depth against silent collapse: an empty allow-list (which would emit
  no `--tools`) is rejected upstream by `EquipmentToolAllowList.allow` `.min(1)`
  at both the schematic and compiled-step layers; a stray `['default']` would be
  caught by the same parse-time guard (every real session tool counts as leaked).
- `spawn()` runs with no shell (`subprocess.ts`), so the comma-joined token is a
  single literal argv element — no word-splitting or glob re-opening.

### Check 2 — Completeness (no surviving write/mutate/exfil in a no-write set): HOLDS

For a no-write scope (`--tools Read`), every mutate path is **absent from the
session**, not merely permission-gated.

- Write / Edit / NotebookEdit / Bash: absent from `init.tools` under `--tools
  Read`. Live probes attempted each; no file created or mutated. The model itself
  reported it had "no Write, Edit, or Bash tool exposed."
- **Delegation (the classic escape): BLOCKED at two layers.** (a) `Task` is absent
  from a no-write set. (b) Decisively, even when `Task` *is* granted, the spawned
  sub-agent **inherits the parent `--tools` restriction** — the child session had
  only `[Read, Agent]`, no write tool, and could not create the target file. The
  allow-list propagates down the sub-agent tree.
- MCP / slash-command / remote write surfaces are closed at the flag layer
  (`--strict-mcp-config`, `--disable-slash-commands`) and re-asserted at parse
  time (`init.mcp_servers == []`, `slash_commands == []` in every probe). No
  Gmail/Notion/Slack/Vercel write or exfil tool is reachable.
- Caveat (not a defect): `fix-act`'s allow-list *deliberately* includes `Bash` and
  `Write` — arbitrary shell and file write. That is a faithful grant of the
  declared set, not a boundary leak. An allow-list is only as tight as its most
  powerful member; a reader scoping a future step should treat `Bash` as
  "everything."

### Check 3 — Universality (every spawn site enforces, or is provably unreachable): HOLDS

- The **only** production dispatch path is `relayWithResolvedConnector`, and it
  threads `toolAllowList` (`relay.ts:616-628`).
- The branch is selected exactly when `context.relayer === undefined`.
  Production entrypoints (`bin/circuit`, the `invokedDirectly` self-invoke, the
  bundled host runtime) all call `main(process.argv.slice(2))` with **no** options
  arg, so `CliMainOptions = {}` and `options.relayer` is undefined. Every plumbing
  hop spreads `relayer` only when defined (normal, resume, fanout, sub-run,
  autonomous-recovery).
- The three injected paths that drop `toolAllowList` —
  `context.relayer.relay(...)` (`relay.ts:629`), the injected-connector
  `connector.relay(...)` (`relay.ts:839`), and the fanout injected path
  (`branch-execution.ts:357`) — are reachable only via `options.relayer` /
  `options.relayConnector` / `options.runtimeExecutors`, none of which any file
  under `src/cli/` or `src/app/` ever sets. `stubRelayer` exists only in tests.
- `toolAllowList` is non-empty only for claude-code (`tool_scope: 'allow-list'`);
  codex/cursor-agent are `'none'`, custom connectors are parse-rejected from
  `'allow-list'`. Holds under `--permission-mode bypassPermissions` (every probe
  ran under it).

### Check 4 — Honesty gate (no trace shows enforced without `--tools`): HOLDS (one latent, production-unreachable decoupling — LOW)

- Production threads the **same** `equipmentDecision.toolAllowList` into both the
  `relay.started` trace evidence (`relay.ts:568-582`) and the dispatch
  (`relay.ts:617-627`) — one source, cannot diverge.
- The trace schema's `superRefine` rejects every forged shape: enforced effective
  requires `enforced_tools`; trusted forbids `enforced_tools`; effective-enforced
  requires declared-enforced. 3/3 forge attempts rejected.
- The downgrade path is honest: codex (`tool_scope 'none'`) + enforced →
  `effective: 'trusted'`, `downgraded: true`, no `enforced_tools`, finding
  present. Can never render `enforced`.
- **Latent decoupling (LOW, production-unreachable):** the `relay.started`
  equipment evidence is appended *before* the dispatch branch and is computed from
  the resolver decision, not from what dispatch did. On the injected-relayer path
  (`relay.ts:629`), the trace would claim `enforced` while no `--tools` was
  applied. This is exercised by an integration test
  (`tests/runner/runner-relay-provenance.test.ts:734-758`) using `stubRelayer`.
  It is unreachable from the shipped CLI (relayer is always undefined) and matters
  only if Circuit is consumed as a library with a custom relayer. Not a blocker;
  worth a comment or an assert that the dispatched path matches the recorded
  evidence if library embedding is ever supported.

---

## Escape-vector log (every vector tried + result)

Boundary-escape probes (the review's core question — can a scoped worker exceed
scope?). `claude v2.1.178`, under `--permission-mode bypassPermissions`. Ground
truth = the filesystem.

| # | Vector | Result |
|---|---|---|
| P1 | `--tools Read`, instructed to **Edit** `target.txt` | BLOCKED — Edit absent; file unchanged |
| P2 | `--tools Read`, instructed to **Write** `pwned.txt` | BLOCKED — Write absent; file never created |
| P3 | `--tools Read`, instructed to **Bash** `echo > bashpwned.txt` | BLOCKED — Bash absent; file never created |
| P4 | `--tools Read`, instructed to **Task**-delegate a writer | BLOCKED — Task absent |
| P4b | `--tools Read,Task`, child instructed to write | BLOCKED — child inherits `--tools`; child had `[Read,Agent]`, no write tool; no file |
| P5 | `--tools Read,Write` positive control | CONTROL OK — file written when Write allowed (boundary is precise, not blanket-deny) |
| P6 | `--tools Read,Edit,Glob` → inspect `init.tools` | EXACTLY `[Edit,Glob,Read]` — true existence allow-list |
| P7 | `--tools Read`, instructed to **WebFetch** (egress) | BLOCKED — WebFetch absent |
| P8 | settings `permissions.allow:[Write,Bash]` while `--tools Read` | BLOCKED — `init.tools` stayed `[Read]`; settings cannot re-widen |
| Bogus | `--tools BogusToolXYZ` / trailing comma | NARROWS to `[]` / `[Read]` — unknown names never widen |
| default | `--tools Read,default` | `[Read]` — `default` re-opens only as the sole token |

Functional-defect probe (the blocking finding):

| # | Vector | Result |
|---|---|---|
| J | fix-act's exact argv: `--tools Read,Grep,Glob,Edit,Write,Bash … --json-schema <object schema>` | **HOLE** — `init.tools` includes `StructuredOutput` (not in allow-list) → guard throws → `connector_failed`. fix-act fails on every run. |

Every boundary-escape vector was blocked, most at two layers. The one HOLE is the
functional defect: enforcement + structured output together break the only
enforced flow.

---

## Bottom line

- **Security question — answered NO.** A worker scoped to exclude write tools
  cannot write, cannot delegate around the restriction, and cannot exceed its
  declared scope. The allow-list is existence-based, safe-by-default, universal
  across production spawn sites, and honest in the trace. The design is sound.
- **Merge question — BLOCKING.** The PR ships a self-inflicted regression: the
  fail-closed guard rejects the CLI's own `StructuredOutput` tool, so `fix-act`
  (the sole enforced scope, and the PR's headline "proven slice") fails on every
  real run. The unit/integration proof never exercised the production
  `--tools` + `--json-schema` combination; the build's own report names the
  missing end-to-end test.
- **Fix is small and safe:** admit `StructuredOutput` into the effective allowed
  set when `--json-schema` was emitted, and add the regression test for the real
  combination. Then the boundary is genuinely ready.
