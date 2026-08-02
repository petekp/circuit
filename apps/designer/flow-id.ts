import { join, resolve } from 'node:path';

// The designer edits flows that live as directories under src/flows. The id
// arrives from a URL, so it is treated as a name to look up rather than as a
// path fragment to join: a `..` in it would otherwise let a request read or
// write a schematic.json anywhere on the machine.
const FLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export type FlowSchematicPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function flowSchematicPath(flowsDir: string, id: string): FlowSchematicPath {
  if (!FLOW_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: `"${id}" is not a flow id. A flow id is lowercase letters, digits and dashes, such as review.`,
    };
  }
  const path = join(flowsDir, id, 'schematic.json');
  // Belt and braces: the pattern already rules out separators, so a path that
  // escapes here would mean the pattern changed and this check outlived it.
  const root = resolve(flowsDir);
  if (!resolve(path).startsWith(`${root}/`)) {
    return { ok: false, reason: `"${id}" resolves outside the flow directory.` };
  }
  return { ok: true, path };
}
