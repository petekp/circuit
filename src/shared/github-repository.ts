export interface GitHubRepositoryIdentity {
  readonly host: 'github.com';
  readonly owner: string;
  readonly name: string;
}

export interface GitHubPullRequestMergeRef {
  readonly repository: string;
  readonly ref: string;
}

const GITHUB_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;
const GITHUB_REMOTE_PROTOCOLS = new Set([
  'git:',
  'git+ssh:',
  'http:',
  'https:',
  'ssh:',
  'ssh+git:',
]);

function repositoryIdentity(owner: string, name: string): GitHubRepositoryIdentity | undefined {
  const normalizedOwner = owner.trim();
  const normalizedName = name.trim().replace(/\.git$/iu, '');
  if (
    normalizedOwner.length === 0 ||
    normalizedName.length === 0 ||
    !GITHUB_REPOSITORY_PART.test(normalizedOwner) ||
    !GITHUB_REPOSITORY_PART.test(normalizedName)
  ) {
    return undefined;
  }
  return {
    host: 'github.com',
    owner: normalizedOwner.toLowerCase(),
    name: normalizedName.toLowerCase(),
  };
}

export function githubRepositoryKey(repository: GitHubRepositoryIdentity): string {
  return `${repository.host}/${repository.owner}/${repository.name}`;
}

export function parseGitHubRepositoryKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  if (parts.length !== 3 || parts[0] !== 'github.com') return undefined;
  const owner = parts[1];
  const name = parts[2];
  if (owner === undefined || name === undefined) return undefined;
  const repository = repositoryIdentity(owner, name);
  if (repository === undefined) return undefined;
  const key = githubRepositoryKey(repository);
  return key === value ? key : undefined;
}

export function parseGitHubRemoteUrl(value: string): GitHubRepositoryIdentity | undefined {
  const trimmed = value.trim();
  const scp = /^(?:[^@\s]+@)?(?:www\.)?github\.com:(?<owner>[^/\s]+)\/(?<name>[^/\s]+)$/iu.exec(
    trimmed,
  );
  if (scp?.groups?.owner !== undefined && scp.groups.name !== undefined) {
    return repositoryIdentity(scp.groups.owner, scp.groups.name);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) ||
    !GITHUB_REMOTE_PROTOCOLS.has(parsed.protocol.toLowerCase()) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return undefined;
  }
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return undefined;
  return repositoryIdentity(parts[0], parts[1]);
}

export function githubRepositoriesFromGitConfig(output: string): readonly string[] {
  const repositories = new Set<string>();
  for (const { key, value } of gitConfigEntries(output)) {
    if (!/^remote\..+\.url$/iu.test(key)) continue;
    const repository = parseGitHubRemoteUrl(value);
    if (repository !== undefined) repositories.add(githubRepositoryKey(repository));
  }
  return Object.freeze([...repositories].sort());
}

function gitConfigEntries(
  output: string,
): readonly { readonly key: string; readonly value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf('\n');
    if (separator === -1) continue;
    entries.push({
      key: entry.slice(0, separator),
      value: entry.slice(separator + 1),
    });
  }
  return entries;
}

function fetchRefMapsPullRequest(
  refspec: string,
  number: number,
  expectedDestination: string,
): boolean {
  const normalized = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  if (normalized.startsWith('^')) return false;
  const separator = normalized.indexOf(':');
  if (separator === -1 || normalized.indexOf(':', separator + 1) !== -1) return false;
  const source = normalized.slice(0, separator);
  const destination = normalized.slice(separator + 1);
  const exactSource = `refs/pull/${number}/merge`;
  if (source === exactSource) return destination === expectedDestination;
  if (source !== 'refs/pull/*/merge') return false;
  if ((destination.match(/\*/gu) ?? []).length !== 1) return false;
  return destination.replace('*', String(number)) === expectedDestination;
}

function negativeFetchRefExcludesPullRequest(refspec: string, number: number): boolean {
  if (!refspec.startsWith('^')) return false;
  const source = refspec.slice(1);
  if (source.length === 0 || source.includes(':')) return false;
  const expectedSource = `refs/pull/${number}/merge`;
  if (source === expectedSource) return true;
  if ((source.match(/\*/gu) ?? []).length !== 1) return false;
  const wildcard = source.indexOf('*');
  const prefix = source.slice(0, wildcard);
  const suffix = source.slice(wildcard + 1);
  return (
    expectedSource.startsWith(prefix) &&
    expectedSource.endsWith(suffix) &&
    expectedSource.length >= prefix.length + suffix.length
  );
}

export function githubPullRequestMergeRefsFromGitConfig(
  output: string,
  number: number,
): readonly GitHubPullRequestMergeRef[] {
  const remotes = new Map<string, { urls: string[]; fetches: string[] }>();
  for (const { key, value } of gitConfigEntries(output)) {
    const match = /^remote\.(?<name>.+)\.(?<field>url|fetch)$/iu.exec(key);
    const name = match?.groups?.name;
    const field = match?.groups?.field?.toLowerCase();
    if (name === undefined || field === undefined) continue;
    const remote = remotes.get(name) ?? { urls: [], fetches: [] };
    if (field === 'url') remote.urls.push(value);
    else remote.fetches.push(value);
    remotes.set(name, remote);
  }

  const candidates = new Map<string, GitHubPullRequestMergeRef>();
  for (const remote of remotes.values()) {
    const repositories = new Set(
      remote.urls
        .map(parseGitHubRemoteUrl)
        .filter((repository): repository is GitHubRepositoryIdentity => repository !== undefined)
        .map(githubRepositoryKey),
    );
    if (repositories.size !== 1) continue;
    const repository = [...repositories][0];
    if (repository === undefined) continue;
    const ref = `refs/circuit/${repository}/pull/${number}/merge`;
    if (remote.fetches.some((fetch) => negativeFetchRefExcludesPullRequest(fetch, number))) {
      continue;
    }
    if (!remote.fetches.some((fetch) => fetchRefMapsPullRequest(fetch, number, ref))) continue;
    candidates.set(`${repository}\0${ref}`, { repository, ref });
  }
  return Object.freeze(
    [...candidates.values()].sort((left, right) =>
      `${left.repository}\0${left.ref}`.localeCompare(`${right.repository}\0${right.ref}`),
    ),
  );
}
