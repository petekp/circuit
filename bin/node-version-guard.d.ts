// Types for the plain-JavaScript Node version guard (node-version-guard.js).
// The guard ships as .js so it runs on a too-old Node; this declaration lets
// TypeScript callers and tests import it with types.

export declare const REQUIRED_NODE: { readonly major: number; readonly minor: number };

export declare function nodeVersionError(
  currentVersion: string,
  required: { readonly major: number; readonly minor: number },
): string | undefined;

export declare function assertNodeVersion(): void;
