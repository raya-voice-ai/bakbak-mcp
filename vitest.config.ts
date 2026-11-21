import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          // Staging serves one request per model at a time: never run live files in parallel.
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
