// Picks the handling tier for a ticket score measured against two trip points.
//
// triageTier(score, priorityAt, immediateAt) returns one of the labels
// "routine", "priority", or "immediate".
//
// The relative magnitudes of the two trip points carry the scale's polarity.
// When priorityAt is the smaller of the two, a bigger score is worse: think of
// the score as minutes a ticket has sat without a reply. A score at or above
// immediateAt is "immediate"; otherwise a score at or above priorityAt is
// "priority". When priorityAt is the larger of the two, a smaller score is
// worse: think of the score as the requester's remaining goodwill balance. A
// score at or below immediateAt is "immediate"; otherwise a score at or below
// priorityAt is "priority". A score past neither trip point is "routine".
export function triageTier(score, priorityAt, immediateAt) {
  return 'routine';
}
