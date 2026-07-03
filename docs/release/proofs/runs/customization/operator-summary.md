# Circuit Create

Status: published
Custom flow: release-note-flow

## Purpose
Draft release notes from a change summary.

## Shape
This flow was generated with the **build** shape (grain:whole).
Build shape: a general change with no fix/review/research/prototype/explain signal, so the flow uses the standard frame-plan-act-verify spine.

Signals read from the task:
- domain:docs

## Validation
The generated compiled flow parsed successfully and passed flow-kind policy validation.

## Runtime Policy
Custom roots created by `circuit create` publish a normal runnable flow command.

## Usage
`circuit run release-note-flow --flow-root '<repo>/docs/release/proofs/runs/customization/custom-home/flows' --goal '<task>' --progress jsonl`

## Next Action
Run the usage command above, or reload the host command surface if your host caches slash commands.
