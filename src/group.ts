import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { isatty } from 'node:tty';

/** A process as `/proc` names it: its pid and start time, so a pid reused since is not taken for it. */
export type Proc = { pid: number; start: string };

type Stat = { ppid: number; pgrp: number; tty: number; tpgid: number; start: string };

function stat(pid: number | 'self'): Stat | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The name (field 2) may hold spaces and parens; the fields after its last `)` start at the state.
    const f = line.slice(line.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(f[1]), pgrp: Number(f[2]), tty: Number(f[4]), tpgid: Number(f[5]), start: f[19]! };
  } catch {
    return null;
  }
}

/** The process running under `pid` now (Linux). */
export function proc(pid: number): Proc | null {
  const s = stat(pid);
  return s && { pid, start: s.start };
}

/** Each of `roots` still running as noted, and every process under them, now (Linux). */
export function tree(roots: Iterable<Proc>): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = stat(Number(name));
    if (!s) continue;
    const list = children.get(s.ppid) ?? [];
    list.push({ pid: Number(name), start: s.start });
    children.set(s.ppid, list);
  }
  const out = [...roots].filter((p) => stat(p.pid)?.start === p.start);
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!.pid) ?? []));
  return out;
}

/** `sig` to each of `procs` still running under the same pid and start time, read just before. */
export function signalLive(procs: Iterable<Proc>, sig: NodeJS.Signals): void {
  for (const p of procs) {
    if (stat(p.pid)?.start !== p.start) continue;
    try {
      process.kill(p.pid, sig);
    } catch {
      // Gone since.
    }
  }
}

/** In its terminal's foreground group: a Ctrl-C there has reached the command already. */
function foreground(linux: boolean): boolean {
  if (!linux) return isatty(0);
  const s = stat('self');
  return s !== null && s.tty !== 0 && s.tpgid === s.pgrp;
}

/**
 * Runs `command` in this process's group and exits this process with its code (a signal as 128+n).
 * In the caller's group, a kill of that group (an agent tool's timeout, `kill -- -pgid`) takes the
 * command too — a SIGKILL to this process alone cannot be passed on.
 *
 * SIGTERM, SIGHUP and SIGINT to this process go to the command's whole tree (Linux; elsewhere to the
 * command alone): the command alone may exit on it and leave its children running — holding their
 * slots. SIGINT is not passed on in the terminal's foreground group: Ctrl-C has reached every process
 * of it, and a second one is a forced exit with no cleanup to vitest and npm.
 *
 * On Linux, from the first signal on the tree is noted and noted again every 100 ms (what a signal
 * handler forks is in it), and what of it still runs when the command exits gets SIGKILL: a cancel is
 * total. Each signal goes to a noted pid only under its start time, read just before; a pid reused in
 * between is left (no pidfd in Node; with `pid_max` in the millions, a reuse within milliseconds is
 * not a practical case). A command that exits with no signal here leaves what it started running.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const linux = process.platform === 'linux';
  const noted = new Map<string, Proc>();
  const note = (roots: Proc[]) => {
    for (const p of tree(roots)) noted.set(`${p.pid} ${p.start}`, p);
  };
  let rescan: NodeJS.Timeout | undefined;
  const top = () => {
    const p = child.pid && child.exitCode === null && child.signalCode === null ? proc(child.pid) : null;
    return [...(p ? [p] : []), ...noted.values()];
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const pass = sig !== 'SIGINT' || !foreground(linux);
      if (!linux) {
        if (pass) child.kill(sig);
        return;
      }
      note(top());
      rescan ??= setInterval(() => note(top()), 100);
      if (pass) signalLive(noted.values(), sig);
    });
  }
  child.on('error', (err) => {
    process.stderr.write(`${name}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (rescan) {
      clearInterval(rescan);
      // The command is gone: from here its pid may be another process's, so only what was noted.
      note([...noted.values()]);
      signalLive(noted.values(), 'SIGKILL');
    }
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
  });
}
