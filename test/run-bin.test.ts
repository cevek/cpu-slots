import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { ABSENT_MS, gone, hasLine, holder, killAll, killPids, lineIn, linux, pause, pidOf, poolEnv, repo, run, start, track, within } from './support/procs.ts';

afterEach(killAll);

const RUN = join(repo, 'dist', 'run-bin.js');
// The command: says what it got, as `@slots@` and in the env, and exits with a code of its own.
const SAYS = ['-e', "console.log('width ' + process.argv[1] + ' ' + process.env.CPU_SLOTS_WIDTH); process.exit(3)"];

/** JS for a command: `say(line)` appends a line to the journal. */
const sayTo = (journal: string) => `const say = (l) => require('fs').appendFileSync(${JSON.stringify(journal)}, l + '\\n');`;
const count = (journal: string, line: string) => readFileSync(journal, 'utf8').split('\n').filter((l) => l === line).length;
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

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
  const r = await run([RUN, '--max', '4', '--', process.execPath, ...SAYS, '@slots@'], env);
  expect(r.code, r.out).toBe(3);
  expect(r.out.trim()).toBe('width 2 2');
});

it.runIf(linux)('takes no more than --max: of a free pool of three, --max 2 leaves one slot free while it runs', async () => {
  const s = scratch('run-max');
  try {
    const env = poolEnv('run-max', 3);
    const stop = join(s.dir, 'stop');
    // Runs until the test lets it go: a slot it took past --max would stay taken all along.
    const cmd = start([RUN, '--max', '2', '--', process.execPath, '-e', `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(s.journal)}, 'running ' + process.argv[1] + '\\n'); setInterval(() => fs.existsSync(${JSON.stringify(stop)}) && process.exit(0), 50)`, '@slots@'], env);
    expect(await lineIn(s.journal, 'running 2')).toBe(true);
    const one = holder(env);
    expect(await within(one.held, 10_000)).toBe(true);
    const two = holder(env);
    await pause(ABSENT_MS);
    expect(two.count()).toBe(0);
    writeFileSync(stop, '');
    expect((await cmd.done).code).toBe(0);
  } finally {
    // Let the command go before its dir does, whatever failed above: it waits for that file alone.
    writeFileSync(join(s.dir, 'stop'), '');
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)("a wrapper inside another's command, in a pool of one: it takes no slot, its width is 1, it does not wait", async () => {
  // The outer one holds the only slot; the inner one would wait for it to the end, had its env no mark.
  const inner = [RUN, '--max', '4', '--', process.execPath, '-e', "console.log('inner width ' + process.env.CPU_SLOTS_WIDTH)"];
  const r = await run([RUN, '--', process.execPath, ...inner], poolEnv('run-nested', 1), repo, 20_000);
  expect(r.code, r.out).toBe(0);
  expect(r.out.trim()).toBe('inner width 1');
});

it.runIf(linux)("a kill of the caller's group takes the command: a SIGKILL to the wrapper cannot be passed on", async () => {
  const s = scratch('run-group-kill');
  try {
    const cmd = start([RUN, '--', process.execPath, '-e', `${sayTo(s.journal)} say('pid command ' + process.pid); setInterval(() => {}, 1000);`], poolEnv('run-group-kill', 2));
    const pid = await pidOf(s.journal, 'command');
    expect(pid).toBeGreaterThan(0);
    // `start` makes the wrapper a group leader: its group is the caller's group here.
    process.kill(-cmd.pid, 'SIGKILL');
    expect(await gone(pid)).toBe(true);
  } finally {
    killPids(s.journal);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// Says each SIGINT it gets; on SIGTERM says so and exits.
const COUNTS = (journal: string) =>
  `${sayTo(journal)} process.on('SIGINT', () => say('SIGINT')); for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => { say(s); process.exit(0); }); say('pid command ' + process.pid); setInterval(() => {}, 1000);`;
const signalsIn = (journal: string) => readFileSync(journal, 'utf8').split('\n').filter((l) => l.startsWith('SIG'));

const SPY = join(repo, 'test', 'support', 'kill-spy.mjs');

for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  it(`a ${sig} to the wrapper reaches the command as itself`, async () => {
    const s = scratch(`run-${sig}`);
    try {
      const cmd = start([RUN, '--', process.execPath, '-e', COUNTS(s.journal)], poolEnv(`run-${sig}`, 0));
      expect(await pidOf(s.journal, 'command')).toBeGreaterThan(0);
      process.kill(cmd.pid, sig);
      expect((await cmd.done).code).toBe(0);
      expect(signalsIn(s.journal)).toEqual([sig]);
    } finally {
      killPids(s.journal);
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
}

it('a SIGINT to the wrapper alone, with no terminal, reaches the command once', async () => {
  const s = scratch('run-sigint');
  try {
    const spied = join(s.dir, 'spy');
    const cmd = start(['--import', SPY, RUN, '--', process.execPath, '-e', COUNTS(s.journal)], poolEnv('run-sigint', 0, { KILL_SPY: spied }));
    const pid = await pidOf(s.journal, 'command');
    expect(pid).toBeGreaterThan(0);
    process.kill(cmd.pid, 'SIGINT');
    expect(await lineIn(spied, 'SIGINT handled 2', 10_000)).toBe(true);
    // Sent once: two sends pending at once would reach the command as one.
    expect(readFileSync(spied, 'utf8').split('\n').filter((l) => l === `kill ${pid} SIGINT`)).toHaveLength(1);
    expect(await lineIn(s.journal, 'SIGINT', 10_000)).toBe(true);
    process.kill(cmd.pid, 'SIGTERM');
    expect((await cmd.done).code).toBe(0);
    expect(count(s.journal, 'SIGINT')).toBe(1);
  } finally {
    killPids(s.journal);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

const hasScript = linux && spawnSync('script', ['--version']).status === 0;

/**
 * The wrapper, spied on, under `script`: in a session of its own on a pty, with that pty as its
 * terminal; its stdin is not the terminal, so only the foreground check can tell where it is. In the
 * pty's foreground group, or with `background` a job of its own in a job-controlling sh.
 */
async function onPty(s: { dir: string; journal: string }, background: boolean) {
  // `.cjs`: the package is ESM, and the command uses `require`.
  const file = join(s.dir, 'command.cjs');
  writeFileSync(file, COUNTS(s.journal));
  const spied = join(s.dir, 'spy');
  const wrapped = [process.execPath, '--import', SPY, RUN, '--', process.execPath, file].map(q).join(' ');
  // In the foreground its stdin is not the terminal, in the background it is: either way only the
  // foreground check tells where it is, not stdin.
  const line = background ? `/bin/sh -c ${q(`set -m; ${wrapped} & wait`)}` : `${wrapped} < /dev/null`;
  const term = track(spawn('script', ['-qec', line, '/dev/null'], { env: poolEnv(`pty-${background}`, 2, { KILL_SPY: spied }), stdio: 'pipe', detached: true }));
  const pid = await pidOf(s.journal, 'command');
  expect(pid).toBeGreaterThan(0);
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
  const [wrapper, pgrp, tty, tpgid] = [Number(f[1]), Number(f[2]), Number(f[4]), Number(f[5])];
  expect(tty).not.toBe(0);
  if (background) expect(tpgid).not.toBe(pgrp);
  else expect(tpgid).toBe(pgrp);
  expect(readlinkSync(`/proc/${wrapper}/fd/0`).startsWith('/dev/pts/')).toBe(background);
  const sent = () => readFileSync(spied, 'utf8').split('\n').filter((l) => l === `kill ${pid} SIGINT`).length;
  return { pid, wrapper, spied, term, sent };
}

it.runIf(hasScript)("Ctrl-C in the terminal's foreground group reaches the command once: the wrapper does not pass it on", async () => {
  const s = scratch('run-ctrl-c');
  try {
    const { pid, wrapper, spied, term, sent } = await onPty(s, false);
    // Ctrl-C sends SIGINT to every process of the group; here one at a time: the command, handled,
    // then the wrapper.
    process.kill(pid, 'SIGINT');
    expect(await lineIn(s.journal, 'SIGINT', 10_000)).toBe(true);
    process.kill(wrapper, 'SIGINT');
    // The wrapper's handlers have run; what they sent is in the spy's journal before this line.
    expect(await lineIn(spied, 'SIGINT handled 2', 10_000)).toBe(true);
    expect(sent()).toBe(0);
    process.kill(wrapper, 'SIGTERM');
    expect(await gone(pid)).toBe(true);
    expect(count(s.journal, 'SIGINT')).toBe(1);
    term.stdin!.end();
  } finally {
    killPids(s.journal);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(hasScript)('a SIGINT to a wrapper in the background of its terminal reaches the command once: a terminal is not the foreground', async () => {
  const s = scratch('run-bg-sigint');
  try {
    const { pid, wrapper, spied, term, sent } = await onPty(s, true);
    process.kill(wrapper, 'SIGINT');
    expect(await lineIn(spied, 'SIGINT handled 2', 10_000)).toBe(true);
    expect(sent()).toBe(1);
    expect(await lineIn(s.journal, 'SIGINT', 10_000)).toBe(true);
    process.kill(wrapper, 'SIGTERM');
    expect(await gone(pid)).toBe(true);
    term.stdin!.end();
  } finally {
    killPids(s.journal);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

it.runIf(linux)('waits for its first slot: nothing runs while the pool is full', async () => {
  const s = scratch('run-wait');
  try {
    const env = poolEnv('run-wait', 1);
    const outside = holder(env);
    expect(await within(outside.held)).toBe(true);
    const cmd = start([RUN, '--max', '2', '--', process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(s.journal)}, 'ran ' + process.argv[1] + '\\n')`, '@slots@'], env);
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
  const r = await run([RUN, '--max', '5', process.execPath, ...SAYS, '@slots@'], poolEnv('run-off', 0));
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
  const r = await run([RUN, '--max', '3', process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', '--max', '@slots@', '--'], poolEnv('run-args', 0));
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
