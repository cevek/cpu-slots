import { afterEach, describe, expect, it } from 'vitest';
import { acquireSlot, pool } from '../src/index.ts';
import { ABSENT_MS, holder, killAll, linux, pause, poolEnv, within } from './support/procs.ts';

afterEach(killAll);

describe('off', () => {
  it('CPU_SLOTS=0 is no pool, and a slot comes at once, empty', async () => {
    const env = poolEnv('off', 0);
    expect(pool(env)).toBeNull();
    expect((await acquireSlot(env)).env).toEqual({});
  });

  it.runIf(!linux)('anywhere but Linux there is no pool', () => {
    expect(pool(poolEnv('elsewhere', 4))).toBeNull();
  });
});

describe.runIf(linux)('across processes', () => {
  it('a pool of two is held by exactly two processes; a holder killed with SIGKILL frees its slot', async () => {
    const three = [0, 1, 2].map(() => holder(poolEnv('two', 2)));
    let held = 0;
    const two = new Promise<void>((r) => three.forEach((h) => void h.held.then(() => ++held === 2 && r())));
    expect(await within(two)).toBe(true);
    await pause(ABSENT_MS);
    const holding = three.filter((h) => h.count() > 0);
    expect(holding).toHaveLength(2);
    const waiting = three.find((h) => h.count() === 0)!;
    holding[0]!.child.kill('SIGKILL');
    expect(await within(waiting.held)).toBe(true);
  });

  it('a release hands the slot to a process that waited while it was held', async () => {
    const own = await acquireSlot(poolEnv('one', 1));
    const next = holder(poolEnv('one', 1));
    await pause(ABSENT_MS);
    expect(next.count()).toBe(0);
    own.release();
    expect(await within(next.held)).toBe(true);
  });

  it('in one process a waiter of a free pool is served while a waiter of a full pool polls', async () => {
    const elsewhere = holder(poolEnv('full', 1));
    await within(elsewhere.held);
    const stuck = acquireSlot(poolEnv('full', 1));
    expect(await within(acquireSlot(poolEnv('free', 1)).then((s) => s.release()))).toBe(true);
    elsewhere.child.kill('SIGKILL');
    (await stuck).release();
  });

  it('two node:cluster workers of a pool of one: exactly one holds it', async () => {
    const workers = holder(poolEnv('cluster', 1), 'cluster');
    expect(await within(workers.held)).toBe(true);
    await pause(ABSENT_MS);
    expect(workers.count()).toBe(1);
  });

  it("a holder's child, with the env its slot gives, passes while the only slot is its parent's", async () => {
    const nest = holder(poolEnv('nested', 1), 'nest');
    expect(await within(nest.times(2))).toBe(true);
  });
});
