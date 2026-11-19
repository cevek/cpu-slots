import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const linux = process.platform === 'linux';
export const repo = fileURLToPath(new URL('../..', import.meta.url));
const holderScript = fileURLToPath(new URL('./holder.mjs', import.meta.url));

const children: ChildProcess[] = [];

/** Every process a test started goes when the test ends, whatever its outcome — with its whole group. */
export function killAll(): void {
  for (const c of children.splice(0)) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
}

export function track<T extends ChildProcess>(child: T): T {
  children.push(child);
  return child;
}

/** A pool of this test run's own: never the machine's, never another case's. */
export function poolEnv(name: string, slots: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CPU_SLOTS: String(slots), CPU_SLOTS_POOL: `t${process.pid}-${name}`, ...extra };
  if (!('CPU_SLOTS_HELD' in extra)) delete env['CPU_SLOTS_HELD'];
  return env;
}

export type Holder = { child: ChildProcess; held: Promise<void>; times(n: number): Promise<void>; count(): number };

export function holder(env: NodeJS.ProcessEnv, mode: 'hold' | 'nest' | 'cluster' = 'hold'): Holder {
  const child = track(spawn(process.execPath, [holderScript, mode], { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true }));
  let count = 0;
  const waits: Array<{ n: number; resolve: () => void }> = [];
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (line !== 'HELD') return;
    count++;
    for (const w of waits) if (count >= w.n) w.resolve();
  });
  const times = (n: number) => new Promise<void>((resolve) => (count >= n ? resolve() : waits.push({ n, resolve })));
  return { child, held: times(1), times, count: () => count };
}

/** A zombie is dead: under a PID 1 that reaps nothing (a container), `kill(pid, 0)` still succeeds. */
export function isAlive(pid: number): boolean {
  if (!linux) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z';
  } catch {
    return false;
  }
}

/** Resolves once `pid` is dead, or with false at the cap: a kill is a signal, the exit follows it. */
export async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= until) return false;
    await pause(50);
  }
  return true;
}

/** A test's processes write `pid <role> <n>` lines to its journal; resolves with the first of `role`, 0 at the cap. */
export async function pidOf(journal: string, role: string, ms = 30_000): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const m = existsSync(journal) ? new RegExp(`^pid ${role} (\\d+)$`, 'm').exec(readFileSync(journal, 'utf8')) : null;
    if (m) return Number(m[1]);
    if (Date.now() >= until) return 0;
    await pause(50);
  }
}

function commandLine(pid: number): string {
  if (linux) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      return '';
    }
  }
  return spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
}

/**
 * SIGKILL to every pid the journal names that is still one of the test's: a failed test leaves none of
 * its processes behind. Each has the journal's dir in its command line; a pid reused since has not.
 */
export function killPids(journal: string): void {
  if (!existsSync(journal)) return;
  for (const m of readFileSync(journal, 'utf8').matchAll(/^pid \S+ (\d+)$/gm)) {
    const pid = Number(m[1]);
    if (!commandLine(pid).includes(dirname(journal))) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
}

/** A wait's deadline is a cap: whatever it waits for returns at once. */
export async function within(p: Promise<unknown>, ms = 30_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const ok = await Promise.race([p.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  clearTimeout(timer);
  return ok;
}

/** Absence only: how long a process that should NOT get a slot is given to get one anyway. */
export const ABSENT_MS = 700;
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether `file` holds a line equal to `line` now. */
export function hasLine(file: string, line: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(line);
}

/** Resolves once `file` holds a line equal to `line` — a wait on the condition the check reads. */
export async function lineIn(file: string, line: string, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (hasLine(file, line)) return true;
    if (Date.now() >= until) return false;
    await pause(50);
  }
}

/** Runs a command to its end (or the cap), collecting its output. */
export async function run(args: string[], env: NodeJS.ProcessEnv, cwd = repo, ms = 90_000): Promise<{ code: number | null; out: string }> {
  const child = track(spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  // `close`, not `exit`: the output is whole only once both streams have ended.
  const ended = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
  const done = await within(ended, ms);
  return { code: done ? child.exitCode : null, out };
}

/** Starts a command like `run` and hands back its pid at once, the outcome as a promise. */
export function start(args: string[], env: NodeJS.ProcessEnv, cwd = repo, ms = 90_000) {
  const child = track(spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const ended = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
  return { pid: child.pid!, done: within(ended, ms).then((ok) => ({ code: ok ? child.exitCode : null, out })) };
}

/** A journal of `start <name>` / `end <name>` lines kept apart: each start followed by its own end. */
export function oneAtATime(lines: string[], n: number): boolean {
  return (
    lines.length === 2 * n &&
    lines.every((l, i) => {
      const [what, name] = l.split(' ');
      return what === (i % 2 === 0 ? 'start' : 'end') && (i % 2 === 0 || name === lines[i - 1]!.split(' ')[1]);
    })
  );
}
