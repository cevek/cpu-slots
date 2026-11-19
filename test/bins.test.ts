import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killAll, linux, poolEnv, repo, run } from './support/procs.ts';

afterEach(killAll);

/** What the tarball holds, by npm's own list — not a copy of `files`. */
function packed(): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as [{ files: { path: string }[] }])[0].files.map((f) => f.path);
}

/** A copy of `paths` of the package under `.fixtures/<under>`; with `stale`, its dist/ entries of both
 *  commands fail if run. */
function layout(under: string, paths: string[], stale = false): string {
  const dir = join(repo, '.fixtures', `${under}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    cpSync(join(repo, p), join(dir, p), { recursive: true });
  }
  if (stale) for (const f of ['run-bin.js', 'node-bin.js']) writeFileSync(join(dir, 'dist', f), "console.log('stale dist ran');\nprocess.exit(9);\n");
  return dir;
}

/** The file a command of the copy's `package.json` `bin` names — what an install or a rollout runs. */
function command(dir: string, name: string): string {
  const bin = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin;
  return join(dir, bin[name]!);
}

const PACKED = packed();

// `src` alone: a clone the rollout made, no build. Both outside node_modules: a checkout whose dist/
// may be stale — it must take src. The tarball: a published install. The tarball and src under
// node_modules: a git install, where node strips no types — it must take dist.
const LAYOUTS = [
  { kind: 'a clone with no build', under: 'clone', paths: ['package.json', 'bin', 'src'], register: /src\/register\.ts/ },
  { kind: 'a checkout with a stale build', under: 'checkout', paths: ['package.json', 'bin', 'src', 'dist'], stale: true, register: /src\/register\.ts/ },
  { kind: 'a published install', under: 'published', paths: PACKED, register: /dist\/register\.js/ },
  { kind: 'source and build under node_modules', under: 'node_modules/cpu-slots', paths: [...PACKED, 'src'], register: /dist\/register\.js/ },
];

for (const l of LAYOUTS) {
  describe(l.kind, () => {
    it('cpu-slots-run runs its command with its width and passes its exit code on', async () => {
      const dir = layout(l.under, l.paths, l.stale);
      try {
        const r = await run(
          [command(dir, 'cpu-slots-run'), '--max', '3', '--', process.execPath, '-e', "console.log('width ' + process.env.CPU_SLOTS_WIDTH); process.exit(7)"],
          poolEnv('bins', 0),
        );
        expect(r.code, r.out).toBe(7);
        expect(r.out.trim()).toBe('width 3');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('cpu-slots-node runs node --test with the preload beside it, which takes a slot', async () => {
      const dir = layout(l.under, l.paths, l.stale);
      try {
        const file = join(dir, 'a.test.mjs');
        writeFileSync(
          file,
          // The runner hands its `--import` on to the file's process as `--import=<url>`.
          "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('preload', () => {\n  const a = process.execArgv;\n  const i = a.findIndex((x) => x === '--import' || x.startsWith('--import='));\n  assert.ok(i >= 0, 'no --import: ' + a.join(' '));\n  console.log('PRELOAD ' + (a[i] === '--import' ? a[i + 1] : a[i].slice('--import='.length)));\n  console.log('HELD ' + process.env.CPU_SLOTS_HELD);\n});\n",
        );
        const env = poolEnv('bins', 2);
        const r = await run([command(dir, 'cpu-slots-node'), '--test', file], env);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toMatch(new RegExp('PRELOAD \\S*' + l.register.source));
        if (linux) expect(r.out).toMatch(new RegExp(`HELD \\S*${env['CPU_SLOTS_POOL']}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
