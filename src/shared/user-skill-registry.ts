import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256OfString } from '../schemas/hashing.js';
import { SkillId, type SkillId as SkillIdValue } from '../schemas/ids.js';
import { UserSkillEntry, type UserSkillEntry as UserSkillEntryValue } from '../schemas/skill.js';

export interface UserSkillRegistryOptions {
  readonly homeDir?: string;
  readonly roots?: readonly string[];
}

export interface LoadedUserSkill {
  readonly entry: UserSkillEntryValue;
  readonly body: string;
}

export interface UserSkillRegistry {
  readonly roots: readonly string[];
  list(): readonly UserSkillEntryValue[];
  resolve(id: SkillIdValue): LoadedUserSkill;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

const UserSkillFrontmatter = UserSkillEntry.pick({
  name: true,
  description: true,
  trigger: true,
}).passthrough();

export function defaultUserSkillRoots(homeDir = homedir()): readonly string[] {
  return [join(homeDir, '.agents', 'skills'), join(homeDir, '.claude', 'skills')];
}

function parseSkillMarkdown(
  text: string,
  skillPath: string,
): {
  readonly metadata: Pick<UserSkillEntryValue, 'name' | 'description' | 'trigger'>;
  readonly body: string;
} {
  if (!text.startsWith('---')) return { metadata: {}, body: text };

  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    throw new Error(`skill frontmatter parse failed at ${skillPath}: missing closing ---`);
  }

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(match[1] ?? '');
  } catch (err) {
    throw new Error(`skill frontmatter parse failed at ${skillPath}: ${(err as Error).message}`);
  }

  const parsed = UserSkillFrontmatter.safeParse(rawFrontmatter ?? {});
  if (!parsed.success) {
    throw new Error(`skill frontmatter validation failed at ${skillPath}: ${parsed.error.message}`);
  }

  return {
    metadata: {
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
      ...(parsed.data.trigger === undefined ? {} : { trigger: parsed.data.trigger }),
    },
    body: match[2] ?? '',
  };
}

interface SkillCandidate {
  readonly id: SkillIdValue;
  readonly root: string;
  readonly path: string;
}

function discoverCandidates(roots: readonly string[]): Map<string, SkillCandidate> {
  const candidates = new Map<string, SkillCandidate>();

  for (const root of roots) {
    const rootAbs = resolve(root);
    if (!existsSync(rootAbs)) continue;
    for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = SkillId.safeParse(entry.name);
      if (!id.success) continue;
      const key = id.data as unknown as string;
      if (candidates.has(key)) continue;
      const skillPath = join(rootAbs, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      candidates.set(key, {
        id: id.data,
        root: rootAbs,
        path: skillPath,
      });
    }
  }

  return candidates;
}

function loadCandidate(candidate: SkillCandidate): LoadedUserSkill {
  let text: string;
  try {
    text = readFileSync(candidate.path, 'utf8');
  } catch (err) {
    throw new Error(
      `selected skill '${candidate.id as unknown as string}' could not be read at ${candidate.path}: ${(err as Error).message}`,
    );
  }

  const parsed = parseSkillMarkdown(text, candidate.path);
  const entry = UserSkillEntry.parse({
    id: candidate.id,
    ...parsed.metadata,
    root: candidate.root,
    path: candidate.path,
    sha256: sha256OfString(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  });

  return { entry, body: parsed.body };
}

export function createUserSkillRegistry(options: UserSkillRegistryOptions = {}): UserSkillRegistry {
  const roots = options.roots ?? defaultUserSkillRoots(options.homeDir);
  const candidates = discoverCandidates(roots);
  const searchedRoots = roots.map((root) => resolve(root));
  // Per-instance body cache shared by resolve() and list(): a skill file is read
  // at most once and the same LoadedUserSkill is returned for every later call on
  // either method. Combined with one shared registry per run
  // (RunContext.skillRegistry), this gives a true single filesystem snapshot — the
  // skill-hook dispatcher resolves a skill, caches its body, and a later relay
  // step gets that exact body, so the recorded triggered/unavailable split cannot
  // diverge from what the relay loads even if the file is changed or removed
  // mid-run.
  const cache = new Map<string, LoadedUserSkill>();
  const loadCached = (key: string, candidate: SkillCandidate): LoadedUserSkill => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const loaded = loadCandidate(candidate);
    cache.set(key, loaded);
    return loaded;
  };

  return {
    roots: searchedRoots,
    list() {
      return [...candidates.entries()].map(([key, candidate]) => loadCached(key, candidate).entry);
    },
    resolve(id: SkillIdValue) {
      const key = id as unknown as string;
      const candidate = candidates.get(key);
      if (candidate === undefined) {
        throw new Error(
          [
            `Circuit could not find skill '${key}'.`,
            'Searched:',
            ...searchedRoots.map((root) => `- ${join(root, key, 'SKILL.md')}`),
          ].join('\n'),
        );
      }
      return loadCached(key, candidate);
    },
  };
}
