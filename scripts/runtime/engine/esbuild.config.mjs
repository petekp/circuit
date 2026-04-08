import { build } from "esbuild";

const ENTRY_POINTS = [
  "src/cli/append-event.ts",
  "src/cli/catalog-compiler.ts",
  "src/cli/dispatch.ts",
  "src/cli/derive-state.ts",
  "src/cli/read-config.ts",
  "src/cli/resume.ts",
  "src/cli/update-batch.ts",
];

const outdir = new URL("../bin", import.meta.url).pathname;

await build({
  entryPoints: ENTRY_POINTS,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir,
  outbase: "src/cli",
  external: [],
  minifyWhitespace: true,
  keepNames: true,
});

console.log(`Bundled ${ENTRY_POINTS.length} CLIs to ${outdir}/`);
