import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ABSENT_MS, hasLine, holder, killAll, lineIn, linux, pause, poolEnv, repo, run, start, within } from './support/procs.ts';

afterEach(killAll);

const RUN = join(repo, 'dist', 'run-bin.js');
// The command: says what it got, as `{slots}` and in the env, and exits with a code of its own.
const SAYS = ['-e', "console.log('width ' + process.argv[1] + ' ' + process.env.CPU_SLOTS_WIDTH); process.exit(3)"];

function scratch(name: string): { dir: string; journal: string } {
  const dir = join(repo, '.fixtures', `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return { dir, journal: join(dir, 'journal') };
}

it.runIf(linux)('takes the free slots up to --max, hands their number to the command, passes its exit code', async () => {
  const env = poolEnv('run-width', 3);
  const outside = holder(env);
  expect(await within(outside.held)).toBe(true);
  const r = await run([RUN, '--max', '4', '--', process.execPath, ...SAYS, '{slots}'], env);
  expect(r.code, r.out).toBe(3);
  expect(r.out.trim()).toBe('width 2 2');
});

it.runIf(linux)('takes no more than --max: of a free pool of three, --max 2 leaves one slot free while it runs', async () => {
  const s = scratch('run-max');
  try {
    const env = poolEnv('run-max', 3);
    const stop = join(s.dir, 'stop');
    // Runs until the test lets it go: a slot it took past --max would stay taken all along.
    const cmd = start([RUN, '--max', '2', '--', process.execPath, '-e', `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(s.journal)}, 'running ' + process.argv[1] + '\\n'); setInterval(() => fs.existsSync(${JSON.stringify(stop)}) && process.exit(0), 50)`, '{slots}'], env);
    expect(await lineIn(s.journal, 'running 2')).toBe(true);
    const one = holder(env);
    expect(await within(one.held, 10_000)).toBe(true);
    const two = holder(env);
    await pause(ABSENT_MS);
    expect(two.count()).toBe(0);
    writeFileSync(stop, '');
    expect((await cmd.done).code).toBe(0);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)("inside an ancestor's slot of the pool it takes none, and the width is 1", async () => {
  const env = poolEnv('run-nested', 4, { CPU_SLOTS_HELD: `t${process.pid}-run-nested` });
  const r = await run([RUN, '--max', '4', '--', process.execPath, ...SAYS, '{slots}'], env);
  expect(r.code, r.out).toBe(3);
  expect(r.out.trim()).toBe('width 1 1');
});

it.runIf(linux)('what the command leaves running in its group goes with it', async () => {
  const s = scratch('run-leftover');
  try {
    // The command starts a child in its own group, says its pid, and exits at once.
    const r = await run([RUN, '--', process.execPath, '-e', `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(s.journal)}, String(c.pid)); c.unref();`], poolEnv('run-leftover', 2));
    expect(r.code, r.out).toBe(0);
    const pid = Number(readFileSync(s.journal, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The kill is a signal, the exit follows it.
    for (let i = 0; i < 40 && alive(); i++) await pause(50);
    expect(alive()).toBe(false);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)('waits for its first slot: nothing runs while the pool is full', async () => {
  const s = scratch('run-wait');
  try {
    const env = poolEnv('run-wait', 1);
    const outside = holder(env);
    expect(await within(outside.held)).toBe(true);
    const cmd = start([RUN, '--max', '2', '--', process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(s.journal)}, 'ran ' + process.argv[1] + '\\n')`, '{slots}'], env);
    await pause(ABSENT_MS);
    expect(existsSync(s.journal)).toBe(false);
    outside.child.stdin!.end();
    const r = await cmd.done;
    expect(r.code, r.out).toBe(0);
    expect(hasLine(s.journal, 'ran 1')).toBe(true);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)('holds its slots until the command ends', async () => {
  const s = scratch('run-hold');
  try {
    const env = poolEnv('run-hold', 1);
    const cmd = start([RUN, '--', process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(s.journal)}, 'running\\n'); setTimeout(() => {}, 1500)`], env);
    expect(await lineIn(s.journal, 'running')).toBe(true);
    const next = holder(env);
    await pause(ABSENT_MS);
    expect(next.count()).toBe(0);
    expect((await cmd.done).code).toBe(0);
    expect(await within(next.held)).toBe(true);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it('with no pool it takes no slot and the width is --max', async () => {
  const r = await run([RUN, '--max', '5', process.execPath, ...SAYS, '{slots}'], poolEnv('run-off', 0));
  expect(r.code, r.out).toBe(3);
  expect(r.out.trim()).toBe('width 5 5');
});

it.each([
  [['--mx', '2', '--'], /unknown option --mx/],
  [['--max'], /--max needs a whole number/],
  [['--max', '0', '--'], /--max needs a whole number/],
  [['--max', '1.5', '--'], /--max needs a whole number/],
  [['--max', '99999', '--'], /--max needs a whole number/],
])('a command line it cannot read runs nothing: %j', async (opts, problem) => {
  const r = await run([RUN, ...opts, process.execPath, ...SAYS], poolEnv('run-bad', 2));
  expect(r.code).toBe(2);
  expect(r.out).toMatch(problem);
  expect(r.out).not.toMatch(/width/);
});

it('no command is a usage error', async () => {
  const r = await run([RUN, '--max', '2', '--'], poolEnv('run-none', 2));
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/no command to run/);
});

it("the command's own options are its own, past its name", async () => {
  // `--` after the script: what follows is the script's, not node's own options.
  const r = await run([RUN, '--max', '3', process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', '--max', '{slots}', '--'], poolEnv('run-args', 0));
  expect(r.code, r.out).toBe(0);
  expect(JSON.parse(r.out.trim())).toEqual(['--max', '3', '--']);
});

it('every bin of the package is built executable', () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  for (const file of Object.values(manifest.bin)) {
    const path = join(repo, file);
    expect(statSync(path).mode & 0o111, file).not.toBe(0);
    expect(readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node'), file).toBe(true);
  }
});
