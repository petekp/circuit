// Inert stand-in for `react-devtools-core` in the bundled plugin runtime.
//
// Ink's reconciler imports react-devtools-core behind a
// `process.env['DEV'] === 'true'` guard (bracket access, which esbuild's
// `define` cannot substitute, so the import survives dead-code elimination).
// The package is a devtools opt-in we never ship; aliasing it here satisfies
// the bundler while the runtime guard keeps it unreachable in production.
export default undefined;
