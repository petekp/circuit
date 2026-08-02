// `circuit run explore "find the weak seams"` is how a person types a run.
// Commander answered "too many arguments. Expected 1 argument but got 2",
// which says nothing about --goal and reads as though the goal itself was the
// mistake. The request is comprehensible, so it is honored.
import { describe, expect, it } from 'vitest';
import { parseExecutionArgs } from '../../src/cli/run.js';

describe('the goal typed where a person puts it', () => {
  it('reads the second argument as the goal', () => {
    const parsed = parseExecutionArgs('run', ['explore', 'find the weak seams']);
    expect(parsed.flowName).toBe('explore');
    expect(parsed.goal).toBe('find the weak seams');
  });

  it('still reads --goal when the goal is flagged', () => {
    const parsed = parseExecutionArgs('run', ['explore', '--goal', 'find the weak seams']);
    expect(parsed.flowName).toBe('explore');
    expect(parsed.goal).toBe('find the weak seams');
  });

  it('accepts the same goal said twice and refuses two different ones', () => {
    expect(parseExecutionArgs('run', ['explore', 'one goal', '--goal', 'one goal']).goal).toBe(
      'one goal',
    );
    expect(() =>
      parseExecutionArgs('run', ['explore', 'one goal', '--goal', 'another goal']),
    ).toThrow(/two different goals/i);
  });

  it('reads an unquoted goal as the one goal it plainly is', () => {
    const parsed = parseExecutionArgs('run', ['fix', 'the', 'flaky', 'retry', 'test']);
    expect(parsed.flowName).toBe('fix');
    expect(parsed.goal).toBe('the flaky retry test');
  });

  it('keeps the flags that follow a loose goal', () => {
    const parsed = parseExecutionArgs('run', ['review', 'this patch', '--target', 'staged']);
    expect(parsed.goal).toBe('this patch');
    expect(parsed.target).toBe('staged');
  });

  it('keeps asking for a goal when only the flow was named', () => {
    expect(() => parseExecutionArgs('run', ['explore'])).toThrow(/--goal/);
  });

  it('refuses anything typed loose after resume without guessing what it was', () => {
    expect(() =>
      parseExecutionArgs('resume', [
        '--run-folder',
        '/tmp/nope',
        '--checkpoint-review',
        'a new goal',
      ]),
    ).toThrow(/loads the saved flow manifest and reuses the saved goal; omit both/);
  });
});
