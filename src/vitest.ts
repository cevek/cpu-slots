// A vitest setup file (`setupFiles: ['cpu-slots/vitest']`): each test file runs inside a slot, taken
// in an `aroundAll` and given back in its `finally`. Registered first, this wrapper is the outermost
// one: the `finally` runs after every `afterAll`, cleanup and file fixture of the file, a throwing
// one included. A file whose tests are all filtered out, or that failed to import, runs no hook —
// so a slot never stays with a worker that has no file to run.
// The price: importing and transforming the file run outside the slot.
import { aroundAll } from 'vitest';
import { acquireSlot, WAIT_CEILING_MS } from './index.ts';

const HELD = 'CPU_SLOTS_HELD';

aroundAll(
  async (runSuite) => {
    const slot = await acquireSlot();
    // Only a slot taken here changes the mark: one inherited from a holder above stays as it is.
    const mark = slot.env[HELD];
    const before = process.env[HELD];
    if (mark !== undefined) process.env[HELD] = mark;
    try {
      await runSuite();
    } finally {
      slot.release();
      if (mark !== undefined) {
        if (before === undefined) delete process.env[HELD];
        else process.env[HELD] = before;
      }
    }
  },
  // The wait is the machine's, not the hook's: it ends with a slot or past the ceiling.
  WAIT_CEILING_MS + 60_000,
);
