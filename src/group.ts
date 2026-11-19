import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { isatty } from 'node:tty';

/** A process as `/proc` names it: its pid and start time, so a pid reused since is not taken for it. */
export type Proc = { pid: number; start: string };

/** `covered`: under a live nested wrapper, which passes signals on to it itself. */
type Noted = Proc & { covered: boolean };

type Stat = { comm: string; ppid: number; pgrp: number; tty: number; tpgid: number; start: string };

// `/proc` of this process's pid namespace, or none: a chroot may have no /proc, a new pid namespace
// may see an ancestor's, whose pids are not the ones `kill()` takes here (even where its number for
// this process happens to be the same). NStgid lists this process's pid in the procfs's namespace and
// each one below it down to its own: one entry is its own namespace. Without it the command alone
// gets the signals, as on other systems.
const procfs = (() => {
  if (process.platform !== 'linux') return false;
  try {
    const ns = /^NStgid:\s*(.*)$/m.exec(readFileSync('/proc/self/status', 'utf8'));
    return readlinkSync('/proc/self') === String(process.pid) && ns !== null && ns[1]!.trim() === String(process.pid);
  } catch {
    return false;
  }
})();
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

// A `Z` state is no end: a leader that left by `pthread_exit` shows it while its other threads run.
const running = (s: Stat | null, start: string) => s !== null && s.start === start;
const live = (p: Proc) => running(stat(p.pid), p.start);

/** The process running under `pid` now (Linux). */
export function proc(pid: number): Proc | null {
  const s = stat(pid);
  return s && { pid, start: s.start };
}

// The kernel's name of a process is its title's first 15 bytes. These two, colon included, are what
// `runInGroup` makes of its title, and no program's file name.
const WRAPPER_COMMS = new Set(['cpu-slots-run: ', 'cpu-slots-node:']);

/**
 * Who a process's children may be. `exact`: from one read of every process's stat, for the walks
 * signals go by. Else `children` files: cheap, but the kernel may skip a child while a sibling exits
 * during the read.
 */
function childrenLookup(exact: boolean): (pid: number) => Proc[] {
  if (!exact && childrenFiles) {
    return (pid) => {
      const out: Proc[] = [];
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
          if (s) out.push({ pid: Number(c), start: s.start });
        }
      }
      return out;
    };
  }
  const map = new Map<number, Proc[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = stat(Number(name));
    if (!s) continue;
    const list = map.get(s.ppid);
    if (list) list.push({ pid: Number(name), start: s.start });
    else map.set(s.ppid, [{ pid: Number(name), start: s.start }]);
  }
  return (pid) => map.get(pid) ?? [];
}

/**
 * Each of `roots` still running as noted, and every process under them, now (Linux). The first root
 * is the command; any other reached as a root, not under it, has left it (its parent gone): no nested
 * wrapper is sure to know it, so it is not covered and this one passes signals on to it itself.
 */
function tree(roots: Noted[], exact: boolean): Noted[] {
  const children = childrenLookup(exact);
  const out: Noted[] = [];
  const seen = new Set<number>();
  const visit = (p: Noted, s: Stat) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push(p);
    const covered = p.covered || WRAPPER_COMMS.has(s.comm);
    for (const k of children(p.pid)) {
      // An edge counts only as it is now: the child, read again, is the one listed and names this
      // parent, and this parent is still the one noted (a pid reused under either breaks it).
      const c = stat(k.pid);
      if (c && running(c, k.start) && c.ppid === p.pid && live(p)) visit({ pid: k.pid, start: k.start, covered }, c);
    }
  };
  for (const r of roots) {
    const s = stat(r.pid);
    if (running(s, r.start)) visit({ ...r, covered: false }, s!);
  }
  return out;
}

/** `sig` to each of `procs` still running under the same pid and start time, read just before; the pids it went to. */
export function signalLive(procs: Iterable<Proc>, sig: NodeJS.Signals): number[] {
  const sent: number[] = [];
  for (const p of procs) {
    if (!live(p)) continue;
    try {
      process.kill(p.pid, sig);
      sent.push(p.pid);
    } catch {
      // Gone since.
    }
  }
  return sent;
}

// `CPU_SLOTS_TRACE=<file>`: a line per note of the tree and per signal passed on, for tests and for
// seeing what a wrapper did.
const traceFile = process.env['CPU_SLOTS_TRACE'];
function trace(line: string): void {
  if (!traceFile) return;
  let fd: number | undefined;
  try {
    // Non-blocking, and a regular file only: a FIFO with no reader, there at the start or put in its
    // place since, would block the wrapper mid-cancel.
    fd = openSync(traceFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NONBLOCK, 0o644);
    if (fstatSync(fd).isFile()) writeSync(fd, `${process.pid} ${line}\n`);
  } catch {
    // Tracing never stops the wrapper.
  } finally {
    if (fd !== undefined) closeSync(fd);
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
 * delivery each. A process that has left the tree (its parent gone) gets them from this wrapper
 * itself, and from a nested one that noted it too: twice, rather than none. SIGINT is not passed on
 * in the terminal's foreground group: Ctrl-C has reached every process of it, and a second one is a forced exit with no cleanup to vitest and npm.
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
  const commandRunning = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const note = (exact: boolean) => {
    const top = commandRunning() ? proc(child.pid!) : null;
    try {
      noted = tree([...(top ? [{ ...top, covered: false }] : []), ...noted], exact);
    } catch {
      // /proc unreadable now: what was noted stays.
    }
    trace(`noted ${noted.map((p) => p.pid).join(',')}`);
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
      const sent: number[] = [];
      if (commandRunning()) {
        const pass = sig !== 'SIGINT' || !foreground();
        if (procfs) {
          signalled = true;
          note(true);
          schedule();
          if (pass) sent.push(...signalLive(noted.filter((p) => !p.covered), sig));
        }
        // No /proc, or the command's stat unreadable (`hidepid`): the command itself all the same.
        if (pass && !sent.includes(child.pid!) && !noted.some((p) => p.pid === child.pid)) {
          // Not `child.kill`: a failure there (EPERM) is an `error` event, taken for a failed spawn.
          try {
            process.kill(child.pid!, sig);
            sent.push(child.pid!);
          } catch {
            // Gone or not ours to signal any more.
          }
        }
      }
      trace(`${sig} sent ${sent.join(',')}`);
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
