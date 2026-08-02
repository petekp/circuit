// The failure surface appended the engine's trace reason verbatim, so an
// operator read "route 'retry' for step 'synthesize-step' exhausted
// max_attempts=2". Every word of that is engine vocabulary: routes and
// max_attempts are schematic concepts, and nothing in the sentence says what
// to do.
//
// The trace wording itself is load-bearing (dozens of assertions and several
// dossiers quote it) and stays exactly as it is. Only the sentence a person
// reads is translated.
import { describe, expect, it } from 'vitest';
import { operatorFailureSentence } from '../../src/app/run-envelope/failure-language.js';

describe('turning an engine failure reason into a sentence', () => {
  it('says a step ran out of attempts instead of naming routes and max_attempts', () => {
    const said = operatorFailureSentence(
      "route 'retry' for step 'synthesize-step' exhausted max_attempts=2",
    );
    expect(said).toBe(
      "The 'synthesize-step' step ran out of attempts: it was tried 2 times and never passed.",
    );
    expect(said).not.toContain('max_attempts');
    expect(said).not.toContain('route');
  });

  it('keeps the last thing that went wrong, which is the actionable part', () => {
    const said = operatorFailureSentence(
      "route 'retry' for step 'act' exhausted max_attempts=2; last recovery reason: verification failed",
    );
    expect(said).toContain("The 'act' step ran out of attempts");
    expect(said).toContain('tried 2 times');
    expect(said).toContain('The last problem was: verification failed');
    expect(said).not.toContain('max_attempts');
  });

  it('says "once" rather than "1 times"', () => {
    expect(
      operatorFailureSentence("route 'continue' for step 'compose' exhausted max_attempts=1"),
    ).toBe("The 'compose' step ran out of attempts: it was tried once and never passed.");
  });

  it('passes through a reason it does not recognize, rather than mangling it', () => {
    const raw = 'The claude CLI is not logged in. Run `claude login`.';
    expect(operatorFailureSentence(raw)).toBe(raw);
    expect(operatorFailureSentence('')).toBe('');
  });

  it('leaves an exhaustion reason it cannot fully parse alone', () => {
    // Missing the attempt count: translating half of it would be worse than
    // handing over what the engine actually said.
    const raw = "route 'retry' for step 'act' exhausted max_attempts=";
    expect(operatorFailureSentence(raw)).toBe(raw);
  });
});
