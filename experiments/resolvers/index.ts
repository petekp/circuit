// The decision-layer resolvers — public surface.
//
// Two concrete "resolvers" (decision-layer-exploration.md): small units that,
// given a task/step context, emit one choice for one axis and materialize it onto
// an assembly spec the existing assembler eats. They are built side by side to
// the SAME shape without sharing a type (see SHARED-SHAPE.md) — the abstraction is
// earned from instances, not imposed.
//
//   - structure (chop/hold): pick a flow grain — one wide step vs a decomposed
//     spine. Conservative: leans to whole.
//   - equipment (skill injection): pick the skills a work step is given. Honest
//     about enforced-vs-trusted (today: trusted only).
//
// Both are pure and offline; the flow lab (../flow-lab) scores their output.
//
// `PriorChoices` is the one name both modules declare (an identical structural
// alias — the second half of the shared call shape); structure's is re-exported
// and equipment's members are listed explicitly to keep the barrel unambiguous.
export * from './structure.js';
export {
  type EquipmentStepContext,
  type EquipmentEnforcement,
  type EquipmentResolution,
  resolveEquipment,
  applyEquipment,
  resolveAndApplyEquipment,
} from './equipment.js';
