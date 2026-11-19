import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killAll, poolEnv, repo, run } from './support/procs.ts';

afterEach(killAll);

/** A copy of the package laid out as `parts` say, under `.fixtures/<under>`. */
function layout(under: string, parts: string[]): string {
  const dir = join(repo, '.fixtures', `${under}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of ['bin', 'package.json', ...parts]) cpSync(join(repo, p), join(dir, p), { recursive: true });
  return dir;
}

// `src` alone: a clone the rollout made, no build. `dist` alone: a published install. Both under
// node_modules: a git install, where node strips no types — it must take dist.
const LAYOUTS = [
  { kind: 'a clone with no build', under: 'clone', parts: ['src'], register: /src\/register\.ts/ },
  { kind: 'a published install', under: 'published', parts: ['dist'], register: /dist\/register\.js/ },
  { kind: 'source and build under node_modules', under: 'node_modules/cpu-slots', parts: ['src', 'dist'], register: /dist\/register\.js/ },
];

for (const l of LAYOUTS) {
  describe(l.kind, () => {
    it('cpu-slots-run runs its command with its width', async () => {
      const dir = layout(l.under, l.parts);
      try {
        const r = await run([join(dir, 'bin', 'cpu-slots-run.mjs'), '--max', '3', '--', process.execPath, '-e', "console.log('width ' + process.env.CPU_SLOTS_WIDTH)"], poolEnv('bins', 0));
        expect(r.code, r.out).toBe(0);
        expect(r.out.trim()).toBe('width 3');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('cpu-slots-node runs node --test with the preload beside it', async () => {
      const dir = layout(l.under, l.parts);
      try {
        const file = join(dir, 'a.test.mjs');
        writeFileSync(
          file,
          // The runner hands its `--import` on to the file's process as `--import=<url>`.
          "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('preload', () => {\n  const a = process.execArgv;\n  const i = a.findIndex((x) => x === '--import' || x.startsWith('--import='));\n  assert.ok(i >= 0, 'no --import: ' + a.join(' '));\n  console.log('PRELOAD ' + (a[i] === '--import' ? a[i + 1] : a[i].slice('--import='.length)));\n});\n",
        );
        const r = await run([join(dir, 'bin', 'cpu-slots-node.mjs'), '--test', file], poolEnv('bins', 2));
        expect(r.code, r.out).toBe(0);
        expect(r.out).toMatch(new RegExp('PRELOAD \\S*' + l.register.source));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
