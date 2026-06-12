import { configDefaults, defineConfig } from 'vitest/config';

// Coverage as info, not enforcement — no thresholds. Per the
// methodology-strip rule, ratchets stay cut until concrete pain
// justifies them. The reporter set is chosen so that:
//   - 'text' surfaces the summary in any local / CI run
//   - 'html' produces a browseable report under coverage/
//   - 'json-summary' produces a machine-parseable totals file
//     useful for ad-hoc tooling without forcing a threshold gate
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      // Benchmark fixtures are tiny standalone repos with intentionally failing
      // Node tests, plus hidden objective-check tests under objective/ that only
      // resolve once the runner overlays them onto a repo copy. None of the task
      // tree is a repo unit test — the harness runs it in isolated copies — so
      // exclude the whole tree, not just repo/ (objective/ would otherwise slip past).
      'evals/fix-vs-vanilla/tasks/**',
      'evals/fix-vs-vanilla/results/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
