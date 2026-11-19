import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every case spawns real processes (holders, `node --test`, vitest runs) and waits on them.
    testTimeout: 120_000,
  },
});
