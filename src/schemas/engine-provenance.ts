import { z } from 'zod';

// Which Circuit engine produced a run record.
//
// Run history was previously uncohortable: a run that failed against an engine
// from six weeks ago is indistinguishable from one that failed against HEAD, so
// mining the corpus for live bugs produced confident false positives. A version
// string alone does not separate two runs during development, where every run
// on a branch reports the same released version. The commit plus a dirty-tree
// flag is what does.
//
// The honesty rule, enforced below rather than narrated: a field appears only
// when it was actually observed.
//
//   git          the engine ran from a source checkout and git answered, so
//                both the commit and the working-tree state are known
//   build-stamp  the engine ran from a bundled install, which has no commit and
//                no working tree, so it identifies itself by the hash of the
//                bytes that ran
//   unknown      the engine could not identify itself; it says so instead of
//                guessing
//
// Why a bundle reports a digest and not a commit: the shipped bundle is
// byte-compared against its committed copy, so baking a commit into it would
// make it drift from itself on every commit. The bundle is deterministic, which
// makes a hash of its own bytes a stronger cohort key than a commit anyway — it
// names the code that actually ran, not a revision it was hopefully built from.
const EngineSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'engine sha must be a 40-character git commit');

const EngineBuildDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'engine build digest must be a sha-256 of the bundle that ran');

export const EngineProvenanceSource = z.enum(['git', 'build-stamp', 'unknown']);
export type EngineProvenanceSource = z.infer<typeof EngineProvenanceSource>;

export const EngineProvenance = z
  .object({
    version: z.string().min(1),
    source: EngineProvenanceSource,
    sha: EngineSha.optional(),
    build_digest: EngineBuildDigest.optional(),
    dirty: z.boolean().optional(),
  })
  .strict()
  .superRefine((provenance, ctx) => {
    if (provenance.source === 'git') {
      // git answered, so both facts are in hand. Omitting either would make the
      // stamp weaker than the observation behind it.
      if (provenance.sha === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['sha'],
          message: 'a git-sourced engine stamp must carry the commit git reported',
        });
      }
      if (provenance.dirty === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dirty'],
          message: 'a git-sourced engine stamp must carry the working-tree state git reported',
        });
      }
      // A source checkout runs many files, so there is no single artifact to
      // hash. A digest here would name something that does not exist.
      if (provenance.build_digest !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['build_digest'],
          message: 'a git-sourced engine ran from source, not from a single hashable bundle',
        });
      }
      return;
    }

    // A bundled install has no working tree, so it can never claim clean.
    // Silence here is the honest answer, and an explicit `false` would be a
    // claim nothing checked.
    if (provenance.dirty !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dirty'],
        message: `a ${provenance.source} engine stamp has no working tree and cannot report one`,
      });
    }

    if (provenance.sha !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha'],
        message: `a ${provenance.source} engine stamp has no commit to report`,
      });
    }

    // An engine that could not work out what it is cannot have hashed itself
    // either; the digest is how a bundle is identified in the first place.
    if (provenance.source === 'unknown' && provenance.build_digest !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['build_digest'],
        message: 'an engine that could not identify itself must not report a build digest',
      });
    }
  });
export type EngineProvenance = z.infer<typeof EngineProvenance>;
