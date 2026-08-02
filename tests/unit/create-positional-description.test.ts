// `circuit create "review a PR for accessibility regressions"` is how a
// person types it. Both commands used to answer "unexpected argument", and a
// bare invocation answered "--description is required" with no example of
// what a description looks like.
import { describe, expect, it } from 'vitest';
import { parseCreateArgs } from '../../src/cli/create.js';
import { parseGenerateArgs } from '../../src/cli/generate.js';

describe('the flow idea typed where a person puts it', () => {
  it('reads the first argument as the description', () => {
    expect(parseCreateArgs(['review a pull request for accessibility']).description).toBe(
      'review a pull request for accessibility',
    );
    expect(parseGenerateArgs(['port a fix across three services']).description).toBe(
      'port a fix across three services',
    );
  });

  it('still reads --description when the description is flagged', () => {
    expect(parseCreateArgs(['--description', 'an idea']).description).toBe('an idea');
    expect(parseGenerateArgs(['--description', 'a task']).description).toBe('a task');
  });

  it('refuses two different descriptions', () => {
    expect(() => parseCreateArgs(['one idea', '--description', 'another'])).toThrow(
      /two different flow ideas/,
    );
    expect(() => parseGenerateArgs(['one task', '--description', 'another'])).toThrow(
      /two different tasks to encode/,
    );
  });

  it('reads an unquoted description as the one description it plainly is', () => {
    // The likeliest mistake of all, and the one with only one reading.
    expect(
      parseCreateArgs(['review', 'a', 'pull', 'request', 'for', 'accessibility']).description,
    ).toBe('review a pull request for accessibility');
  });

  it('shows what a description looks like when none was given', () => {
    expect(() => parseCreateArgs([])).toThrow(/circuit create "review a pull request/);
    expect(() => parseGenerateArgs([])).toThrow(/circuit generate "port a bug fix/);
  });

  it('keeps the flags that follow a loose description', () => {
    const args = parseCreateArgs(['an idea', '--name', 'my-flow', '--decompose']);
    expect(args.description).toBe('an idea');
    expect(args.name).toBe('my-flow');
    expect(args.decompose).toBe(true);
  });
});
