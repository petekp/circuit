import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    globals: true,
    // Many tests spawn real shell scripts, run git, and do heavy temp-dir
    // filesystem work. The default 5s timeout races against suite concurrency
    // on macOS — scale to the real cost of the work instead.
    testTimeout: 30000,
  },
});
