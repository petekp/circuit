# Waiver: verdict-correctness for 0.1.1

Waived 2026-07-15 by Pete (operator decision during the 0.1.1 release).

Reason: waived alongside fix-vs-vanilla per the same operator call that the
release-cadence evals are not earning their gate. Additionally, 0.1.1's only
change on the verdict path is message phrasing (a schema-declared rejection
now reads as a judgment instead of a protocol violation); verdict admission
semantics are untouched, so the 0.1.0 measurement (100% catch, 45/45) still
describes the shipped behavior.

Scope: this waiver clears 0.1.1 only. Note this eval backs the honesty-floor
claim (judges catching false-done work), which the current framing does keep
— worth weighing separately from fix-vs-vanilla if the cadence policy gets
revisited.
