import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gone, hasLine, holder, killAll, killPids, lineIn, linux, oneAtATime, pidOf, poolEnv, repo, run, start, within } from './support/procs.ts';


afterEach(killAll);

const BIN = join(repo, 'dist', 'node-bin.js');
const nodeMajor = Number(process.versions.node.split('.')[0]);

function fixtures(name: string, files: Record<string, string>): { dir: string; journal: string } {
  const dir = join(repo, '.fixtures', `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const journal = join(dir, 'journal');
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body.replaceAll('JOURNAL', JSON.stringify(journal)));
  return { dir, journal };
}

const timed = (name: string) =>
  `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\nappendFileSync(JOURNAL, 'imported ${name}\\n');\ntest('${name}', async () => {\n  appendFileSync(JOURNAL, 'start ${name}\\n');\n  await new Promise((r) => setTimeout(r, 300));\n  appendFileSync(JOURNAL, 'end ${name}\\n');\n});\n`;

const journalOf = (journal: string) => readFileSync(journal, 'utf8').trim().split('\n');

it.runIf(linux)('`cpu-slots-node --test`: under a pool of one its files run one at a time, and the run ends', async () => {
  const f = fixtures('nt', { 'a.test.mjs': timed('a'), 'b.test.mjs': timed('b'), 'c.test.mjs': timed('c') });
  try {
    // Three at once unless the slots keep them apart.
    const r = await run([BIN, '--test', '--test-concurrency=3', ...['a', 'b', 'c'].map((n) => join(f.dir, `${n}.test.mjs`))], poolEnv('nt', 1));
    expect(r.code, r.out).toBe(0);
    const lines = journalOf(f.journal).filter((l) => !l.startsWith('imported '));
    expect(oneAtATime(lines, 3), lines.join('|')).toBe(true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it('`cpu-slots-node --test`: a test file that forks a node child with a cwd of its own runs it', async () => {
  // The child inherits the preload's `--import`; resolved by a bare name from that cwd it would not be found.
  const f = fixtures('nt-fork', {
    'child.mjs': `process.stdout.write('child ran');\n`,
    'a.test.mjs': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { fork } from 'node:child_process';\nimport { tmpdir } from 'node:os';\nimport { fileURLToPath } from 'node:url';\ntest('fork', async () => {\n  const c = fork(fileURLToPath(new URL('./child.mjs', import.meta.url)), [], { cwd: tmpdir(), stdio: 'pipe' });\n  let out = '';\n  c.stdout.on('data', (d) => (out += d));\n  c.stderr.on('data', (d) => (out += d));\n  const code = await new Promise((r) => c.on('close', r));\n  assert.strictEqual(code, 0, out);\n  assert.strictEqual(out, 'child ran');\n});\n`,
  });
  try {
    const r = await run([BIN, '--test', join(f.dir, 'a.test.mjs')], poolEnv('nt-fork', 2));
    expect(r.code, r.out).toBe(0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// Node 22 starts a file's `--test-timeout` before its process does, so the wait counts there (README).
it.runIf(linux && nodeMajor >= 24)('`--test-timeout` does not count the wait for a slot (Node 24+)', async () => {
  const f = fixtures('nt-timeout', {
    'a.test.mjs': timed('a'),
    'ready.mjs': `import { appendFileSync } from 'node:fs';\nif (process.env.NODE_TEST_CONTEXT?.startsWith('child')) appendFileSync(JOURNAL, 'ready\\n');\n`,
  });
  try {
    const env = poolEnv('nt-timeout', 1);
    const outside = holder(env);
    expect(await within(outside.held)).toBe(true);
    // A preload ahead of the slot's says the file's process is up: from then on it waits for the slot.
    const register = new URL('../dist/register.js', import.meta.url).href;
    const running = run(['--import', join(f.dir, 'ready.mjs'), '--import', register, '--test', '--test-timeout=1000', join(f.dir, 'a.test.mjs')], env);
    expect(await lineIn(f.journal, 'ready')).toBe(true);
    // Absence: past the timeout the file has not been imported — its process waits in the preload.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(hasLine(f.journal, 'imported a')).toBe(false);
    outside.child.stdin!.end();
    const r = await running;
    expect(r.code, r.out).toBe(0);
    expect(journalOf(f.journal)).toEqual(['ready', 'imported a', 'start a', 'end a']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// A test file that says its pid and waits a minute; on SIGHUP it says so and exits.
const waits = `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\nprocess.on('SIGHUP', () => { appendFileSync(JOURNAL, 'got SIGHUP\\n'); process.exit(1); });\ntest('a', async () => {\n  appendFileSync(JOURNAL, 'pid file ' + process.pid + '\\n');\n  await new Promise((r) => setTimeout(r, 60_000));\n});\n`;

it.runIf(linux)('a signal to `cpu-slots-node` reaches the test files: the slot one held goes free', async () => {
  const f = fixtures('nt-signal', {
    'a.test.mjs': waits,
    // The runner shrugs SIGHUP off and waits for its file: dead first, it would have the wrapper
    // SIGKILL the file before the file's handler says a word.
    'runner.mjs': `if (!process.env.NODE_TEST_CONTEXT) process.on('SIGHUP', () => {});\n`,
  });
  try {
    const env = poolEnv('nt-signal', 1);
    const wrapper = start([BIN, '--import', join(f.dir, 'runner.mjs'), '--test', join(f.dir, 'a.test.mjs')], env);
    expect(await pidOf(f.journal, 'file')).toBeGreaterThan(0);
    const next = holder(env);
    process.kill(wrapper.pid, 'SIGHUP');
    expect(await lineIn(f.journal, 'got SIGHUP', 10_000)).toBe(true);
    // Well short of the test's own minute: only the signal can free the slot this soon.
    expect(await within(next.held, 10_000)).toBe(true);
  } finally {
    killPids(f.journal);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)("a kill of the caller's group takes `cpu-slots-node`'s test files: the slot one held goes free", async () => {
  const f = fixtures('nt-group-kill', { 'a.test.mjs': waits });
  try {
    const env = poolEnv('nt-group-kill', 1);
    const wrapper = start([BIN, '--test', join(f.dir, 'a.test.mjs')], env);
    const pid = await pidOf(f.journal, 'file');
    expect(pid).toBeGreaterThan(0);
    const next = holder(env);
    // `start` makes the wrapper a group leader: an agent tool's timeout kills its group like this.
    process.kill(-wrapper.pid, 'SIGKILL');
    expect(await gone(pid)).toBe(true);
    expect(await within(next.held, 10_000)).toBe(true);
  } finally {
    killPids(f.journal);
    rmSync(f.dir, { recursive: true, force: true });
  }
});
