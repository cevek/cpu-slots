import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { killAll, linux, oneAtATime, poolEnv, repo, run } from './support/procs.ts';

afterEach(killAll);

it.runIf(linux)('`node --test --import cpu-slots/register`: under a pool of one its files run one at a time, and the run ends', async () => {
  const dir = join(repo, '.fixtures', `node-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const journal = join(dir, 'journal');
  try {
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(
        join(dir, `${name}.test.mjs`),
        `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('${name}', async () => {\n  appendFileSync(${JSON.stringify(journal)}, 'start ${name}\\n');\n  await new Promise((r) => setTimeout(r, 300));\n  appendFileSync(${JSON.stringify(journal)}, 'end ${name}\\n');\n});\n`,
      );
    }
    // Three at once unless the slots keep them apart; the preload by the package's own name, as a
    // project imports it (the package resolves itself from inside its own tree).
    const files = ['a', 'b', 'c'].map((n) => join(dir, `${n}.test.mjs`));
    const r = await run(['--test', '--test-concurrency=3', '--import', 'cpu-slots/register', ...files], poolEnv('node-test', 1));
    expect(r.code, r.out).toBe(0);
    expect(oneAtATime(readFileSync(journal, 'utf8').trim().split('\n'), 3), readFileSync(journal, 'utf8')).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
