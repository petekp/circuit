import { describe, expect, it } from 'vitest';

import {
  githubPullRequestMergeRefsFromGitConfig,
  githubRepositoriesFromGitConfig,
  parseGitHubRemoteUrl,
} from '../../src/shared/github-repository.js';

describe('GitHub repository identity', () => {
  it.each([
    'https://github.com/Acme/Widget.git',
    'https://www.github.com/Acme/Widget.git',
    'http://github.com/Acme/Widget',
    'ssh://git@github.com/Acme/Widget.git',
    'git+ssh://git@github.com/Acme/Widget.git',
    'ssh+git://git@github.com/Acme/Widget.git',
    'git@github.com:Acme/Widget.git',
    'github.com:Acme/Widget.git',
  ])('normalizes supported remote URL %j', (remote) => {
    expect(parseGitHubRemoteUrl(remote)).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'widget',
    });
  });

  it.each([
    'file://github.com/acme/widget.git',
    'ftp://github.com/acme/widget.git',
    'https://github.com/acme/widget/pull/123',
    'https://github.com/acme/widget.git?token=secret',
    'https://github.com/acme',
    'https://github.example.com/acme/widget.git',
    'https://evilgithub.com/acme/widget.git',
  ])('rejects non-remote or mismatched URL %j', (remote) => {
    expect(parseGitHubRemoteUrl(remote)).toBeUndefined();
  });

  it('returns only normalized fetch-remote repositories from local config', () => {
    const output = [
      'remote.origin.url\nhttps://github.com/Acme/Widget.git',
      'remote.origin.pushurl\nhttps://github.com/other/project.git',
      'remote.upstream.url\ngit@github.com:OPENAI/Codex.git',
      'remote.invalid.url\nfile://github.com/secret/leak.git',
      'credential.helper\nhostile',
      '',
    ].join('\0');

    expect(githubRepositoriesFromGitConfig(output)).toEqual([
      'github.com/acme/widget',
      'github.com/openai/codex',
    ]);
  });

  it('accepts only repository-namespaced PR merge refspecs', () => {
    const output = [
      'remote.origin.url\nhttps://github.com/Acme/Widget.git',
      'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*',
      'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
      '',
    ].join('\0');

    expect(githubPullRequestMergeRefsFromGitConfig(output, 42)).toEqual([
      {
        repository: 'github.com/acme/widget',
        ref: 'refs/circuit/github.com/acme/widget/pull/42/merge',
      },
    ]);
  });

  it('does not treat a global or differently-namespaced PR ref as repository provenance', () => {
    const output = [
      'remote.origin.url\nhttps://github.com/other/project.git',
      'remote.origin.fetch\n+refs/pull/*/merge:refs/pull/*/merge',
      'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
      '',
    ].join('\0');

    expect(githubPullRequestMergeRefsFromGitConfig(output, 42)).toEqual([]);
  });

  it.each(['^refs/pull/42/merge', '^refs/pull/*/merge'])(
    'lets a negative fetch refspec exclude a matching PR candidate: %s',
    (negativeRefspec) => {
      const output = [
        'remote.origin.url\nhttps://github.com/acme/widget.git',
        'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
        `remote.origin.fetch\n${negativeRefspec}`,
        '',
      ].join('\0');

      expect(githubPullRequestMergeRefsFromGitConfig(output, 42)).toEqual([]);
    },
  );

  it('does not pair URL and fetch values from case-distinct remote names', () => {
    const output = [
      'remote.Origin.url\nhttps://github.com/acme/widget.git',
      'remote.origin.fetch\n+refs/pull/*/merge:refs/circuit/github.com/acme/widget/pull/*/merge',
      '',
    ].join('\0');

    expect(githubPullRequestMergeRefsFromGitConfig(output, 42)).toEqual([]);
  });
});
