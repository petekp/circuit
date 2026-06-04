// Skill-hook injection channel — the run-scoped accumulator the actuator writes
// and the relay seam reads.
//
// Slice 3 (the actuator) flips skill-hook dispatch from report-only to ACT: when
// an `auto` policy matches, the dispatcher adds the event's resolved
// triggered_skills to this channel. Subsequent IMPLEMENTER relay steps read the
// channel (in planRelayGuidanceDecision) and merge those skill ids into the
// step's loaded skills, so the worker prompt, the recorded relay guidance, and
// the assertRelayGuidanceMatchesPlan check all see one consistent skill set.
//
// Scope: every injecting hook today (before/after:edit-file,
// after:verification-failed) concerns a code edit, so injection applies ONLY to
// write-capable (implementer-role) relays. planRelayGuidanceDecision gates on the
// role; a researcher or reviewer relay never receives an injected skill (role
// separation — a reviewer must judge the work independently). The gate lives in
// planRelayGuidanceDecision, not here, so this channel stays a plain accumulator.
//
// Design constraints this shape enforces (see docs/ideas/skill-hooks-dispatch-spec.md):
//
//  - Persistent across the run, not one-shot. `ids()` is a pure idempotent read;
//    it never drains. Two reasons: (1) planRelayGuidanceDecision is called more
//    than once per step (the production path, the injected-connector path, and
//    each fanout branch), and assertRelayGuidanceMatchesPlan + the request-payload
//    hash require every call for a given step to return the identical skill set;
//    (2) recovery loops re-run the implementer after a verification failure, and
//    a skill injected by after:verification-failed must reach that retry. So once
//    injected, a skill stays loaded for the remainder of the run on every
//    implementer relay (a known, accepted over-injection cost across same-role
//    steps; it does NOT leak across roles). The channel is mutated ONLY at the
//    post-step dispatch seam (between steps, after the relay executor has fully
//    returned), so within a single step every read is stable.
//  - Deduped. A skill injected twice (two hooks, or a hook plus a later hook)
//    is added once; resolveLoadedRelaySkills dedupes again against selection and
//    slot bindings, so order and multiplicity here do not matter downstream.
//  - Pure. No IO; the skill bodies are resolved later by the relay loader's
//    registry, not here.

import type { SkillId } from '../schemas/ids.js';

export interface SkillHookInjectionChannel {
  // Add resolved skill ids an `auto` hook event wants injected into subsequent
  // implementer relay steps. Idempotent per id.
  add(ids: readonly SkillId[]): void;
  // The distinct injected skill ids, in first-seen order. Pure read — does not
  // mutate or drain, so repeated calls within a step return the same set.
  ids(): readonly SkillId[];
}

export function createSkillHookInjectionChannel(): SkillHookInjectionChannel {
  // Insertion-ordered set keyed by the string id; first-seen order is stable.
  const set = new Set<string>();
  return {
    add(ids) {
      for (const id of ids) set.add(id as unknown as string);
    },
    ids() {
      return [...set] as unknown as readonly SkillId[];
    },
  };
}
