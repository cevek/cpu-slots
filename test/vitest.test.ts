import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holder, killAll, linux, oneAtATime, poolEnv, repo, run, within } from './support/procs.ts';

afterEach(killAll);

const VITEST = join(repo, 'node_modules', 'vitest', 'vitest.mjs');

/** A project of its own under the repo: `cpu-slots` reached through `node_modules`, as a consumer does. */
function project(name: string, config: Record<string, unknown>, files: Record<string, string>): { dir: string; journal: string } {
  const dir = join(repo, '.fixtures', `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(repo, join(dir, 'node_modules', 'cpu-slots'));
  const journal = join(dir, 'journal');
  writeFileSync(
    join(dir, 'vitest.config.mjs'),
    `export default { test: ${JSON.stringify({ include: ['*.test.mjs'], setupFiles: ['cpu-slots/vitest'], ...config })} };\n`,
  );
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body.replaceAll('JOURNAL', JSON.stringify(journal)));
  return { dir, journal };
}

const timed = (name: string, testName = 'x') =>
  `import { test } from 'vitest';\nimport { appendFileSync } from 'node:fs';\ntest('${testName}', async () => {\n  appendFileSync(JOURNAL, 'start ${name}\\n');\n  await new Promise((r) => setTimeout(r, 300));\n  appendFileSync(JOURNAL, 'end ${name}\\n');\n});\n`;

const journalOf = (journal: string) => (existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n') : []);

/** The most files a journal shows running at once. */
function widest(lines: string[]): number {
  let open = 0;
  let most = 0;
  for (const l of lines) {
    open += l.startsWith('start ') ? 1 : -1;
    most = Math.max(most, open);
  }
  return most;
}

/** Runs the project while a process outside it holds the pool's only slot for `holdMs`. */
async function runBesideHolder(dir: string, pool: string, holdMs: number, args: string[] = []) {
  const env = poolEnv(pool, 1);
  const outside = holder(env);
  expect(await within(outside.held)).toBe(true);
  const release = setTimeout(() => outside.child.stdin!.end(), holdMs);
  try {
    return await run([VITEST, 'run', ...args], env, dir);
  } finally {
    clearTimeout(release);
  }
}

describe.runIf(linux)('under a pool of one', () => {
  for (const pool of ['forks', 'threads'] as const) {
    for (const isolate of [true, false]) {
      it(`${pool}, isolate ${isolate}: test files run one at a time, and the run ends`, async () => {
        const p = project(`v-${pool}-${isolate}`, { pool, isolate, maxWorkers: 3 }, { 'a.test.mjs': timed('a'), 'b.test.mjs': timed('b'), 'c.test.mjs': timed('c') });
        try {
          const r = await run([VITEST, 'run'], poolEnv(`v-${pool}-${isolate}`, 1), p.dir);
          expect(r.code, r.out).toBe(0);
          expect(oneAtATime(journalOf(p.journal), 3), journalOf(p.journal).join('|')).toBe(true);
        } finally {
          rmSync(p.dir, { recursive: true, force: true });
        }
      });
    }
  }

  for (const isolate of [true, false]) {
    // A file that fails to import and one whose only test is filtered out run no hook: neither may
    // leave its worker holding the slot while the other workers wait for it.
    it(`forks, isolate ${isolate}: a file failing its import and a filtered-out one keep no slot`, async () => {
      const p = project(`v-skip-${isolate}`, { pool: 'forks', isolate, maxWorkers: 2 }, {
        'a.test.mjs': timed('a'),
        'b.test.mjs': `throw new Error('this file fails to import');\n`,
        'c.test.mjs': timed('c'),
        'd.test.mjs': timed('d', 'filtered-out'),
        'e.test.mjs': timed('e'),
      });
      try {
        const r = await run([VITEST, 'run', '-t', '^x$'], poolEnv(`v-skip-${isolate}`, 1), p.dir);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toMatch(/this file fails to import/);
        expect(oneAtATime(journalOf(p.journal), 3), journalOf(p.journal).join('|')).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    });
  }

  // Both files throw in their own afterAll: whichever the worker runs first, the second needs the
  // slot the first had — in the same process, where a slot not given back is a wait for itself.
  it("one worker, isolate false: a file whose own afterAll throws gives the slot back, and the worker's next file gets it", async () => {
    const throwing = (name: string) => `import { afterAll } from 'vitest';\nafterAll(() => { throw new Error('afterAll of ${name} throws'); });\n${timed(name)}`;
    const p = project('v-afterall', { pool: 'forks', isolate: false, maxWorkers: 1 }, { 'a.test.mjs': throwing('a'), 'b.test.mjs': throwing('b') });
    try {
      const r = await run([VITEST, 'run'], poolEnv('v-afterall', 1), p.dir, 30_000);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/afterAll of a throws/);
      expect(r.out).toMatch(/afterAll of b throws/);
      expect(oneAtATime(journalOf(p.journal), 2), journalOf(p.journal).join('|')).toBe(true);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("a wait longer than vitest's hook timeout fails no file", async () => {
    const p = project('v-longwait', { pool: 'forks', hookTimeout: 1_000 }, { 'a.test.mjs': timed('a') });
    try {
      const r = await runBesideHolder(p.dir, 'v-longwait', 3_000);
      expect(r.code, r.out).toBe(0);
      expect(journalOf(p.journal)).toEqual(['start a', 'end a']);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('a file that fakes the timers at import still gets its slot once it is freed', async () => {
    const p = project('v-faketimers', { pool: 'forks' }, {
      'a.test.mjs': `import { test, vi } from 'vitest';\nvi.useFakeTimers();\ntest('a', () => {});\n`,
    });
    try {
      const r = await runBesideHolder(p.dir, 'v-faketimers', 1_500);
      expect(r.code, r.out).toBe(0);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

// That both slots get used is the core's (`a pool of two is held by exactly two processes`); here, the bound.
it.runIf(linux)('under a pool of two, never three test files at once', async () => {
  const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`${n}.test.mjs`, timed(n)]));
  const p = project('v-two', { pool: 'forks', maxWorkers: 4 }, files);
  try {
    const r = await run([VITEST, 'run'], poolEnv('v-two', 2), p.dir);
    expect(r.code, r.out).toBe(0);
    const lines = journalOf(p.journal);
    expect(lines).toHaveLength(12);
    expect(widest(lines), lines.join('|')).toBeLessThanOrEqual(2);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

it('anywhere: a run with the setup file passes', async () => {
  const p = project('v-smoke', { pool: 'forks' }, { 'a.test.mjs': timed('a'), 'b.test.mjs': timed('b') });
  try {
    const r = await run([VITEST, 'run'], poolEnv('v-smoke', 4), p.dir);
    expect(r.code, r.out).toBe(0);
    expect(journalOf(p.journal)).toHaveLength(4);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
