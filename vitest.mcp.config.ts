import { defineConfig } from 'vitest/config';

// Keep the process-heavy MCP experiment in the canonical test gate without
// making its short cleanup deadlines compete with the rest of the repository.
export default defineConfig({
  test: {
    include: ['experiments/circuit-mcp-spike/mcp/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
