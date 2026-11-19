import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { isatty } from 'node:tty';

/** A process as `/proc` names it: its pid and start time, so a pid reused since is not taken for it. */
export type Proc = { pid: number; start: string };

/** `cover`: the nested wrapper above it, which passes signals on to it itself while it lives. */
type Noted = Proc & { cover: Proc | null };

type Stat = { comm: string; ppid: number; pgrp: number; tty: number; tpgid: number; start: string };

// A chroot may have no /proc: then the command alone gets the signals, as on other systems.
const procfs = process.platform === 'linux' && existsSync('/proc/self/stat');
// Without CONFIG_PROC_CHILDREN the quick walk reads every process's stat instead.
const childrenFiles = procfs && existsSync(`/proc/self/task/${process.pid}/children`);

function stat(pid: number | 'self'): Stat | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The name (field 2) may hold spaces and parens; the fields after its last `)` start at the state.
    const end = line.lastIndexOf(')');
    const f = line.slice(end + 2).split(' ');
    return { comm: line.slice(line.indexOf('(') + 1, end), ppid: Number(f[1]), pgrp: Number(f[2]), tty: Number(f[4]), tpgid: Number(f[5]), start: f[19]! };
  } catch {
    return null;
  }
}

const live = (p: Proc) => stat(p.pid)?.start === p.start;

/** The process running under `pid` now (Linux). */
export function proc(pid: number): Proc | null {
  const s = stat(pid);
  return s && { pid, start: s.start };
}

// The kernel's name of a process is its title's first 15 bytes. These two, colon included, are what
// `runInGroup` makes of its title, and no program's file name.
const WRAPPER_COMMS = new Set(['cpu-slots-run: ', 'cpu-slots-node:']);

type Kid = { pid: number; s: Stat };

/**
 * A process's children, each with the stat that names it a child. `exact`: from one read of every
 * process's stat, for the walks signals go by. Else `children` files: cheap, but the kernel may skip
 * a child while a sibling exits during the read.
 */
function childrenLookup(exact: boolean): (pid: number) => Kid[] {
  if (!exact && childrenFiles) {
    return (pid) => {
      const out: Kid[] = [];
      let tasks: string[] = [];
      try {
        tasks = readdirSync(`/proc/${pid}/task`);
      } catch {
        // Gone since.
      }
      for (const task of tasks) {
        let list = '';
        try {
          list = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim();
        } catch {
          // That thread is gone; the others still count.
        }
        for (const c of list ? list.split(' ') : []) {
          const s = stat(Number(c));
          // The pid may be another process's by now: its own stat names its parent.
          if (s && s.ppid === pid) out.push({ pid: Number(c), s });
        }
      }
      return out;
    };
  }
  const map = new Map<number, Kid[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = stat(Number(name));
    if (!s) continue;
    const list = map.get(s.ppid);
    if (list) list.push({ pid: Number(name), s });
    else map.set(s.ppid, [{ pid: Number(name), s }]);
  }
  return (pid) => map.get(pid) ?? [];
}

/** Each of `roots` still running as noted, and every process under them, now (Linux). */
function tree(roots: Noted[], exact: boolean): Noted[] {
  const children = childrenLookup(exact);
  const out: Noted[] = [];
  const seen = new Set<number>();
  const visit = (p: Noted, s: Stat) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push(p);
    const cover = WRAPPER_COMMS.has(s.comm) ? { pid: p.pid, start: p.start } : p.cover;
    const kids = children(p.pid);
    // Gone and its pid reused before the children were read: they are another process's.
    if (!live(p)) return;
    for (const k of kids) visit({ pid: k.pid, start: k.s.start, cover }, k.s);
  };
  for (const r of roots) {
    const s = stat(r.pid);
    if (s?.start === r.start) visit(r, s);
  }
  return out;
}

/** `sig` to each of `procs` still running under the same pid and start time, read just before. */
export function signalLive(procs: Iterable<Proc>, sig: NodeJS.Signals): void {
  for (const p of procs) {
    if (!live(p)) continue;
    try {
      process.kill(p.pid, sig);
    } catch {
      // Gone since.
    }
  }
}

/** In its terminal's foreground group: a Ctrl-C there has reached the command already. */
function foreground(): boolean {
  if (!procfs) return isatty(0);
  const s = stat('self');
  return s !== null && s.tty !== 0 && s.tpgid === s.pgrp;
}

/**
 * Runs `command` in this process's group and exits this process with its code (a signal as 128+n).
 * In the caller's group, a kill of that group (an agent tool's timeout, `kill -- -pgid`) takes the
 * command too — a SIGKILL to this process alone cannot be passed on.
 *
 * SIGTERM, SIGHUP and SIGINT to this process go to the command's whole tree (Linux with /proc; else
 * to the command alone): the command alone may exit on it and leave its children running — holding
 * their slots. Below a live nested wrapper they go to that wrapper alone, which passes them on: one
 * delivery each. SIGINT is not passed on in the terminal's foreground group: Ctrl-C has reached every
 * process of it, and a second one is a forced exit with no cleanup to vitest and npm.
 *
 * The tree is noted every second, and every 100 ms from the first signal on (what a signal handler
 * forks is in it). If this process got a signal or the command died of one, what of the tree still
 * runs when the command exits gets SIGKILL: a cancel is total, a child left by a command that a
 * group's Ctrl-C ended first included. Each signal goes to a noted pid only under its start time,
 * read just before; a pid reused in between is left (no pidfd in Node; with `pid_max` in the
 * millions, a reuse within milliseconds is not a practical case). A command that exits on its own
 * leaves what it started running.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  // The kernel's name of this process, by which an outer wrapper knows it (`WRAPPER_COMMS`).
  process.title = `${name}: ${[command, ...args].join(' ')}`;
  const child = spawn(command, args, { stdio: 'inherit', env });
  let noted: Noted[] = [];
  let signalled = false;
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const note = (exact: boolean) => {
    const top = running() ? proc(child.pid!) : null;
    try {
      noted = tree([...(top ? [{ ...top, cover: null }] : []), ...noted], exact);
    } catch {
      // /proc unreadable now: what was noted stays.
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        note(signalled);
        schedule();
      },
      signalled ? 100 : 1000,
    ).unref();
  };
  if (procfs) schedule();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (!running()) return;
      const pass = sig !== 'SIGINT' || !foreground();
      if (!procfs) {
        if (pass) child.kill(sig);
        return;
      }
      signalled = true;
      note(true);
      schedule();
      if (pass) signalLive(noted.filter((p) => !p.cover || !live(p.cover)), sig);
    });
  }
  child.on('error', (err) => {
    process.stderr.write(`${name}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (procfs && (signalled || signal !== null)) {
      // The command is gone: from here its pid may be another process's, so only what was noted.
      note(true);
      signalLive(noted, 'SIGKILL');
    }
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
  });
}
